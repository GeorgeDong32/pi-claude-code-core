# SPEC P2-1：permission 裁决 deep module（纯裁决 + 一次解释）

状态：规格已补齐；待 P0-1 落地后实施

> **实施记录（2026-10-07）**：**未实施（0/3 步）**。前置 P0-1 已落地且为迁移铺好了第一步（evaluateToolPermission 纯函数 + plan-gate.ts + applyPermissionVerdict 三步结构），但本批会话预算不足以安全完成 3 步迁移 + 对拍 harness + decision table + FakePi 用例删减清单的完整闭环；作为零行为变化的纯架构重构，有序推迟优于半成品。Step 1 起步条件已具备，另批实施时从 §4.3 Step 1 开始。
日期：2026-10-07
分支：main
来源：2026-10-07 联合架构审查，报告 C1 卡片；清单项 CORE-12（吸收 CORE-18 classifier 时钟注入）

## 1. 背景

`extensions/modes/index.ts` 有 2218 行，tool_call gate（`1426-1710`）把"判断"与"副作用"交织在一个 285 行的闭包里：

- 判断：bypass、规则、family、嵌入命令、plan、auto tiers、ask。
- 副作用：弹窗、子代理转发、classifier、写规则、切 bypass、compliance 注入、outside-write 追踪、family 裁决记录。

它依赖的闭包状态包括 `currentMode`、`mergedPermissionRules`、`autoModeConfig`、`classifierConfig`、`classifierDenialState`、`pendingComplianceInject`、`complianceCategory`（`index.ts:161-185`）。

后果：
- P0-1 修复的两个 bug 都源于"规则层先执行副作用、上层再解读文本"。
- gate 只能通过 FakePi 整体测试：`index.test.ts` 有 2893 行，`createFakePi` 需要桩约 25 个成员。
- AR1005 R3 记录的 flaky 测试（`index.test.ts:1149` "classifier retry loop is bounded"）用真实 40ms 计时器断言耗时，是结构性问题：时间没有注入（`classifier-client.ts:716, 730`）。

## 2. 决策登记

| # | 决策 | 候选方案 | 选择 | 放弃了什么 | 风险与承担 |
|---|---|---|---|---|---|
| A1 | seam 位置 | A 只把 auto tiers 抽出；B **整个 gate 拆成 `adjudicate`（纯）+ `interpret`（副作用）**；C 每个 mode 一个 handler 类 | **B** | A 的小改动；C 的"按 mode 分文件"直观性（mode 之间共享规则 / family 步骤，C 会复制这些步骤） | 迁移面大，用 §4.3 的对拍兜底 |
| A2 | 输出形状 | A 回调式（adjudicate 接收 prompt / classify 回调）；B **判别联合 `Decision`** | **B** | A 写起来更接近现状 | B 必须覆盖全部副作用种类，否则会泄漏回 handler |
| A3 | 迁移方式 | A 一次性替换；B **分 3 步，每步新旧对拍** | **B** | A 的速度 | 对拍矩阵需要维护到迁移结束 |
| A4 | classifier 重试 | A 留在 interpreter；B **抽成 `classifier-retry.ts`，注入 clock / signal** | **B** | — | 无 |
| A5 | 旧 FakePi gate 测试 | A 全部保留；B **被 decision table 覆盖的删除，只留 interpreter 管线测试** | **B**（replace, don't layer） | 测试数量会下降，但行为覆盖不降——删除前用 §4.3 的对拍证明 | 删除清单在 PR 中逐条列出 |

## 3. 目标与非目标

**目标**
- 内部 `decide(facts) → Decision` 是纯函数：不碰 `ctx.ui`、不写盘、不改闭包状态。
- handler 退化为组装调用输入 → module.check；采集 / decide / interpret 的顺序留在 module 内。
- 全部模式的判定顺序写成一张可读的表（P0-1 的 plan 表纳入其中）。
- gate 行为测试改为 decision table，不依赖 FakePi。
- classifier 重试测试变为确定性。

**非目标**
- 不改任何可观察行为（P0-1 之后的行为为基线）；不改规则语法、family 接口、转发协议（P0-CT-05）、broker mirror 记录点（P4-MC-03）。
- 不拆 `index.ts` 的其他部分（命令、plan 生命周期见 P3-1，working stats 已在 AR1005 完成）。

## 4. 设计

### 4.1 interface 与真实 seam

生产与测试都调用 `createPermissionAdjudicator(deps).check(call) → Promise<Block>`。它持有完整裁决与副作用顺序；入口只采集本次 tool / input / cwd / mode 等上下文并调用 check。生产 deps 接真实交互 / forwarding / classifier；记录式测试 adapter 提供确定答复，二者跨同一 seam。

内部的 `decide(facts) → Decision` 保持纯函数，不把一串会读盘的“谓词回调”伪装成纯输入。`facts` 在惰性采集阶段按需计算：bypass 不探测 plan 文件；普通 read 不启动 classifier；family 权威只调用既有 registry，web 在 mcp 之前。路径、环境与规则文件探测留在采集 implementation，测试注入等价数据。

```
Decision =
  | { kind: "allow"; effects: AllowEffects }
  | { kind: "deny"; reason; compliance?: category }
  | { kind: "prompt"; flavor; label; category; approvalPolicy }
  | { kind: "firstSeen"; canonicalId; suggestedRule }
  | { kind: "classify"; tier3: Tier3Context }
```

