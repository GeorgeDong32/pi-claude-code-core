# CherryStudio 借鉴批次方案（Spec 草案 · 供审阅）

状态：**草案——未立项、未实现** · 来源：2026-10-20 对 CherryDev `src/main/ai/runtime/pi/`
（~9.2k 行 + pnpm patch 台账）的三路只读分析 · 待用户逐项裁决后按惯例走
spec 对抗 → 实现 → code-review 流程

---

## 0. 形态对照（为什么不能照抄，怎么等价吸收）

Cherry 是 **SDK 嵌入**（宿主拥有凭据/模型目录/审批 UI，pi 是被裁剪的引擎），
我们是**扩展包寄生**（活在 pi 本体 seam 里）。每个借鉴项都标注了「扩展形态
等价解」——同一问题在我们形态下的落点。codebase-design 判据贯穿全篇：
deep module = 小 interface + 深 implementation；每项先过**删除测试**
（删掉它，复杂度是集中回来还是原样搬走）。

---

## B1 · length 截断双判别 + 有界恢复（Strong ★★★★★）

**Cherry 实现**：`piLengthRecovery`（patch 形态，backport earendil-works/pi#7540）
——`usage.output < maxTokens` 判为上下文钳制（一次 compact-and-retry，守卫只在
成功响应时重置），`>= maxTokens` 判为配额限制（error 终态带指引文案）；重试
context 裁掉截断尾、历史保留。

**我们的现状（shallow 面）**：core 消费 `stopReason` 的地方分散
（modes 门禁信号、observation 投影、goal/review 记账），对 `length` 零区分
——653 重复 toolCall 事件里 `failToolCallsFromTruncatedMessage` 是 pi 本体防线，
我们没有任何「上下文压力 vs 配额问题」的判别，也没有「截断不得进 success
通道」守卫。

**设计（deep module 形态）**：

```
lib/truncation-verdict.ts                    ← 新 lib primitive（不变量 1：不 import extensions）
  interface: classifyLengthStop(stop: { stopReason, usage, model }): 
              "context-clamp" | "output-limit" | "not-length"
  + boundedRecoveryPolicy(verdict): { retryOnce: boolean; terminalError?: string }
```

- interface 两个函数 + 一个封闭返回枚举；implementation 承载判别式、
  maxTokens 解析（thinking 共享总闸的 `adjustMaxTokensForThinking` 语义）、
  指引文案。**删除测试**：删掉后每个 stopReason 消费点各自重写判别
  （复杂度分散回来）——值得存在。
- 消费点接法（扩展形态等价解）：modes/observation/记账在收口处调
  `classifyLengthStop`；`context-clamp` 视为压缩前兆信号（可联动用户
  「GLM 500K 即压」偏好），`output-limit` 保证 error 终态。
- **测试面**：仿 Cherry 的 streamFn 注入法，在 `test/contracts/`
  pi-host-semantics 旁加一条合成契约——对真实 pi 会话注入 length 截断
  序列，钉「截断不静默成功」。interface 即测试面，无需戳实现。

**依赖的 pi 上游事实**：stopReason=length 存在两种成因；pi 本体
failToolCallsFromTruncatedMessage 全量失败该消息 toolCall。

---

## B2 · 活 JSONL committed-prefix 读法（Strong ★★★★★）

**Cherry 实现**：`piFork.readForkPrefix`——O_NOFOLLOW + ≤512MB 上限 + 循环
读满 + 读后 inode/dev 复核（非符号链接、size 未缩）+ 只取最后完整换行前内容
+ **逐行 JSON.parse 重验**（「SDK 容忍坏尾行，宿主不容忍静默丢历史」）+
bytes 双读 TOCTOU 复核。

**我们的现状**：memory-queue drain（session_start 排水时 shutdown 可能仍在
写）、observation-pack originals 读取、review run 文件读取——都存在
「读到一半被 append」的撕裂窗口；各自手写 readFileSync，无共享 primitive。

