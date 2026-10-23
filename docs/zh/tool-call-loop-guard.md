# 工具调用循环防线（D1 / D1b）+ bash timeout 文案（D2）— Spec

状态：对抗审查稿（flash，1 轮）· 批次：provider 输出防线 2026-10-20 ·
模块：`extensions/modes/loop-guard.ts`（新）、`extensions/modes/index.ts`、`extensions/bg-shell/index.ts`

## 1. 背景

事件（session `01a10ca2-dd4f`，2026-10-05）：单条 assistant 消息携带 **755 个
并行 toolCall**，其中 **653 个逐字节相同**（`pnpm run contracts 2>&1 | tail
-30`）。后果：1,089 次「response hit the output token limit」未执行、675 次
429 五小时限额中断、14.2 MB session 文件、占扫描语料全部工具失败的 67%。
根因：provider 在 output token 上限附近的退化输出（GLM/CPA 复读同一
toolCall 填充预算）。

范围说明（审查 R1 P2-1）：pi 对 `stopReason === "length"` 的消息已有
全量失败防线（`failToolCallsFromTruncatedMessage`，agent-loop.js:
160-165）——所引事件里 1,089 次未执行正是该防线的产物，被截断消息的
755 个调用本就不会执行。D1 的真实价值在**预算内非截断的退化批**：
一条正常完结却携带重复调用的消息（语料还有 8 条消息的跨轮同命令
连击，且 provider 可能在不触长度上限时退化）。

pi 与 Claude Code 都没有任何跨调用查重（CC 审计 2026-10-20：唯一相关防线
是 Anthropic API 对重复 tool_use **ID** 的 400；不同 ID + 逐字节相同内容的
重复在任何一侧都会照常执行）。第二个暴露面：`codemode` 脚本卡死循环时会
逐字节重复嵌套调用——它们按设计绕过任何消息级去重。

## 2. 非目标

- **跨轮重复**是合法的（轮询、重试）——永不拦截。
- **单响应 toolCall 数量上限**——agent loop 层，pi 本体；只记上游建议。
- **codemode 沙箱默认超时**（`timeout_ms` 默认 unset，纯 JS `while(true){}`
  没有任何 tool_call 事件可拦，CPU 无限烧）——上游建议，本批不实现。
- CC 对标：CC 无实现可镜像；这是原创防线，无行为参照。

## 3. D1 — 消息级重复抑制

**事实基座**：pi 的 agent loop 先完结整条 assistant 消息（`message_end`
携带完整消息，含每个 toolCall part 与 id），*然后*才逐个把 toolCall 派发
过扩展 `tool_call` 门（`agent-session.js`：`beforeToolCall` 在消息完成后
运行）。同批身份因此是精确可知的。

**设计**：新模块 `extensions/modes/loop-guard.ts`。

```ts
export interface BatchDupIndex {          // 仅 message_end(assistant) 时构建
  byId: Map<string, { key: string; isDupFollow: boolean }>;
}
// 仅 role === "assistant" 的消息——message_end 对 user/toolResult/custom
// 消息也触发；今天索引它们无害（steer/custom/bash 消息排队到批间
// drain），但该过滤是承载性的、须显式。
export function indexBatchDupes(message: { role: string; content: readonly unknown[] }): BatchDupIndex | null;
export function checkBatchDup(index: BatchDupIndex | undefined, toolCallId: string): string | undefined;
// toolCallId 是重复跟随者时返回 block reason，否则 undefined
```

- `key = toolName + "\0" + stableStringify(input)`；JSON.stringify 排序
  object key（只匹配逐字节相同输入——事件证明是精确重复；近似重复不在
  范围）。
- **首个放行，跟随者拦**——"首个"由 message.content **parts 顺序**固定
  （pi 在串行与并行两条路径都按 parts 顺序串行派发 gate，
  agent-loop.js:366-420），与首个事后是否被其他防线拦截无关——被拦
  首个的跟随者仍是重复、仍被拦（事件形态是 provider 噪音，非意图）。
- **位置：tool_call handler 的第一步**，在
  `createPermissionAdjudicator().check()` 之前——这是防线不是权限：
  **bypass 模式不豁免**（与 memory G1 guard 同哲学）。
- **fail-open**：`toolCallId` 不在索引中（旧版 pi 事件顺序不同、意外
  形状）→ 放行。防线永远不能成为合法调用被拦的原因。
- **嵌套豁免是结构性的**：带 `parentToolCallId` 的调用（codemode
  `executeTool`）不出现在 message parts 里，天然 miss 索引 → 放行。无需
  特判。
