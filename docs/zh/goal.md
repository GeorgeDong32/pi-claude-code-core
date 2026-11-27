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
  `goal-tool-names.ts`)。声明给模型的只有 `get_goal` 与 `propose_goal_draft`
  (外加工作工具)。六个生命周期工具是 `exposure: "codemode"`——不进工具清单,
  codemode 脚本里 `tools.update_goal(...)` 调用;`create_goal` 与 legacy 的
  `step_complete` 保持 hidden。任何 goal 状态下声明集都相同(goal 工具瘦身 v2)。
- **Widget/status**:`goal` widget + `goal` status 槽(契约 P0-CT-07/08);
  总线 `goal` 通道(objective、status、sisyphus 标志、token/时间用量)。
- **磁盘**:`<cwd>/.pi/goals/` —— 状态、台账、归档(布局冻结,P0-CT-09;
  见 `storage/goal-files.ts`)。
- **env**:`PI_GOAL_AUTO_CONFIRM` 自动确认提案。

## 内部地图

| 文件 | 说明 |
|---|---|
| `goal-lifecycle.ts` | pool/focus/drafting 状态所有者（P2-2 + 2026-10-09 封装收口，DEVIATIONS #120）：转移动词——`create`/`focus`/`unfocus`/`pause`/`pauseByAgent`/`resume`/`activate`/`setUserNote`/`complete`/`terminate(kind, by)`/`retireForReplacement`/`reconcileFromDisk`/`restore`，加路径动词 `applyUsage`（记账归入）/`recordAuditAttempt`/`applyTweak`（目标权威写）/`persistRecord`/`syncObjectiveFromDisk`/`refreshDisplayFromDisk`——各携完整副作用集经注入 ports（clock/continuation/entries/ledger/storage/UI）执行；drafting intents、每轮 flags 与 get_goal nudge 计数为模块私有，仅可经封闭事件入口 `handle(event)` 写入（turn-start/turn-stopped/tool-call/usage-accounted/draft-start·cancel·applied/nudge-reset/agent-settled/dispose）。旧静默原语（`adopt`/`replacePool`/`setFocusedSilently`/`removeFromPool`）与裸 `setGoal` 写口为模块内部；一切出境值（`focused()`/`pool`/`confirmationIntent`/`TransitionReport.record`）为防御性副本，一切入池记录（动词入参、storage port 返回值）入池即克隆——调用方与 port 均不再持有内部活引用。`TransitionReport` 是只读描述（含归档后终态记录）——不是待执行清单 |
| `goal.ts` | 主装配:`goalExtension(pi, deps)` 工厂——lifecycle/UI/续跑循环构造、记账与落盘基线、15 个 `pi.on` handler、以及钉住顺序的注册序列(renderer → 命令 → 问卷工具 → goal 工具 → 工厂期 `setActiveTools`;顺序由 `tests/goal-registration-order.test.ts` 钉住)。纯助手、命令与工具注册分布在下方六个拆分模块(E13a,SPEC SR 2026-11-15)。回合内停止锁只由四个真停止工具的成功 execute 设置(`pause_goal` / `abort_goal` / `update_goal=complete` / `apply_goal_tweak`,D3=A,spec 2026-10-07 P0-2);其余工具调用一律进度中性——放行、不计进度、不锁回合(进度例外读取宿主真实的 `event.input` 字段)。用量记帐对全部四个 token 通道求和(`input`/`output`/`cacheRead`/`cacheWrite`——cache-inclusive,DEVIATIONS #69;提取逻辑在 `goal-turn-usage.ts`),并累计 provider 报告的美元费用(`usage.cost.total`);带执行用量的 `tool_result` 事件(subagent 运行、codemode 的 `models.classify`/`generateImages`)同样入帐——goal 台帐因此包含委派出去的模型开销,而不只 parent 主线程。**BH-R1(spec 2026-11-14-backtest-hardening)**:`agent_end` 续跑决策点检查本次 run 最后一条 assistant 消息的 `stopReason`——非 error 终止清零该 goal 的连续错误计数;连续两次 `stopReason:"error"` 终止则经 lifecycle pause 动词暂停 goal(`pauseReason` = `provider error: <errorMessage 前 120 字>`,建议动作为 `/goal resume`,并通知用户),不再无限续跑(回测:单会话 2,241 次错误 / 13 小时 / 1.11 亿 token)。aborted 分支保持原有用户暂停行为;显式 `/goal-resume` 重新从零计数。**BH-E1(同 spec)**:用量记账只写内存——usage 事件不追加 `pi-goal-state` 条目、不重写 md、不重扫磁盘;usage 只在三个时机落盘(每次 `agent_end`,且仅当内存 usage 与上次落盘快照不同;`session_shutdown`;任何真实状态转移——转移立即落盘并携带最新 usage)。落盘条目格式不动(P0-CT-08);两次落盘之间内存 usage 即活权威,所有磁盘重收养经 max-merge 保留它。回测:98.8% 的落盘条目仅 usage/updatedAt 不同;50 回合 run 从 50 条降到 1 条 |
| `goal-entries.ts` | 冻结 entry 常量(`pi-goal-state/-focus/-event/-audit-event`,P0-CT-08)、`pi-goal-state` v3 payload 投影(`goalDetails`)与注入 goal id 解析(`extractGoalIdFromInjectedMessage`/`goalEventMessageId`——「这条注入消息属于哪个 goal」的唯一权威,Phase 5 C1)。纯模块 |
| `goal-turn-usage.ts` | 消息分类 + 四通道 token/cost 提取(`assistantTurnTokens`/`assistantTurnCost`——cache-inclusive,DEVIATIONS #69;`toolExecutionUsage` 处理执行上报用量;`lastAssistantStopReason` 为 BH-R1 探针)。纯模块 |
| `goal-summary.ts` | 用量摘要文本(`detailedSummary`)、可序列化 widget 投影(`widgetGoalProjection` + 导出 `WidgetGoalProjection`,DC4b)、缺失 criteria 提示(`missingCriteriaLines`,G3-C20)与第三次尝试阈值(G3-C21)。纯模块 |
| `goal-settings.ts` | `/goal-settings` 对话框(auditor provider/model/thinking_level)——只读写 auditor 配置文件 |
| `goal-commands.ts` | `createGoalCommands(pi, deps)`:15 个 `/goal*` 命令注册 + 处理函数,自 goal.ts 逐字迁出;会话状态经窄 deps 对象传入(`lifecycle` 以 `GoalLifecycle` 类型——#120 封装);返回 `focusGoalCommand`(`session_start` 复用)。注册顺序由 `tests/goal-registration-order.test.ts` 钉住 |
| `goal-tools.ts` | `registerGoalTools(pi, deps)`:8 个 goal 工具按原顺序注册;`getRunningGoalId` 以 live getter 传入(runningGoalId 为工厂状态、逐 run 变更);`PI_GOAL_AUTO_CONFIRM` 调用时读取;`StringEnum` shim 与 `COMPLETE_STATUS` 在此。注册顺序由 `tests/goal-registration-order.test.ts` 钉住 |
| `goal-core.ts` | 渲染/状态助手(footer 状态、时长/token 格式化、单行摘要) |
| `renderers.ts` | 消息渲染器(result / event / audit-event)——自 wiring 拆出(arch review C6),不经工厂即可测 |
| `goal-record.ts`、`goal-pool.ts`、`goal-ledger.ts` | 状态模型:active/paused 记录、开放目标池、用量台账 |
| `goal-policy.ts` | 生命周期动作的执行层门禁:按 goal 状态校验 complete / pause / abort,`validateNoDraftingPhase`(确认或 tweak 访谈期间拒绝),`validateDraftingInterview`(提问工具只在当前聚焦 goal 的访谈内应答)。可见性不再承担门禁:生命周期工具是 codemode 暴露的。 |
| `goal-draft.ts`、`goal-questionnaire.ts` | /goals 式意图讨论 → `propose_goal_draft` → Confirm/Continue 对话框 |
| `goal-auditor.ts` | 独立完成度审计;其批准是 `update_goal(status=complete)` 的门槛。AR1005-AU-02:session 创建一解决即进入覆盖其全部剩余生命周期的 try/finally —— 创建期间取消则不 prompt、恰好 dispose 一次;subscribe/prompt/unsubscribe 失败均仍 dispose;超时/中止后的晚到完成只清理、永不批准。`sessionAdapter` 为内部测试 seam(受控 adapter 对真实 `createAgentSession`)。**BH-E6(spec 2026-11-14-backtest-hardening,已复现)**:prompt await 与 abort signal 竞速——忽略 abort 的流会让 `prompt()` 永不 settle,流程超时返回后 dispose finally 永不执行(session 泄漏);现在 abort 即刻 settle 该 await,session 恰好 dispose 一次(仍是唯一 dispose 点) |
| `goal-audit-flow.ts` | 完成审计编排(B7 step 2):配置解析、started/rejected/passed 事件三件套、台账写入、有界等待封套。AR1005-AU-01:先建立内部取消结果,再连接外部 signal 并检查其当前状态(预中止调用不触发 auditor,直接返回既有 rejected outcome);timer 与两个 listener 在所有退出路径释放审计事件三相位为 view-only(2026-11-02):每条 `pi-goal-audit-event` 都带 `details.viewOnly`,context handler 将其从模型请求中剔除 —— 审计结论只经 `update_goal` tool result 单通道触达模型 |
| `goal-accounting.ts` | **活动时钟(AR1005-GO-A)**:持有当前 goal、活动段起点与每个未完成 goal 的毫秒余数。`settle` 返回 floor((elapsed+carry)/1000) 整秒并保留余数(旧 floor 后重置每事件丢亚秒碎片 —— 8 次 250ms 工具结束把真实 2 秒记为 0 秒);`preview` 为无副作用展示读;`pause` 丢弃段但保留各 goal 余数(草拟/暂停/焦点切换);`forget` 释放完成/清除 goal 的余数。余数不跨 goal;磁盘 record 仍为整数 `activeSeconds`(冻结格式 —— 重启至多丢当前段亚秒余数,不再逐事件丢失)。注入式时钟 seam(测试传固定时钟,生产单调时钟,墙上时间戳仍走 `nowIso`)。**GO-B(同事件读取收敛,BH-E1 后重塑)**:usage 事件的每事件磁盘快照已移除——usage 事件零文件解析(纯内存)。run 边界 `agent_end` 同步改为持有事件读取上下文:每次 run 边界恰好一次 pool 解析,reconcile 与 flush 的 persist prompt 合并共享(聚焦文件每个边界恰好解析一次;下一个边界重读并观察外部 objective/status/autoContinue 编辑与删除)。命令、无上下文的 persist、状态转换与 await 后路径保持 fresh read;`writeActiveGoalFile` 安全检查(路径/symlink/原子写)不动 |
| `goal-compaction.ts` | 长跑中把 goal 上下文压在预算内 |
| `goal-questionnaire.ts` | 意图含糊时的结构化访谈工具 |
| `storage/goal-files.ts` | `.pi/goals/` 磁盘布局 |
| `prompts/goal-prompts.ts` | 提示词模板 |
| `widgets/` | goal widget + 通知 |
| `FORK.md` | fork 出处:上游基线、diff 白名单、license 说明 |

## 不变量与坑

- 子代理会话(`PI_SUBAGENT_CHILD`)不收养磁盘 goal、不武装续跑(goal-hijack 修复,GH-02/03)。
- provider 错误不让 sisyphus 续跑空转(BH-R1):连续两次 `stopReason:"error"` 终止即经 lifecycle pause 动词暂停 goal,并提示用户检查 provider/额度后执行 `/goal resume`。
- 完成度审计是权威的:只有其报告批准才归档完成;不得在 `update_goal` 上
  绕过它。
- 阻塞时走结构化的 pause;abort 只用于用户要求放弃/目标过时/不可能完成。
- **声明集恒定**:`syncGoalTools` 不再按 goal 状态或阶段增删生命周期工具(只保证工作工具、`get_goal`、`propose_goal_draft` 在集合里、hidden 两个不在);每轮重跑且幂等,因为 plan 模式退出时会恢复进入时的快照。过去靠可见性执行的起草期规则改为执行层门禁:`validateNoDraftingPhase`(确认或 /goal-tweak 起草期间拒绝 complete / pause / abort)与 `validateDraftingInterview`(提问工具只在起草类访谈内应答)。所有注入提示都写 codemode 调用形式;裸名 `update_goal(...)` 不是声明工具。这里不能用 `"deferred"`:pi 的 `tool_search` 默认注册为 inactive(见 `docs/zh/memory.md`)。
- fork 来的上游文件必须保留出处注释——重写 fork 逻辑前先看 `FORK.md`。

## 测试

`extensions/goal/tests/` —— node:test 经 tsx(16 个套件:statemachine、
policy、ledger、record、pool、draft、questionnaire、auditor、compaction、
files、prompts、widget、notifications、tool-names、event-render、core)。