**设计**：

```
lib/live-jsonl.ts
  interface: readCommittedLines(path, opts?: { maxBytes? }): 
             { lines: unknown[]; committedBytes: number }
  // throws LiveReadError（封闭枚举：vanished / symlink / shrunk / oversized /
  //                        torn-tail-dropped 计数而已，不 throw）
```

- 单一 authority + 各消费点换 adapter（三个消费点 = 真实 seam 的
  「两个以上 adapter」判据成立）。
- **删除测试**：删掉后三处各自重写防撕裂逻辑（复杂度 ×3 回来）——通过。
- 撕裂尾（半行）按 Cherry 语义**丢弃并计数**，不 throw——fail-open 边界。
- 测试面：注入并发 append 的合成文件，钉 inode 复核/半行丢弃/上限三行为。

---

## B3 · usage 锚点「合成前缀失效」规则（Worth exploring ★★★★☆）

**Cherry 实现**：`piCompactionBudget`（pi-ai patch）——`estimateContextTokens`
优先用最后一条合法 assistant 的 `usage.totalTokens` 做锚点，但**任何插入在
其后的消息（典型：压缩摘要）使锚点失效**（`timestamp >= latestPrefixTimestamp`
判据）；曾因压缩后旧 usage 残留把 maxTokens 钳到 1 → 「看似正常、实际空响应」
（#19447/#19457）。

**我们的现状**：`lib/context-budget.ts` 是固定字符预算（不算 usage）；但
**凡从 usage 推导 context 状态的路径**（cost 记账、OBS-09 节省 tokens 计数、
classifier 上下文信号）都没有这条判据。我们的 rules/memory 注入每请求重建
——恰好是「合成前缀」的生产者。

**设计**：不新立模块（YAGNI——我们还没有踩坑现场），先做两件事：
1. **判据落契约**：在 pi-host-semantics 契约套件补一条钉住 pi-ai 的
   estimate 锚点语义（上游改语义即红——升级信号，零生产代码）。
2. **记账路径审计记录**：DEVIATIONS 记「新增 usage 派生路径时必须声明锚点
   失效语义」——预防性规约而非实现。

---

## B4 · MCP 输入侧渐进披露（Worth exploring ★★★★☆ · 大项）

**Cherry 实现**：`piCodeMode.ts` 四工具面——`tool_search`（BM25 k1=1.2/b=0.75、
驼峰分词、返回 **TypeScript 声明**而非 JSON schema）/ `tool_describe` /
`tool_call` / `tool_exec`（worker_threads 而非 QuickJS，60s 超时）；schema
平时不进上下文，按需检索后才以紧凑声明进入。

**我们的现状**：observation-pack 覆盖**输出侧**投影；**输入侧**（工具声明
占上下文）没有对应经济面——mcp-gov 管 URL/形状治理不管体积。pi 本体已有
`codemode` 的 deferred exposure（MCP 默认 `codemode` 档 = 可脚本调不声明），
说明上游也在往这个方向走。

**设计方向（不展开接口——需先做数据侦察）**：MCP server 接入时工具声明
的 token 占用测量 → 若显著（≥1K token/server），在 mcp-gov 加
「declaration diet」：描述压缩 + 按需披露开关（复用 pi 的 exposure 五档，
不发明新机制）。**前置**：先跑一次真机各 server 声明体积盘点再定取舍。

**与 Cherry 的差异**：他们自建检索（无 pi codemode 信任）；我们直接用
pi 原生 exposure 档位即可——扩展形态的解更便宜。

---

## B5 · effort 写入期阶梯校验（Worth exploring ★★★★☆）

**Cherry 实现**：`modelInjection` 把模型 efforts 投影成 8 档
`thinkingLevelMap`（未声明标 `null`；toggle 模型不给全 null ladder；
`off`↔`none` 映射）——防 pi 盲发 `medium` 被 strict endpoint 拒（Kimi K3
#20029）。

