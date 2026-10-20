# 批次一实施 Spec：B1 截断双判别 + B2 活 JSONL 读法 + B3 锚点契约钉

状态：spec 对抗审稿（flash，1 轮）· 上游方案：docs/{en,zh}/cherry-derived-hardening-spec.md
§B1/B2/B3 · 2026-10-20 · 侦察修正已并入（见 §0）

---

## 0. 侦察修正（与上游草案的三处偏差，以本 spec 为准）

1. **B1 消费点**：core 扩展层目前**零消费** turn_end 的 `message.stopReason`
   （grep 证实：仅 memory/llm.ts 与 classifier-client 消费 completion 级
   stopReason=error/aborted，均非 length）。B1 的接线落点是 **modes 的
   turn_end handler 新增 stopReason 消费**——「截断不静默成功」在扩展层的
   形态 = length 终态发 bus 通知（用户可见警告），而非记账改造。
2. **B2 消费点收缩**：草案假设的三个消费点经核实两个不成立——
   memory-queue 写入走 tmp+rename 原子替换（queue.ts:224-225，读侧无撕裂
   窗口，不接）；observation-pack objects 是 content-addressed 写后不变
   （不接）。**真实消费点**：goal-ledger.ts:122（append-only JSONL 活读，多 pi 进程
   同项目并发时跨进程撕裂窗口真实存在）。review-run 读取复audit：
   extensions/review 全目录 `.jsonl` 零命中——:309 读未跟踪源文件（任意
   格式）、:445 是 utf-8 整读、review-report readManifest 是单 JSON
   parse——都不适配逐行 JSON adapter，均不接。
3. **B3 前提已变**：pi-ai 0.99+ 已含锚点时间戳判据（estimate.js:54-70
   `latestPrefixTimestamp`——Cherry 所 backport 的上游 8973ae2 修复已在我们
   的依赖版本里）。B3 从「补判据」变为「**钉现状防回归**」。

---

## B1 · lib/truncation-verdict.ts + turn_end 接线

### Primitive（不变量 1：不 import extensions）

```ts
export type LengthStopVerdict = "context-clamp" | "output-limit" | "not-length";

export function classifyLengthStop(input: {
  stopReason: string | undefined;
  usage?: { output?: number } | undefined;
  modelMaxOutputTokens?: number | undefined;
}): LengthStopVerdict;

export function boundedRecoveryPolicy(v: LengthStopVerdict): {
  userNotice: string | null;   // bus 通知文案；not-length → null
  isQuota: boolean;            // output-limit: true（建议用户调配置）
};
```

- 判别式（Cherry patch 同源）：`stopReason !== "length"` → not-length；
  `modelMaxOutputTokens` 已知且 `usage.output >= modelMaxOutputTokens` →
  output-limit（配额/配置）；否则 → context-clamp（上下文钳制）。
- `modelMaxOutputTokens` 未知时（扩展层拿不到 model 对象的场景）保守判
  context-clamp——「有通知」优于「无通知」，误判后果只是文案差异。
- interface 恰两函数 + 封闭枚举；删除测试：删掉后每个 stopReason 消费点
  各自重写判别与文案——复杂度分散回来，通过。

### 接线（modes/index.ts turn_end）

- turn_end handler 在 stats 段后新增：`classifyLengthStop({ stopReason:
  event.message.stopReason, usage: event.message.usage, modelMaxOutputTokens: ctx.model?.maxTokens（直连缝；先用
  isAssistant(event.message) 收窄——TurnEndEvent.message 是联合类型） })`。
- verdict ≠ not-length 时 `publishCapability` 一次性通知（走 bus 通知队列
  sharedNotify 同款路径）：context-clamp → 「响应被上下文压缩截断——考虑
  /compact 或减小任务粒度（若回复异常地短，先查 maxTokens）」；output-limit → 「响应达到输出上限——考虑
  调高 maxTokens 或继续该轮」。
- **同 turn 去重**：每个 turn_end 至多一条（天然一次）；连续 length turn
  每条都通知（用户应看见每次截断，不做冷却——通知队列 cap 20 兜底）。

### 契约测试（test/contracts/ 旁，B1-C）

- **行为钉**（非导出探测——该符号是未导出的 bundle 内部实现）：以真实
  SessionManager 驱动截断消息序列（pi-host-semantics spawn 法），断言
  截断消息的 toolCall 全部失败（failToolCallsFromTruncatedMessage 生效）；
  加扩展侧不产生 success 形态终态（通知发出）。
- **先按不变量 6 登记** test/contracts/README.md 表（契约 → spec ID →
  消费方 → 移除条件）再写测试。若行为钉对真实包不可行，按 P0-CT-13 走
  `test.todo`+Phase——不写伪导出探测。

---

## B2 · lib/live-jsonl.ts + goal-ledger/review-run 接线

### Primitive

```ts
export interface CommittedLines {
  lines: unknown[];          // 已 JSON.parse 重验的完整行
  committedBytes: number;    // 最后一个完整换行前的字节数
  tornTailBytes: number;     // 丢弃的半行字节数（计数不 throw）
}
export type LiveReadError =
  | { kind: "vanished" } | { kind: "symlink" }
  | { kind: "shrunk" } | { kind: "oversized" }
  | { kind: "unstable" };

export function readCommittedLines(path: string, opts?: { maxBytes?: number }): CommittedLines;  // throws LiveReadError
```