- 索引生命周期：REPLACE-ONLY——handler 保留最后一条 **assistant** 批索
  引，仅在新的 assistant `message_end` 到达时替换。非 assistant 的
  message_end（sequential 分发批内 gate 调用之间的 toolResult；parallel
  批间排队的 steer/custom/bash 消息）永不清除持有索引——sequential 路
  径会在批内调用之间发射 toolResult message_end，朴素的「替换为 null」
  会让 D1 对每个 sequential 批失效（审查 R1 P1-1）。toolCallId 每响应唯
  一；持有最后一条索引不会误拦新调用。

**Block reason**（必须引导自愈，展示给模型）：

```
This call is a byte-identical duplicate of call <firstId> in the same
response — the first copy has already been processed (executed or
blocked). Repeating it in one batch has no effect; if you need to run it
again, do so in your next turn with a fresh call.
```

## 4. D1b — parent 级熔断

codemode 嵌套调用逐个过门（已证实事实），因此门能看到 per-parent 调用
序列。

```ts
export function createParentLoopBreaker(maxIdentical = 20, maxParents = 256, maxKeysPerParent = 64) {
  // Map<parentToolCallId, Map<key, count>>；parents 超 maxParents FIFO 淘汰；
  // parent 超 maxKeysPerParent 后不再收纳新 key（新 key 放行不记录——
  // 卡死循环只用少数 key，检测不受影响）。
  check(parentToolCallId: string, key: string): string | undefined;
}
```

- **maxIdentical 20**（第 21 个逐字节相同调用被拦；前 20 个放行）：脚本
  内合法重试是个位数（网络抖动——阈值可调，精确分布无语料佐证）；批量
  工作参数必然不同（同参数 × 20 没有有用语义——对副作用工具，拦住反而
  是特性）。已知可能触碰上限的唯一合法形态——脚本内长同参轮询——本仓
  惯例已由「外部等待走 bg-shell 后台任务」承接，不该用脚本内循环。
- Block reason 指导脚本作者（模型）："the codemode script has issued N
  identical calls through this tool — vary the arguments or break the
  loop; further identical calls are blocked."
- 内存上界：`maxParents` 256 + FIFO 淘汰（插入序）；防线数据不珍贵——
  淘汰无害。
- parent 结束不清理：闲置 parent 只占一个 Map 条目直到被淘汰。

## 5. D2 — bash schema timeout 文案

`extensions/bg-shell/index.ts` bash 工具 schema 的 `timeout` 参数
description 增加：

> Optional timeout in seconds. Omitted = the command auto-backgrounds
> after ${PROMOTE_MS / 1000} s and keeps running (you are notified on
> completion; commands starting with `sleep` are exempt). An explicit
> timeout hard-caps the run instead — use it only when a stale command
> is worse than a killed one.

（纯文案，无行为变化。）

## 6. 测试矩阵（FakePi / node:test，`extensions/modes/`）

| # | 用例 | 断言 |
|---|---|---|
| 1 | 同批：一条 assistant 消息 3 个相同 bash 调用 | #1 放行；#2 #3 被拦且 reason 含重复字样 |
| 2 | 同批：2 个相同 + 1 个不同参数 | 仅跟随者被拦 |
| 3 | 跨轮：下一轮同工具+同参数 | 放行（索引已换新） |
| 4 | 嵌套：同 parent 25 个逐字节相同 `executeTool` 调用 | 前 20 放行；第 21+ 被拦且 reason 含 loop 字样（maxIdentical = 放行数） |
| 5 | 嵌套：20 个相同 | 全放行；第 21 个会被拦（阈值边界：maxIdentical = 放行数） |
| 6 | 嵌套：不同参数 × 30 同 parent | 全放行（key 不同） |
| 7 | fail-open：未知 toolCallId | 放行 |
| 8 | bypass 模式 + 同批重复 | 仍被拦（防线 ≠ 权限） |
| 9 | 两个不同 parent 各 10 个相同 | 全放行（计数独立） |
| 10 | reason 文案断言子串 "byte-identical duplicate" / "codemode script" | 自愈引导措辞在场 |
| 11 | stopReason="length" 消息带重复 parts（互操作） | pi 截断防线全量失败它们；loop-guard 保持安静（无双重 reason），toolCall/toolResult 配对不破 |
| 12 | 重复对的首个被 plan gate 拦、跟随者到达 | 跟随者仍被拦且 reason 含重复字样（"already been processed"） |

## 7. 上游建议（记入 DEVIATIONS，不实施）

1. codemode 沙箱：默认 `timeout_ms`（如 300 s），除非脚本显式退出——
   堵上纯 JS 死循环这个门看不到的洞。
2. agent loop：单响应 toolCall 数量上限（如 50 + 提示）——在拥有消息
   形状的那一层做纵深防御。
