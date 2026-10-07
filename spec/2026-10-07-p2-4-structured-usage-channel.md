# SPEC P2-4：modes 通道发布结构化用量（数字上 bus，格式化归 adapter）

状态：规格已补齐，待实施
日期：2026-10-07
分支：main
来源：2026-10-07 联合架构审查，报告 X3 卡片；清单项 CORE-11
配对：pi-claude-code-tui `spec/2026-10-07-p1-2-usage-single-display.md`（消费方）

## 1. 背景

- modes 在业务层把用量格式化成字符串再发布（`extensions/modes/index.ts:804-818`）：
  - 格式：`↑in ↓out [R cacheRead] [⚡tps tok/s] $cost.toFixed(3) [pct% ctx]`；
  - 发布位置：`modes.workingStats`（`824-840`），并派生到 legacy `__pmWorkingStats`（`bus.ts:146-149`）。
- cctui 收到的只有字符串。它另行扫描 branch（`UsageTracker`，cctui `status-snapshot.ts:42-71`），用自己的口径算 cost 与 ctx%，于是同一行出现两份不一致的数字：
  - 精度不同：`formatCost` 为 2 位或 4 位，core 为 `toFixed(3)`；
  - ctx 口径不同：cctui 用 `used / contextWindow`，core 用 host 的 `getContextUsage().percent`。
- 数据本来就在：`workingStats.snapshot(statsHost(ctx))` 一次调用同时返回 `stats { input, output, cacheRead, cacheWrite, cost }` 与 `usage { tokens, percent, contextWindow }`（`working-stats.ts`，AR1005-ST）。

## 2. 决策登记

| # | 决策 | 候选方案 | 选择 | 放弃了什么 | 风险与承担 |
|---|---|---|---|---|---|
| U1 | 发布形状 | A 只发数字、删除字符串；B **新增可选 `modes.usage`，字符串保留** | **B** | A 更干净，但会破坏 legacy 消费方（P0-CT-01 / 02） | 两份表示需同批次发布，由同一次 snapshot 推导 |
| U2 | 字段集 | A 只发 cost 与 ctx%；B **完整字段**：`input / output / cacheRead / cacheWrite / cost / tps? / ctxTokens? / ctxPercent? / contextWindow?` | **B** | — | 无 |
| U3 | 发布频率 | A 单独节流；B **与 `workingStats` 同一次 publish**（沿用 AR1005-ST 的缓存与失效表） | **B** | — | 无新增宿主读取 |

## 3. 目标与非目标

**目标**
- `CoreSnapshot.modes.usage` 携带原始数字，与 `workingStats` 字符串出自同一次 snapshot。
- 登记契约 XPKG-08。

**非目标**
- 不改字符串格式与 legacy key。
- 不改 working-stats 的缓存键与失效表（AR1005-ST）。
- 不改 core fallback adapter 的显示（它继续显示字符串）。

## 4. 设计

1. `workingStatsParts` 拆成两步：`workingStatsEntry(ctx)` 返回 `{ stats, usage, tps }`；字符串格式化逻辑不变。
2. `refreshWorkingMessage`（`842-851`）在同一次 `publishCapability` 中写入 `workingStats` 与 `usage`；扩展内部 PmCapability patch 的类型和转发字段，不能只改声明。bus 对 modes 只浅合并，所有 mode-only 发布必须保留最新 usage；session_start / shutdown 明确清除旧会话 usage，不能用 `?? prev.usage` 阻止清空。
3. `types/index.d.mts`：`CoreSnapshot.modes.usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number; tps?: number; ctxTokens?: number; ctxPercent?: number; contextWindow?: number }`。
4. 契约表新增：

| 契约 | spec ID | 消费方 | 移除条件 |
|---|---|---|---|
| `modes.usage` 原始数字，与 `workingStats` 同批次发布 | XPKG-08 | cctui 状态行 | 无 |

### 4.1 数字语义与生命周期

- input/output/cacheRead/cacheWrite 为 working-stats 的累计口径（token 数）；cost 是同一累计 USD 数字。不是 goal 用量，也不新增 subagent 汇总口径。
- tps 只有本次速率有效且 >0 才给；ctxTokens/ctxPercent/contextWindow 来源于同一次宿主 usage，可独立缺失；unknown 不伪装成 0，真实 0 必须保留。
- 只发布 finite 非负数字；异常字段省略，必填累计字段缺失时整个 usage 暂缺，不发布 NaN/Infinity。ctxPercent 保留宿主原值，显示端自行格式化。
- 消费方按字段回退到自身 UsageTracker，不能因 usage 对象存在就把缺失的 ctxPercent 当作 0。新会话首次有效采样前缺失，旧会话数字不可跨 session 残留。
- 保持 hasUI 守卫、AR1005-ST 缓存与失效点，不为新增字段多做一次 getBranch/getContextUsage。view 端轮询不驱动采样。

## 5. 测试

| # | 用例 |
|---|---|
| U-T1 | `bus-types.test.ts` 孪生守卫：真实 publish 的 `modes.usage` 形状与类型一致 |
| U-T2 | 同一快照中，`usage` 的数字经现有格式化得到相同字符串（只验证单向，舍入后的字符串不能反推原数字） |
| U-T3 | AR1005-ST 的"预热后 200 次 message_update 零宿主读取"零改动通过 |
| U-T4 | legacy `__pmWorkingStats` 字符串零变化 |
| U-T5 | mode-only publish 不丢 usage；session 切换/shutdown 清空，第一条新采样不带旧值 |
| U-T6 | 0、部分 ctx 字段缺失、非 finite 输入、无 UI；XPKG-08 先登记后在 contracts 钉住发布字段与可选语义 |

## 6. 门禁、回滚、台账

- 三绿；单 commit；可单独 revert（字段可选，cctui 侧有回退）。
- `docs/{en,zh}/bus.md` 形状表补 `modes.usage`；`CHANGELOG.md`；`PROGRESS.md`。
