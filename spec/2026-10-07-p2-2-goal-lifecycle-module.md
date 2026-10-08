# SPEC P2-2：goal lifecycle module（B7 收尾：转移动词持有完整副作用集）

状态：**已实施（2026-10-08，四步全部落地：Step1 828c5c6 / Step2 f13c2bb / Step3 11eafde / Step4 本批）**；D3=A 已确认；DEVIATIONS #73 已关闭。见 [2026-10-08 剩余任务](2026-10-08-followup-execution.md)与 DEVIATIONS #117/#118。
日期：2026-10-07
分支：main
来源：2026-10-07 联合架构审查，报告 C2 卡片；清单项 CORE-13。PROGRESS「架构优化 8-batch」B7 与 DEVIATIONS #73 记录的"状态机核心 + confirmation 粘合仍在 goal.ts、thin adapter 终态未达"

## 1. 背景

`extensions/goal/goal.ts` 有 2454 行，近期 31 次提交，是仓库里最热的文件。B7 已把 continuation（`goal-continuation.ts`）、audit flow（`goal-audit-flow.ts`）、accounting clock（`goal-accounting.ts`）搬出。剩下的核心是 **pool / focus / drafting 的状态转移**。

同一类状态操作有以下写法。表列局部函数动作，不等于可达调用路径上的行为缺陷；必须沿调用链确认：

| 转移 | 停 loop | 停 clock | forget carry | nudge 复位 | 释放 tweak gate | focus entry | ledger | persist | sync + UI |
|---|---|---|---|---|---|---|---|---|---|
| `setGoal`（`870-900`） | ✓ | ✓ | 条件 | 条件 | ✓ | 仅传 reason 时 | – | ✓ | ✓ |
| `setFocusedGoalId`（`558-581`） | ✓ | ✓ | – | ✓ | ✓ | ✓ | ✓ | – | ✓ |
| `removeFocusedGoal`（`601-610`，基线仅定义、无调用） | ✓ | ✓ | **–** | 仅 previous | **–** | ✓ | – | – | ✓ |
| `update_goal` complete 内联（`1797-1808`） | 经 setGoal | 经 setGoal | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |

另外：

- `handleGoalClear` 与 `handleGoalAbort`（`1303-1355`）几乎逐行重复。
- `updateFocusedGoal`（`583-594`）、`removeFocusedGoal`（`601-610`）没有调用方，按死代码处理。不能为 removeFocusedGoal 补副作用并宣称修复生产 bug。
- drafting intent（`confirmationIntent` / `tweakDraftingFor`）有约 6 处散落的清理点；P0-2 已修掉其中一个泄漏。
- 闭包状态（`317-389, 447, 497`）：`goalsById`、`focusedGoalId`、`tweakDraftingFor`、`confirmationIntent`、`runningGoalId`、`goalWorkToolCalledThisTurn`、`turnStoppedFor`、`postCompactReminderPending`、`pendingResumeNote`、`activeGetGoalTurnsByGoalId`。

## 2. 决策登记

| # | 决策 | 候选方案 | 选择 | 放弃了什么 | 风险与承担 |
|---|---|---|---|---|---|
| L1 | module 形态 | A factory 函数返回动词对象（与 `goal-continuation.ts` 同构）；B class | **A** | B 的继承能力（用不上） | 无 |
| L2 | 持有哪些状态 | A 只持有 pool + focus；B **pool + focus + drafting intents + 每轮 flags** | **B** | A 的更小改动面 | B 搬迁面更大，按 §4.3 分步 |
| L3 | 副作用如何执行 | A 动词内直接调 pi；B **动词只调用注入的 ports**（ledger / storage / clock / continuation / entries / ui-sync） | **B** | — | ports 多 6 个参数，但都已有现成实现 |
| L4 | `state` 代理（`334-347`） | A 保留；B 由 module 的 `focused()` getter 取代 | **B**（迁移期内保留代理作为别名） | — | 无 |
| L5 | 转移结果 | A void；B **返回 `TransitionReport`**（前后焦点、转移状态、供显示的结果摘要；已执行 effects 的只读描述） | **B** | — | 调用方据此做格式化与通知，便于断言 |

## 3. 目标与非目标

**目标**
- 新 `extensions/goal/goal-lifecycle.ts` 以 8 个主要转移动词为核心：`create`、`focus`、`unfocus`、`pause`、`resume`、`complete`、`terminate(kind: "clear" | "abort")`、`reconcileFromDisk`。每个动词内部拥有与其实际语义对应的副作用集，不能套用一份无条件的清理列表。只读访问和事件更新使用下文的封闭入口。
- commands / tools / pi handlers 只做参数校验、调用动词、格式化输出。
- 状态机测试不依赖 FakeHost。

