# goal — 目标生命周期 + sisyphus 循环

> 中文版。English: [../en/goal.md](../en/goal.md)

**目录**:`extensions/goal/`
**来源**:fork 自 capyup/pi-goal `0.6.0` @ `ec2bcbe`(P2;出处与 diff 白名单见
[FORK.md](../../extensions/goal/FORK.md))

## 做什么

给 agent 一个持久化的目标契约:讨论式创建 + 用户确认、聚焦执行 + 续跑提示、
结构化阻塞报告的暂停/恢复、独立完成度审计,以及持续发送续跑提示直到目标
通过审计的 **sisyphus 模式**。

## 关键表面

- **命令**:`/goal`、`/goals`、`/sisyphus`(意图入口)、`/goal-status`、
  `/goal-list`、`/goal-focus`、`/goal-settings`、`/goals-set`、
  `/sisyphus-set`、`/goal-tweak`、`/goal-clear`、`/goal-abort`、
  `/goal-pause`、`/goal-resume`。
- **工具**:`propose_goal_draft`、`create_goal`、`goal_question`、
  `goal_questionnaire`、`get_goal`、`update_goal`、`pause_goal`、
  `abort_goal`、`step_complete`、`apply_goal_tweak`(名字在
  `goal-tool-names.ts`;可用工具集随 goal 状态变化)。
- **Widget/status**:`goal` widget + `goal` status 槽(契约 P0-CT-07/08);
  总线 `goal` 通道(objective、status、sisyphus 标志、token/时间用量)。
- **磁盘**:`<cwd>/.pi/goals/` —— 状态、台账、归档(布局冻结,P0-CT-09;
  见 `storage/goal-files.ts`)。
- **env**:`PI_GOAL_AUTO_CONFIRM` 自动确认提案。

## 内部地图

| 文件 | 说明 |
|---|---|
| `goal.ts` | 主装配:工具、命令、widget、stop-hook 续跑循环。用量记帐对全部四个 token 通道求和(`input`/`output`/`cacheRead`/`cacheWrite`——cache-inclusive,DEVIATIONS #69) |
| `goal-core.ts` | 渲染/状态助手(footer 状态、时长/token 格式化) |
| `goal-record.ts`、`goal-pool.ts`、`goal-ledger.ts` | 状态模型:active/paused 记录、开放目标池、用量台账 |
| `goal-policy.ts` | 各 goal 状态下允许哪些工具(`ACTIVE_GOAL_TOOL_NAMES`、`POST_STOP_ALLOWED_TOOLS` 等) |
| `goal-draft.ts`、`goal-questionnaire.ts` | /goals 式意图讨论 → `propose_goal_draft` → Confirm/Continue 对话框 |
| `goal-auditor.ts` | 独立完成度审计;其批准是 `update_goal(status=complete)` 的门槛 |
| `goal-compaction.ts` | 长跑中把 goal 上下文压在预算内 |
| `goal-questionnaire.ts` | 意图含糊时的结构化访谈工具 |
| `storage/goal-files.ts` | `.pi/goals/` 磁盘布局 |
| `prompts/goal-prompts.ts` | 提示词模板 |
| `widgets/` | goal widget + 通知 |
| `FORK.md` | fork 出处:上游基线、diff 白名单、license 说明 |

## 不变量与坑

- 子代理会话(`PI_SUBAGENT_CHILD`)不收养磁盘 goal、不武装续跑(goal-hijack 修复,GH-02/03)。
- 完成度审计是权威的:只有其报告批准才归档完成;不得在 `update_goal` 上
  绕过它。
- 阻塞时走结构化的 pause;abort 只用于用户要求放弃/目标过时/不可能完成。
- fork 来的上游文件必须保留出处注释——重写 fork 逻辑前先看 `FORK.md`。

## 测试

`extensions/goal/tests/` —— node:test 经 tsx(16 个套件:statemachine、
policy、ledger、record、pool、draft、questionnaire、auditor、compaction、
files、prompts、widget、notifications、tool-names、event-render、core)。
