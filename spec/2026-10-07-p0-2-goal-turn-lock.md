# SPEC P0-2：goal 回合锁只留给"真停止"（D3）+ drafting intent 复位

状态：规格已补齐；锁策略**待决策 D3**（推荐方案 A，见 §2），仅 CORE-05 可独立实施；G3 必须与 D3 同批
日期：2026-10-07
分支：main
来源：2026-10-07 联合架构审查，清单项 CORE-01 / CORE-05；本 spec 新增发现 G3（`event.args` 字段错误）
上游：逻辑源自 capyup/pi-goal fork 导入（`6c4da0e`），落地后在 `extensions/goal/FORK.md` 记录偏离

## 1. 背景：goal 现在怎样给工具分类

pi 的一个 **turn** 等于"一条模型回复 + 这条回复里的全部工具调用"。`turn_start`（`goal.ts:2148-2154`）会复位两个每轮标志。goal 的 tool_call handler（`goal.ts:2157-2188`）把每个工具调用分成三类：

| 类别 | 名单 | 效果 |
|---|---|---|
| 进度工具 | `GOAL_PROGRESS_TOOL_NAMES` 共 11 个：update_goal / pause_goal / abort_goal / apply_goal_tweak / write / edit / bash / read / grep / find / ls（`goal-tool-names.ts:32-44`） | 置 `goalWorkToolCalledThisTurn`，清零 get_goal 提醒计数 |
| 停止工具 | pause_goal、abort_goal、update_goal(complete)、apply_goal_tweak 执行成功后（`goal.ts:1801, 1881, 1941, 2077`） | 置 `turnStoppedFor`：本条回复里之后的工具全部被拒，只剩 `get_goal` 可用 |
| **其他所有工具** | 不在上面名单里的一切：obs_recall、session_recall、memory_consolidate、pi_review_report、plan_ready、subagent、MCP / web 工具、tool_search、codemode…… | **也置 `turnStoppedFor`**（`goal.ts:2183-2186`），效果与"停止工具"完全一样 |

拒绝理由（`goal.ts:2162-2167`）是：

> The goal was already stopped earlier in this turn … Do not call more tools; end the turn with a brief summary and yield to the user.

### 1.1 实际后果

- 模型在同一条回复里并行调用 `[obs_recall, edit]` → `edit` 被拒，理由谎称"goal 已停止"，并要求模型结束、交还用户。
  - 模型照做后 run 结束，`agent_end`（`goal.ts:2415-2446`）发现 goal 仍是 active，又排一次 continuation。
  - 净效果：并行工作被丢弃、多出一轮"续跑"、模型收到自相矛盾的信号。
- **codemode 在 goal 期间完全不可用**（由代码推导，未实测）。codemode 自身的 tool_call 先触发锁，其脚本里的嵌套调用同样走 tool_call（宿主类型 `ToolCallEventBase.parentToolCallId`），全部被拒。
- 被误伤的恰恰是 core 自己的工具。例如 observation-pack 把大输出替换为 placeholder 后，**要求模型用 `obs_recall` 去读**。
- 注释写的意图是"非进度工具不应制造无限重试链"，但这把锁并不能阻止续跑：续跑由 `agent_end` 无条件驱动，与本轮调过什么工具无关。

### 1.2 附带发现

- **G3**（新）：`goal.ts:2180` 读的是 `asRecord(event)?.args`，而宿主 tool_call 事件的字段是 `input`（pi `dist/core/extensions/types.d.ts:905-939`）。因此 `isMeaningfulProgressToolCall` 里的两个例外——`bash` 以 `echo` 开头、`read` 读 `.pi/goals/`——**从未生效**，这两类调用都被算成了进度。
- **CORE-05**：`startGoalDrafting` 在 `sendMessage` 抛错时不复位 `confirmationIntent`（`goal.ts:1069-1071`），而 tweak 路径会复位（`1025-1027`）。结果是 drafting 门控残留：工具集停在 drafting 形态，`beginAccounting` / `turn_end` / `agent_end` 全部早退。

## 2. 决策登记

"进度中性"指第三类工具：**允许调用、不算进度、也不锁回合**。D3 要回答的是：除了"真停止"之外的工具，应该怎么处理。

| # | 候选 | 做法 | 优点 | 放弃了什么 / 风险 |
|---|---|---|---|---|
| **A（推荐）** | 只有真停止才锁回合 | 删掉 `goal.ts:2183-2186` 的 `else if` 分支；进度名单保持不变 | 删除误锁分支；直接消除误锁、codemode 失效和 obs_recall 冲突；续跑节奏不变（本来就由 agent_end 驱动） | 放弃"用锁截短闲聊回合"。当前锁只能截断同一 turn 的后续工具，并不能阻止下一轮续跑 |
| B | A + 扩充进度白名单 | 把 obs_recall / session_recall / subagent / MCP 等加入进度名单 | 委托类工作也能清零 get_goal 提醒 | 仍是封闭世界——core 或其他扩展每加一个工具都要改名单；收益只在提醒计数上 |
| C | A + 进度改黑名单 | 除 get_goal / goal_question / goal_questionnaire / propose_goal_draft / create_goal、echo、读 `.pi/goals` 外，都算进度 | 开放世界，新工具自动算进度 | 改变进度语义；提醒计数清零得更频繁（影响很小） |
| D | 保留锁，补齐豁免名单 | 把 core 自有工具加进 `POST_STOP_ALLOWED_TOOLS` | 最保守 | 依旧封闭世界；MCP、subagent、codemode 仍被误伤 |