**非目标**
- 不改 session entry 类型与字段（P0-CT-08：`pi-goal-state` / `pi-goal-focus` / `pi-goal-event` / `pi-goal-audit-event`）。
- 不改 `.pi/goals/` 磁盘布局与 ledger 事件类型（P0-CT-09）。
- 不改 continuation 节奏、accounting、audit flow 的任何语义。
- 不改工具 schema 与命令文本。

## 4. 设计

### 4.1 ports

```
createGoalLifecycle({
  storage,       // goal-files：read / write / archive / mergeGoalPromptFromDisk
  ledger,        // appendGoalEvent
  clock,         // goal-accounting：pause / forget / begin
  continuation,  // 注入 clear / queue adapter；沿用现有 controller 的真实 interface
  entries,       // appendFocusEntry → pi.appendEntry(FOCUS_ENTRY, …)
  uiSync,        // syncGoalTools + updateUI（由 adapter 注入，module 不知道 pi）
  now,
})
```

### 4.2 状态所有权与顺序

- 只读 `snapshot()` / `focused()` 返回只读投影或副本；不允许 `state.goal = ...` 越过 module 写入。
- 事件入口 `handle(event)` 接收封闭 union：restore、turn-start、tool-call、usage-accounted、draft-start/draft-cancel/draft-applied、agent-settled、dispose。它复用主要动词与既有 clock/continuation module，不把任意 setter 暴露给调用方。每个 tag 列出生产事件来源及一条 interface 测试。
- 先记录每个可达转移的旧 trace（状态、archive/write、entries、ledger、clock、UI），按语义迁移；pause 保留 carry，终结先结算用量再归档/forget。clock 仍只有 goal-accounting 持有，不在 lifecycle 重写计时算法。
- clear/abort 在 drafting 中只取消 draft，不能把“通用 terminate”变成归档现有 goal；无 focus 时的用户选择仍由 adapter 完成。
- ledger 保持 best-effort；storage 的写盘失败不能伪报成功。单个调用的失败状态与现状对拍；不凭该重构引入跨文件事务承诺。
- TransitionReport 只供格式化与断言，**不是待执行 effects 列表**。adapter 不得再次执行其中描述的 ledger/queue/UI 动作。
- 外部 audit await 留在 audit flow。complete 接收明确 goalId 与已有裁决结果；以现有审计目标校验语义接回 lifecycle，不以 await 后的新焦点替代旧目标。超时、拒绝与晚到完成的现有回归保留。
- 同步转移结束时统一同步工具/UI，成功路径一次；无变化的拒绝/no-op 不额外写 ledger。涉及现有重复 UI 同步的合并需先 pin 最终显示与调用时序。


### 4.3 迁移步骤

1. 冻结 P0-2 后可达转移 trace；新建 module，把 pool/focus 与对应转移动词一起迁入。允许过渡 adapter，但不能以永久闭包回调壳作为交付。
2. 把 complete 内联块、clear/abort 共同行为改为调用动词，保留 drafting 分支、归档与提示差异。
3. 将 drafting intents / turn flags / nudge 状态移入封闭事件入口；入口只读投影。accounting 与 continuation 的状态仍由各自 module 持有。
4. P3-1 S6 已在 edb1e5b 删除 updateFocusedGoal / removeFocusedGoal / draftingHiddenWorkTools，不重复处理或重建；撤除本轮迁移代理。接口对拍零差异后才减少重复 FakeHost 测试。

### 4.4 测试

- `extensions/goal/tests/goal-lifecycle.test.ts`（node:test）：转移表，用记录式 fake ports 断言每个动词的副作用序列（ledger 事件、entries、clock 调用、continuation 调用、uiSync 次数）。
- 新增多 goal 焦点切换、draft 发送失败、pause/resume carry、磁盘删除/取消、storage失败、ledger失败、审计中焦点变化、turn 锁与 session dispose 的序列测试。
- `goal-statemachine.test.ts` 与现有 goal 测试全部零改动通过；其中与转移表重复的用例在第 3 步之后可删减（PR 中列清单）。

## 5. 门禁与回滚

- 每步一个 commit，`bun run check && bun run test && bun run contracts` 三绿。
- 回滚：逐步 revert；每步保持可运行；删除测试的提交最后落，回滚时先恢复测试。

## 6. 台账

- `docs/{en,zh}/goal.md` 模块表新增 `goal-lifecycle.ts`。
- `extensions/goal/FORK.md` 记录结构性偏离。
- `DEVIATIONS.md`：本批以行为保持为目标；如新发现可达缺陷，先单列红测试和差异，不夹带在搬移中。只有状态写入与转移顺序确实集中、入口不再保有第二份写权时，才关闭 #73。
- `PROGRESS.md` 记录本批次。