**我们的等价解**：不能改 registerProvider（扩展形态），但 effort owner 链
（`lib/effort-owner.ts`，唯一 `setThinkingLevel` 调用点）在**写入前**做同一
件事：从 model registry 读实际 efforts 集，不可写档位钳到最近支持档 + 状态
行提示；`off` 恒合法（既有结论）。**Seam 位置**：effort-owner 内部，interface
不变（对外仍是单一写入 authority），depth 增加。

---

## B6-B8 · 预置性投资（Speculative ★★★☆☆ · 记录不实施）

| # | 项 | Cherry 机制 | 我们的落点（若做） | 暂缓理由 |
|---|---|---|---|---|
| B6 | willRetry 消毒 + 单 terminal 收敛 | auto-retry 中间 agent_end 先清 stopReason/error 再 hold open | goal/review 的 agent_end 记账加「willRetry 先清污」守卫 | pi 1.3.0 尚未对我们发 willRetry 事件——先在 pi-host-semantics 钉事件存在性，出现即升级 |
| B7 | steer 未投递回收 | 回合终点 splice + clearQueue + `steer-undelivered` re-queue | dynamic steer 注入契约补「宿主拥有 re-queue」 | 我们的 steer 走 sendMessage 路径，不走 steering queue——形态不同，先确认丢失窗口是否存在 |
| B8 | realpath 规范化 + 「convenience, not containment」口径 | realpath 防 symlink 逃逸、`file://` 歧义 fail-closed | modes auto/bypass allowlist 的 `scopeMatches` 升级 | 需先审计 scopeMatches 现状是否纯词法比较；口径文案（不向用户声称沙箱）可先落 docs |

---

## 附录 A · 上游事实速记（从 Cherry 代码考古所得）

| 事实 | 出处 | 对我们的意义 |
|---|---|---|
| `streamSimple` 同步签名；异步凭据须 `lazyStream` 工厂桥 | piTransportStream | 未来包 provider 层时的必踩坑配方 |
| pi steering 队列 turn 结束不 drain | PiRuntimeConnection | steer 语义边界 |
| pi `exports` 只有 `import` 条件（CJS 消费炸） | piSdk.ts | 我们保持 ESM-only；勿提供 CJS 出口 |
| session 文件名 `{timestamp}_{token}.jsonl`，token 合法含 `_`，按第一个 `_` 切 | piSessionFile | 扫 sessions 目录的解析纪律（我们有 `--X--` 双横杠同族坑） |
| 「id 有效但文件未 flush = 可初始化」 | resolveSessionManager | 懒落盘容忍语义 |
| pi-ai 被 dsh 复用为跨运行时 wire 协议库 | compositionBuilder | pi-ai 生态位在扩大——升级 pi-ai 的影响面超出 pi 本体 |
| `onPayload` 组合顺序：pi 先行、尊重 override、adapter 后写 | piTransportStream | payload 级改写（CPA forceAdaptiveThinking 类）的链式纪律 |

## 附录 B · 反向确认（我们已做对的，不动的）

- 单一 authority（effort-owner / mcp-shape / canonicalize）+ 纯数据快照 bus
  vs Cherry 的服务定位 + 三 driver 平行实现（两份手写 modelInjection）
- 契约套件对真实发布包常态化跑 vs 他们的 Phase 0 bundling spike（一次性）
- DEVIATIONS 单台账 vs 他们的「patch 带 PR 号待删」——精神一致，可互引
- 他们 `noExtensions: true` 的信任判词 = core 存在合法性前提——
  「无 timer / 无轮询 / 纯数据快照」纪律是护城河，任何批次不得破

---

*分析底档：三路 subagent 完整报告在
`~/.pi/agent/sessions/…/subagent-artifacts/{93bea373,abd73e15,8334570c}*_output.md`*