Decision 是内部控制数据，不发布到 bus。`interpret` 也是 module 内部 implementation；外部调用方不需要知道该用哪个 interpreter 或在何时补记授权。

### 4.2 顺序与副作用

| 顺序 | 规则 |
|---|---|
| bypass | 首个终态；仅保留现有 outside-write 跟踪；不读 plan 文件 |
| permission rule / family | deny 终态；plan 时先过 P0-1 hard gate，再执行 allow / ask；其余模式保持显式规则的现有短路行为 |
| embedded commands | plan 时属于 P0-1 hard gate：内置硬限制不豁免，权威 MCP shape 且 family 认领的调用跳过 generic scan，由 family 裁决；其余模式仅在无规则短路时执行，安全命令才继续 mode gate，需要询问时该结果就是整个调用终态 |
| plan | P0-1 完整表：允许 plan 文件、安全命令、被批准的 family 调用等；不能再靠 reason 前缀改判 |
| auto | tool_search → read/path checks → write/path checks → shell sensitive → tier1 → user allow（需全命令安全约束）→ soft_deny → tier2 → classifier |
| ask | read outside cwd / edit/write（memory carve-out）/ non-readonly shell 的现有提示；未知非 MCP passthrough 不变 |

重点：批准 embedded-command 的提示后，现状直接返回，不再询问外层 edit。重构不得改成批准后继续检查，也不得丢弃安全 embedded-command 后的外层路径检查。P0-1 的真实对象 then_run 测试为此处基线。

所有结果仍经过既有对应 side-effect implementation：规则持久化、outside-write 快照、family adjudication、session grant、classifier 成功/拒绝计数、compliance、切 bypass。不能将所有 allow 一律加上原路径没有的 effects。prompt 的五种选择与 first-seen 的 once/session/always 分支分别保留。

classifier transport 与重试 seam 使用真实 transport 和可控 fake transport；注入 `now/setTimer/clearTimer`，timeout 在每次 attempt 生效，计时器与 abort listener 在所有出口释放。先完整保留现状尝试次数、重试条件、取消结果与 UI 降级，不能只注入 Date.now 而继续依赖真实 setTimeout。

### 4.3 迁移（每步对拍）

对拍 harness（test-only）：构造输入矩阵——mode × 工具族（read / edit / write / bash / powershell / codemode / tool_search / MCP 五类形态 / 带 then_run 的 edit / 未知工具）× 规则（无 / allow / ask / deny / family 规则 / session grant）× UI（有 / 无 / 子代理）。在冻结的 P0-1 基线上采集旧 handler 的返回值和可观察副作用 trace，再与新 module 比较。旧 handler 不返回 Decision，不能比较虚构的内部对象。fixture 必须来自基线执行，不能由新实现自动更新期望；不在生产里同时运行新旧 handler（会双弹窗 / 双写盘）。加入 then_run 对象/字符串、已授权 MCP 的 command/run/cmd 与 proxy 参数、非 MCP family 不豁免、ask Block/Allow、headless family、forward timeout、classifier 超时/取消等定向 case；无意义的笛卡尔组合不凑数。

1. **Step 1**：bypass / 规则 / plan / ask 迁入 module 内部 `decide`；auto 仍走旧路径。
2. **Step 2**：auto tiers（tier1 / 1.5 allow / 1.5b soft_deny / tier2 / sensitive path / outside cwd）迁入；classifier 仍由旧 `approveAutoTier3` 执行。
3. **Step 3**：`classifier-retry.ts` 注入 clock / signal；删除 handler 中的旧分支；删除被 decision table 覆盖的 FakePi gate 用例（PR 中列清单）。

### 4.4 文件布局

- `extensions/modes/adjudicate.ts`：纯模块，头注释包含完整判定顺序表。
- `extensions/modes/interpret.ts`：副作用执行。
- `extensions/modes/classifier-retry.ts`。
- `index.ts` 的 tool_call handler 只剩组装与注册；命令、生命周期与其他 handler 仍在原处，不声称整个 index.ts 变成薄 adapter。

## 5. 测试

- `extensions/modes/adjudicate.test.ts`（vitest）：decision table，按 mode 分 `describe`，每行一个 `[输入摘要, 期望 Decision]`。
- `interpret.test.ts`：记录式 ctx，覆盖弹窗 5 种选择、转发 approved / denied / timeout、compliance 注入。
- `classifier-retry.test.ts`：fake clock 断言 attempts × timeout，不再断言真实耗时；替换 `index.test.ts:1149`。
- 契约：`bun run contracts` 中 P4-MC-03/04（mirror 一致性）与 P0-CT-05（转发）零改动通过。

## 6. 门禁与回滚

- 每个 Step 一个 commit，三绿（check / test / contracts）且 trace 对拍零差异。
- 删除旧 module 后，权限顺序和副作用知识只会重新分散回入口，这才通过 deletion test；仅把 285 行搬成接受二十个闭包 getter 的函数不算完成。
- FakePi 中验证事件注册、真实参数传递、family 装配、取消与清理的用例保留；只移除完全被新 interface 用例覆盖的重复决策行。
- 回滚：按 Step 逐个 revert；Step 3 删除测试的 commit 单独提交，便于恢复。

## 7. 台账

- `docs/{en,zh}/modes.md` 模块表更新（adjudicate / interpret / classifier-retry）。
- `DEVIATIONS.md`：记录被删除的 FakePi 用例清单及其对应的 decision table 行。
- `PROGRESS.md` 记录本批次。