- 读法（与 Cherry readForkPrefix 同构、**含 bytes 双读**，Node 形态）：
  `openSync(path, O_RDONLY | O_NOFOLLOW)`——errno **ELOOP**（macOS 与
  Linux 一致）映射 `{kind:"symlink"}` → fstat（isFile、size ≤ maxBytes
  默认 8MB）→ 循环 read 至 EOF → **读后 fstat 复核**（dev/ino 一致；
  超过 committedBytes 的增长可容忍——保证语义是「读取时刻的完整
  committed 前缀」；缩小 = shrunk）→ **bytes 双读 TOCTOU 复核**：对前
  committedBytes 二次全量读，必须逐字节一致（同 inode truncate+重写更长
  对 fstat 不可见）；不一致重读一次，仍不一致 throw `{kind:"unstable"}`
  → 截到最后完整 `\n` → 逐行 JSON.parse（坏行**跳过并计入 badLines**，
  不 throw——goal 台账历史可能有手工编辑残留；「上游容忍的我们计数，
  不静默丢」）。
- 撕裂尾丢弃计数（fail-open，goal 约束）；符号链接 = symlink 错误
  （fail-closed——路径注入面）。

### 接线

| 消费点 | 接法 | 理由 |
|---|---|---|
| `goal-ledger.ts` 读路径（:122） | readFileSync+parse → readCommittedLines | 多 pi 进程同项目并发 = 真实跨进程撕裂窗口。现行已是逐行 parse + `malformed` 计数（无整读失败路径）——真实增量是撕裂尾计数与 shrunk/oversized/symlink/unstable 守卫 |
| memory-queue / observation objects | **不接**（tmp+rename 原子 / 写后不变） | 无窗口，接了是假动作 |

- ledger 的 mtime cache 语义不变（invalidation 已有）；adapter 只换读取
  内核，缓存/append 路径零改动。**消费点错误映射钉住**：一切
  LiveReadError → 空结果 + `ledgerReadCache.delete(path)`（ledger 读路径
  永不 throw——fail-open 保持）。

### 测试（test/lib/live-jsonl.test.ts）

合成文件钉：正常读 / 撕裂尾（半行丢弃计数）/ 并发 append（增长容忍、
旧前缀完整）/ shrunk（throw）/ symlink（throw）/ 超上限（throw）/ 坏行
跳过计数 / O_NOFOLLOW 生效。goal-ledger 侧补一条并发写读 e2e（fake
append 竞争下读得完整前缀）。

---

## B3 · estimate 锚点契约钉 + 台账规约

- **契约**（pi-host-semantics 套件新增，先按不变量 6 登记
  test/contracts/README.md 表）：直 import
  `@earendil-works/pi-ai` 的 `estimateContextTokens`。注意判据方向：
  `latestPrefixTimestamp` 是 index i **之前**消息的运行最大值——锚点
  失效的条件是「更新时间戳的消息在数组序上排在 usage assistant
  **前面**」（压缩场景）。用真实 ms 值与**完整 Usage 对象**（AssistantMessage
  的 usage 必填，缺失会让 estimator 崩溃）：
  ① `[user 摘要(ts=2000), assistant(usage.full=9500, ts=1000)]` →
  断言 `lastUsageIndex === null`（合成前缀使旧锚点失效）；
  ② 追加 `assistant(usage.full, ts=3000)` → 断言锚点指向它（恢复）。
  钉住 `latestPrefixTimestamp` 判据现状——上游语义漂移即红（升级信号）。
- **规约**：DEVIATIONS 记「core 新增任何 usage 派生路径（cost 记账 /
  OBS-09 节省计数 / classifier 上下文信号）必须在实现注释声明锚点失效
  语义（合成前缀使旧 usage 失效）」——预防性，不新增运行时代码。

---

## 测试矩阵汇总

| # | 用例 | 断言 |
|---|---|---|
| B1-1 | classifyLengthStop 表驱动（length+超限/恰等上限/未超限/未知上限/非 length） | 五分支封闭枚举（>= 语义在边界钉住） |
| B1-2 | boundedRecoveryPolicy | not-length → userNotice null；两 length 分支文案含指引 |
| B1-3 | FakePi turn_end stopReason=length | bus 通知恰一条、文案按 verdict |
| B1-4 | turn_end stopReason=normal | 零通知 |
| B1-C | 契约（或降级单测+存在性钉） | 截断不静默成功 |
| B2-1..9 | live-jsonl：正常/撕裂尾/并发 append/shrunk/symlink（ELOOP 映射）/超上限/坏行跳过/**vanished（ENOENT → LiveReadError throw；消费方映射空结果）**/unstable（双读不一致） | 见 §B2 测试 |
| B2-9 | goal-ledger 活读用例（撕裂尾/坏行/vanished/symlink；真并发窗口是跨进程的——与 B2-4/B2-9b 同款诚实注释） | 空或前缀，永不 throw |
| B3-C | estimate 锚点两态 | lastUsageIndex 失效/恢复 |

## 门槛与流程

三门禁 exit 0（contracts 基线 46+3todo → 新增登记后同步涨）；台账
DEVIATIONS/CHANGELOG 中文；双语 docs 同步；提交推送（SSH）；双机部署
副本同步（scripts/sync-deploy-copies.sh）。审查轮数：spec ≤1、code ≤2。