**推荐 A。** 理由：进度名单如今只影响两件事——①get_goal 提醒计数；②`turn_end` 续跑路径（实际触发很少，主路径是 `agent_end`）。所以 B / C 只是锦上添花，可以以后再做。D 修不干净。

其余决策：

| # | 决策 | 选择 | 放弃了什么 |
|---|---|---|---|
| G3 | `args` → `input` | 修正为 `event.input`（宿主 1.0.1 的真实字段；不为无证据的旧 `args` 形状新增兼容协议） | 依赖 D3：单改字段会使 echo / read-goal 进入现有 else-if 误锁分支，新增后续 edit 被拒；不能单独实施 |
| CORE-05 | drafting 发送失败 | catch 中复位 `confirmationIntent` 并 `syncGoalTools()`，与 tweak 路径对称 | 无 |

## 3. 目标与非目标

**目标**
- 只有 pause / abort / complete / apply_goal_tweak 成功后才锁回合（方案 A）。
- 修正 G3，让进度例外真正生效。
- drafting 失败路径不残留门控。

**非目标**
- 不改续跑节奏、预算、审计、ledger 格式（P0-CT-08 / 09 冻结面不动）。
- 不做 goal lifecycle 重构（见 P2-2）。
- 不改 `POST_STOP_ALLOWED_TOOLS` 与停止后的拦截文本。

## 4. 设计

以下锁策略设计以推荐 A 为准；若选择 D，必须重新定义进度中性工具与 G3 例外的放行，满足 L5 才可实施。

1. `goal.ts:2179-2186`：删除 `else if (... autoContinue && event.toolName !== "get_goal") turnStoppedFor = ...` 分支；头部注释（`371-379`）同步改为"只有 4 个真停止工具设置回合锁"。
2. 与步骤 1 同批修改 `goal.ts:2180`：`isMeaningfulProgressToolCall(event.toolName, event.input ?? {})`；测试发送真实 tool_call 事件形状。
3. 若选 B / C：在步骤 1 / 2 基础上另改 `goal-tool-names.ts`（常量 `GOAL_PROGRESS_NEUTRAL_TOOL_NAMES` 或黑名单），并补 `goal-tool-names.test.ts`。
4. `startGoalDrafting` catch：`confirmationIntent = null; syncGoalTools();`。

## 5. 回归测试（node:test，`extensions/goal/tests/`）

现有测试没有任何用例覆盖 goal 的 tool_call 回合锁（`grep tool_call extensions/goal/tests` 为空）。新增 `goal-turn-lock.test.ts`，使用 `goal-statemachine.test.ts` 的 FakeHost 搭法：

| # | 用例 | 基线 |
|---|---|---|
| L1 | active+autoContinue：同一 turn 内依次触发 `obs_recall` 与 `edit` 的 tool_call → `edit` 不被拦 | **红** |
| L2 | 同上，换成 `subagent`、`mcp__exa__search`、`codemode` + 带 `parentToolCallId` 的嵌套 `read` | **红** |
| L3 | pause_goal / abort_goal / update_goal complete（审计通过）/ apply_goal_tweak 各自执行成功后，同 turn 的 edit 仍被拦，get_goal 仍可用；失败 / 审计拒绝不误设停止锁 | 绿（钉现状） |
| L4 | `turn_start` 后锁复位 | 绿 |
| L5 | active+autoContinue，同一 turn 依次真实 tool_call：bash `input:{command:"echo hi"}` → edit，以及 read `input:{path:".pi/goals/x.md"}` → edit；首调用不清零 get_goal 提醒、不设停止锁，后续 edit 均可继续 | 提醒断言基线**红**；仅改单字段会使 edit 断言变红 |
| L6 | CORE-05：`sendMessage` 抛错 → `confirmationIntent` 为 null，工具集回到非 drafting 形态 | **红** |
| L7 | `agent_end` 续跑：active goal 在只调用了 obs_recall 的 run 结束后仍排 continuation（钉现状，证明 A 不改变续跑） | 绿 |

## 6. 实施顺序与门禁

1. D3 未确认时，仅落地 CORE-05 drafting 复位与 L6。G3 / L5 及其他锁策略变更一起等待 D3，禁止先合 args → input。
2. D3 确认后写 L1–L7，记录基线红绿。
3. 同批修改 §4 的 1 / 2；按 D3 决定是否做 3。CORE-05 若已独立落地则不重复修改。
4. `bun run check && bun run test && bun run contracts` 三绿。

## 7. 风险与回滚

- **风险**：方案 A 之后，模型可能在一条回复里连调多个非进度工具。这正是移除误锁的预期变化；预算与审计继续约束 run，但不声称能限制单 turn 工具数量。
- **回滚**：G3 与锁策略作为一个行为变更一起回退，禁止只回退其中一半；独立 CORE-05 可单独回退。

## 8. 台账与文档

- `CHANGELOG.md` Unreleased："goal 进行中，非进度工具不再锁住同一回复中的后续调用；修复进度例外字段读取"。
- `extensions/goal/FORK.md`：登记偏离上游。
- `DEVIATIONS.md` 条目；`docs/en/goal.md` 与 `docs/zh/goal.md` 补"回合锁只由 4 个停止工具触发"。
