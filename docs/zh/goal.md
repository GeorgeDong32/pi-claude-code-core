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
| `goal-lifecycle.ts` | pool/focus/drafting 状态所有者（P2-2 + 2026-10-09 封装收口，DEVIATIONS #120）：转移动词——`create`/`focus`/`unfocus`/`pause`/`pauseByAgent`/`resume`/`activate`/`setUserNote`/`complete`/`terminate(kind, by)`/`retireForReplacement`/`reconcileFromDisk`/`restore`，加路径动词 `applyUsage`（记账归入）/`recordAuditAttempt`/`applyTweak`（目标权威写）/`persistRecord`/`syncObjectiveFromDisk`/`refreshDisplayFromDisk`——各携完整副作用集经注入 ports（clock/continuation/entries/ledger/storage/UI）执行；drafting intents、每轮 flags 与 get_goal nudge 计数为模块私有，仅可经封闭事件入口 `handle(event)` 写入（turn-start/turn-stopped/tool-call/usage-accounted/draft-start·cancel·applied/nudge-reset/agent-settled/dispose）。旧静默原语（`adopt`/`replacePool`/`setFocusedSilently`/`removeFromPool`）与裸 `setGoal` 写口为模块内部；一切出境值（`focused()`/`pool`/`confirmationIntent`/`TransitionReport.record`）为防御性副本，一切入池记录（动词入参、storage port 返回值）入池即克隆——调用方与 port 均不再持有内部活引用。`TransitionReport` 是只读描述（含归档后终态记录）——不是待执行清单 |
| `goal.ts` | 主装配:工具、命令、widget、stop-hook 续跑循环。回合内停止锁只由四个真停止工具的成功 execute 设置(`pause_goal` / `abort_goal` / `update_goal=complete` / `apply_goal_tweak`,D3=A,spec 2026-10-07 P0-2);其余工具调用一律进度中性——放行、不计进度、不锁回合(进度例外读取宿主真实的 `event.input` 字段)。用量记帐对全部四个 token 通道求和(`input`/`output`/`cacheRead`/`cacheWrite`——cache-inclusive,DEVIATIONS #69),并累计 provider 报告的美元费用(`usage.cost.total`);带执行用量的 `tool_result` 事件(subagent 运行、codemode 的 `models.classify`/`generateImages`)同样入帐——goal 台帐因此包含委派出去的模型开销,而不只 parent 主线程 |
| `goal-core.ts` | 渲染/状态助手(footer 状态、时长/token 格式化、单行摘要) |
| `renderers.ts` | 消息渲染器(result / event / audit-event)——自 wiring 拆出(arch review C6),不经工厂即可测 |
| `goal-record.ts`、`goal-pool.ts`、`goal-ledger.ts` | 状态模型:active/paused 记录、开放目标池、用量台账 |
| `goal-policy.ts` | 各 goal 状态下允许哪些工具(`ACTIVE_GOAL_TOOL_NAMES`、`POST_STOP_ALLOWED_TOOLS` 等) |
| `goal-draft.ts`、`goal-questionnaire.ts` | /goals 式意图讨论 → `propose_goal_draft` → Confirm/Continue 对话框 |
| `goal-auditor.ts` | 独立完成度审计;其批准是 `update_goal(status=complete)` 的门槛。AR1005-AU-02:session 创建一解决即进入覆盖其全部剩余生命周期的 try/finally —— 创建期间取消则不 prompt、恰好 dispose 一次;subscribe/prompt/unsubscribe 失败均仍 dispose;超时/中止后的晚到完成只清理、永不批准。`sessionAdapter` 为内部测试 seam(受控 adapter 对真实 `createAgentSession`) |
| `goal-audit-flow.ts` | 完成审计编排(B7 step 2):配置解析、started/rejected/passed 事件三件套、台账写入、有界等待封套。AR1005-AU-01:先建立内部取消结果,再连接外部 signal 并检查其当前状态(预中止调用不触发 auditor,直接返回既有 rejected outcome);timer 与两个 listener 在所有退出路径释放 |
| `goal-accounting.ts` | **活动时钟(AR1005-GO-A)**:持有当前 goal、活动段起点与每个未完成 goal 的毫秒余数。`settle` 返回 floor((elapsed+carry)/1000) 整秒并保留余数(旧 floor 后重置每事件丢亚秒碎片 —— 8 次 250ms 工具结束把真实 2 秒记为 0 秒);`preview` 为无副作用展示读;`pause` 丢弃段但保留各 goal 余数(草拟/暂停/焦点切换);`forget` 释放完成/清除 goal 的余数。余数不跨 goal;磁盘 record 仍为整数 `activeSeconds`(冻结格式 —— 重启至多丢当前段亚秒余数,不再逐事件丢失)。注入式时钟 seam(测试传固定时钟,生产单调时钟,墙上时间戳仍走 `nowIso`)。**GO-B(同事件读取收敛)**:`accountProgress` 持有每事件读取上下文 —— 每同步事件段一次磁盘快照,pool reconcile 与 persist prompt 合并共享(聚焦文件每事件恰好解析一次;N 个 goal 实测 N 次解析,基线 N+1)。上下文不跨 await、不跨事件 —— 下一事件重读并观察外部 objective/status/autoContinue 编辑与删除;零 usage 早退保持在 reconcile 之后,外部取消/删除检测不被跳过。命令、无上下文的 persist、状态转换与 await 后路径保持 fresh read;`writeActiveGoalFile` 安全检查(路径/symlink/原子写)不动 |
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
