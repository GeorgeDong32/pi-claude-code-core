# Memory 召回频率调参（B）— Spec

状态：对抗审查稿（flash，1 轮）· 批次：2026-10-20 ·
模块：`extensions/memory/recall.ts`、`extensions/memory/index.ts`

## 1. 背景（session 语料，2026-10-20）

- 投递频率：平均 **每 2.72 个 user turn 一块**（core 项目 2.56 / home
  2.98）；最差短会话 **1:1**（6 turn → 6 块）；多个 3–4 turn 短会话在
  1.3–1.5。
- 每块成本：selector **p50 3.0 s** + 注入 **~4 KB**（p50 3951 B，p90
  7421 B）。
- 决定修法形状的健康事实：immediate 命中率仅 3.3%；投递块距触发中位
  **5 turn**。「晚几轮才想起」本就是常态，砍频率的边际损失很小。
- 去重窗口工作正常（活窗口期 0 同 key 泄漏）——问题在**零门槛触发**：
  每条 user 消息都跑 selector。

## 2. 设计

在 recall machine 入口（`createRecall(...).onUserMessage`）加两个阈值，
每次判定时从 env 读取（`PI_CORE_RECALL_WARMUP_TURNS` /
`PI_CORE_RECALL_COOLDOWN_TURNS`；**≤ 0 禁用门**，非数字回落默认值）——
与 `CC_CORE_BG_PROMOTE_MS` 同款测试 seam：

```ts
export const RECALL_WARMUP_TURNS = 3;   // 前 N 个 user turn：不跑 selector
export const RECALL_COOLDOWN_TURNS = 2; // 两次 selector 运行的最小间隔 turn
```

machine 内状态：

```ts
let userTurns = deps.initialUserTurns;  // 种子值（见下 resume）
let turnsSinceRun = Infinity;           // 未跑 selector 的 turn 递增；
                                        // 跑了归 0；≥ 冷却阈值即具备资格
```

`onUserMessage` 顺序（在任何 hygiene/去重工作之前——早跳过、便宜地
跳过）。统一计数规则（审查 R1 P1-1/P1-2）：**未实际运行 selector 的
turn 一律 `turnsSinceRun += 1`；运行的 turn 归 0。**

1. `userTurns += 1`
2. 若 `userTurns <= RECALL_WARMUP_TURNS` → `turnsSinceRun += 1`；return
   null，`stats.lastReason = "warmup"`。
3. 若 `turnsSinceRun < RECALL_COOLDOWN_TURNS` → `turnsSinceRun += 1`；
   return null，`stats.lastReason = "cooldown"`。
4. 否则走既有流水线。selector **实际运行**（单一判定点 = 构造
   selection promise 处）→ `turnsSinceRun = 0`。流水线因其他原因早退
   （query null / bytes 超限 / eligible() 空）→ `turnsSinceRun += 1` ——
   被抑制的 turn 不重置冷却、也不拖累下一 turn（下一 turn 仍具备
   资格）。

**resume 连续性**：machine 按 session 生命周期重建，裸计数器会归零、让
续聊会话饿 3 turn 的 memory。改为种子值（审查 R1 P2-3——让它精确的
时序事实）：`ensureRecallMachine` 传 `initialUserTurns` = 创建 machine 时
`ctx.sessionManager` 分支里 **role === "user" 的消息数**。
`before_agent_start` 在 in-flight user 消息构造与持久化**之前**触发
（agent-session.js：emitBeforeAgentStart 先于 message_end 的
appendMessage），所以 branch 计数永不含正在处理的消息——无 off-by-one。
实现必须从 sessionManager branch 取数，不得读 `agent.state.messages`
（后者已含 in-flight 消息）。历史 ≥3 条 user 消息的 resume 会话立即具备资格；
计数语义是「本会话的 user turn 数」而非「本进程启动以来的 turn 数」。
压缩后续接的会话继续累计（压缩边界不重置 user turn 计数）。

## 3. 阈值依据与预期效果

- **首免 3**：最短的会话（≤4 turn，1:1 案例）是任务进出型——开场上下文
  全新；那里投递的块既难命中（immediate 3.3%）又贵（各 3 s）。首免 3
  消灭频率最差的四分位，长会话不受影响。
- **冷却 2**：合法召回本就需要几轮「追上」（落点中位 5 turn）。冷却 2
  把长会话的稳态 selector 负载砍半（1.8–2.7 turn/块 → ~3–4 turn/块，
  以冷却为上界）。
- 合并预期：全语料 selector 运行减少 ≥50%；运行发生时块内容零变化
  （同 selector、同预算）。
- 阈值刻意保守：用户方向是「频率偏高」，不是「隔几屏才许召回一次」。

## 4. 可观测性

- `stats.lastReason` 新增 `"warmup"` / `"cooldown"`——经既有
  `RecallStats` 与诊断路径浮出（不动 details v1 schema；P0-CT-08 冻结面
  不碰）。
- `scripts/recall-aggregate.mjs` 无需改动即可继续工作：块自然变稀疏；
  landing-position 节不受影响。

## 5. 测试矩阵（vitest，`test/lib/`）

| # | 用例 | 断言 |
|---|---|---|
| 1 | 新会话前 3 turn | selector 零调用；lastReason "warmup" |
| 2 | 第 4 turn | selector 运行（首免已过） |
| 3 | 第 4 turn 跑；第 5–6 turn | 均跳过 "cooldown"（计数 1、2）；第 7 turn 具备资格（间隔 = 冷却 + 1 = 3） |
| 4 | 种子 initialUserTurns=7（resume） | 第 1 turn 立即跑 selector |
| 5 | 种子=2（短 resume） | 第 1 turn 是首免第 3 turn；第 2 turn 运行 |
| 6 | 具备资格的 turn N 流水线早退（eligible() 空） | 计数 +1（不重置）；turn N+1 仍具备资格并运行 |
| 7 | warmup 期间 abort() | 计数保留（abort 清请求态，不清 turn 计数） |
| 8 | aggregate 脚本对稀疏投递形状的合成 jsonl 冒烟（门不碰 details v1——落盘的只有更少块与更大间隔） | 可解析；输出形状不变（test/lib/recall-aggregate-smoke.test.ts） |
| 9 | steer 路径（waitMs=0）共用 machine | warmup/cooldown 计数与常规路径共享——冷却期 steer 仍跳过 |
| 10 | 会话中途重建 machine（settings 变更） | 首免种子从 branch 重导出（不重放首免）；冷却时钟重启——重建罕见且重建后首 turn 立即具备资格 |

## 6. 非目标

- 不做 evaluation set / 质量评分（另案决策）。
- 不改选择内容、预算、投递机制。
- 不做跨轮重复检测（不同问题域）。
