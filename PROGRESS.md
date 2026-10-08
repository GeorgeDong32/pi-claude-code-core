# PROGRESS — pi-claude-code-core 实施进度

> 每模块:状态 / 复查结论 / 测试计数 / 剩余风险。日期均为 2026-09。

## 2026-10-08 通知修复：effort 双写收敛为单一显示（第一层）

- **缺陷**：`effort/ui/index.ts#createEffortUi.notify` 保留 DC3 双写（`publishNotification` + 无条件 `ctx.ui.notify`），DC5b 接通真实消费者后每条 effort 告警显示两次——现代 TUI（队列消费 + 直写）与 core-only（fallback 适配器 + 直写）均 2 次，真实终端有/无 TUI 双双实测复现（TUI 仓 H-T1b 对照记录）。
- **修复**：notify 委托共享 `ui/notify.ts#notify()`——队列恒发布 + 仅旧 cctui（无 `notificationsConsumer` 能力声明）直写兜底；effort 不再保有第二份无条件写腿。未在任何消费端新增文本去重。
- **回归**：`extensions/effort/tests/notify-display.test.ts` 7 例——真实 effort 通知入口 + 真实 bus + 真实 fallback 适配器（按 modes session_start 同款接线）+ 现代 cctui 消费者镜像（attach 快进 + id diff）。覆盖 core-only 恰一次/同文本重复仍显示（id 而非文本为身份）/现代 TUI 仅队列零直写/旧 TUI 直写恰一次/headless 零显示队列仍记录/两种 off 交接（下一条恰一次、无历史重放）。基线红取证：修复前 6 红 1 绿（旧 TUI 兼容分支本就正确,须保持）；修复后 7/7 绿。
- **既有测试迁移**：ui.test.ts「forwards verbatim」改钉「无 cctui 无直写」；integration.test.ts 两例（cancel/non-reasoning 通知）改断言真实 bus 队列 + 零直写（显示所有权归 fallback 适配器,单模块 session 无显示是预期）。
- **门禁**：check 0；vitest 935 + node:test 全 0 fail（exit 0,本轮实际取得 node:test 通过结果,补上前次沙箱缺失项）；contracts 43 passed + 3 todo。
- **台账**：CHANGELOG Unreleased、docs/{en,zh}/ui.md 测试节、本条。真实终端复验归第五层统一执行（修复 revision 见本条 commit）。

## 2026-10-08 H-Q：隔离双真实 pi session drain 验收 — PASS

- **环境**：真实 pi 1.0.2(PATH),`-p` 非交互双进程并发(间隔 0.4s);隔离 HOME + PI_CODING_AGENT_DIR + 项目目录(/tmp);被测实现 = 本仓 `git clone --no-hardlinks` 预置进隔离 agentDir 的 git 包布局经 settings packages 真实加载(加载证据:permission-modes 启动行 + review 模块 banner);凭据/models 从真实 agentDir 拷贝(留在隔离副本内)。macOS /tmp→/private/tmp realpath 陷阱已定位并修正(预置 record 的 projectsDir 必须按 canonical 路径 sanitize)。
- **四项验收(verdict.json)**:①同一记录仅一位 live owner——全快照 doubleClaims=[](claim 文件名含 pid,可区分 owner);②cap 之后候选仍可消费——A 首轮恰 claim 5(QUEUE_DRAIN_MAX)剩 2 条 ready,B 接走全部;③失败/结束无搁浅活 claim——strandedClaimsAtEnd=[],t≈4.6s 全部 settle,双进程 exit 0;④转移证据保留——queue-timeline.json(25ms 采样:5-claim → 7-claim 双 owner → 单调 settle → 空)+ 双 session 日志 + core revision。
- **失败路径实测**:routing mismatch(projectsDir 不符)→ claim→skip→释放回 pending(attempts 不动)零搁浅;极短 -p session 的 shutdown 取消 → 记录回 pending 可重试。1 条故意 mismatch 的最终状态(pending vs GC)未在采样窗口内捕获,记 open note(不影响任何验收项)。
- **可复现**:`bash scripts/hq-drain-evidence.sh`;证据目录 `test/evidence/2026-10-08-hq-dual-session-drain/`。既有子进程原语测试(memory-queue-claim 等)保留未动;本验收为真实宿主生命周期证据,二者分记。

## 2026-10-08 C5-Step1：goal-lifecycle module — pool/focus 所有权迁入（P2-2 1/4）

- **实现**:`goal-lifecycle.ts`(L1=A factory/L2=B 全所有权/L3=B ports/L4=B focused() getter/L5=B TransitionReport)——私有 pool Map + focusedId;两个写动词 `setGoal`/`focus` 携带完整副作用集(与 goal.ts 原实现逐行对应,verb effect 表在头注释);静默原语 replacePool/setFocusedSilently/removeFromPool/adopt 承载 reconcile/loadState/state-setter 的裸数据搬移(无动词副作用,同旧直接赋值)。ports 十项(haltContinuation/pauseClock/forgetCarry/resetNudge/releaseStaleTweakGate/appendFocusEntry/appendLedger/persist/syncTools/updateUI/nowIso),ledger 保持 best-effort try/catch。
- **goal.ts 接线(过渡 adapter,spec §4.3 步骤 1 允许)**:闭包 `goalsById/focusedGoalId` 与 state 代理替换为 lifecycle 持有;`setGoal`/`setFocusedGoalId` 退化为动词薄壳(调用方零改动);reconcile/loadState/complete-内联的 9 个 focusedGoalId 写点与 5 个整池替换全部改走原语;读点经 `lifecycle.focusedId`。
- **测试**:goal-lifecycle.test.ts 6 例记录式转移表(setGoal A→B 全序/null 清焦点 forget carry+双 clear/complete forget vs paused 保留/同 id 无焦点效应/focus 有效-无效-无变化/静默原语零副作用);**现有 502 node:test 零改动全过**(行为冻结验证,goal 套件 30/180 抽验)。
- **门禁**:check 0;vitest 935;node:test 508;contracts 43+3todo。
- **待续(checkpoint,下一轮从这继续)**:Step 2——update_goal complete 的内联块(goal.ts ~1768-1791:stopActiveGoal→turnStoppedFor→removeFromPool→appendFocusEntry→ledger→sync/UI)与 handleGoalClear/handleGoalAbort 的共同行为改为调用 lifecycle 动词(complete/terminate(kind)),保留 drafting 分支与提示差异;Step 3——confirmationIntent/tweakDraftingFor/turn flags/nudge 状态移入 lifecycle 封闭事件入口(restore/turn-start/tool-call/draft-*/agent-settled/dispose tag 各配 interface 测试),撤 releaseStaleTweakGate 回写;Step 4——撤过渡代理(goalsById 池引用别名、setGoal/setFocusedGoalId 薄壳),FakeHost 用例与转移表重复行的删减清单(先对拍零差异);全部完成后才可关闭 DEVIATIONS #73。基线:goal-lifecycle.test.ts 转移表 + 现有 508 node:test(已含 Step1 的 6 例)。

## 2026-10-08 C4-Step3：classifier-retry seam + flaky 测试确定性化（P2-1 3/3）

- **实现**:`classifier-retry.ts`——`ClassifierClock`(now/setTimer/clearTimer 注入,默认 real)+ `fakeClassifierClock`(advance 手动驱动、cleared 不触发)+ `runClassifierAttempts`(可见重试层机制:任意 transport 错误重试至 attempts 次,verdict 业务留在 gate)。`classifyToolCall` 的 per-attempt 超时 envelope、verdict cache 时间戳、abort listener 全部走注入 clock,finally 释放不变;`approveAutoTier3` 循环改用 runClassifierAttempts(重试条件/次数/fail-closed/降级语义逐字保留)。
- **测试替换**:index.test.ts「classifier retry loop is bounded(plan2 B2)」(AR1005-R3 flaky,真实 40ms 计时断言)删除;classifier-retry.test.ts 6 例确定性替代——attempts×timeout 逐次触发、timers 全部 cleared、abort-transport 按 SDK 语义 resolve(aborted)、冻结 wall clock 下超时仍生效。
- **验证**:check 0;vitest 928(+6-1);contracts 43+3todo;parity 零差异(golden 未动)。
- **台账**:DEVIATIONS #116 补记⑥;docs 模块表。
- **独立审查(同日)与修复**:审查结论=架构/协议达标,1×P2 行为分歧(tool_search 误加 denial 重置)+1×P2 测试缺口+4×P3。修复:P2-1 撤销 tool_search reset(decision table 同步钉住「不带 reset」);P3-4 删 applyPermissionVerdict 死代码;P2-2 新增 interpret.test.ts(端口分派/effects 顺序/结果透传,6 例);P3-3 矩阵补 5 族(then_run 字符串×2/R2 command 参数/proxy/非 MCP family),**增量 golden 在基线 worktree 2902384 生成且旧 47 case 再生成与原 golden 字节一致**;P3-6 abort-listener 释放断言。修复后 parity 52 case 零差异、三门全绿(vitest 935)。C4 终态 3/3 完成。

## 2026-10-08 C4-Step2：auto tier 梯子迁入 decide（P2-1 2/3）

- **实现**:decide 新增 auto 分支——embedded auto 扫描(sensitive/tier prompt)、tool_search/read/edit 敏感路径、edit cwd 内放行、bash tier1→1.5 allow(复合命令全段安全约束)→1.5b soft_deny→tier2,其余 defers to `classify` 决策(classifier seam);legacyAutoGate 整体删除(4514 字节旧代码离场)。采集层新增 embeddedAuto/bashTiers/commandSensitive/autoAllowMatched/autoSoftDenyMatched/tier3ReviewLabel 探测(全部内存纯函数)。
- **副作用保真**:旧 `allowToolCall()` 的 classifierDenialState 重置以 `AllowEffects.resetAutoDenialState` 建模——verdict-allow(auto 模式)与 auto 阶梯各 allow 点携带;bypass/plan/ask 的 allow 不携带(与旧代码一致);interpret 端口 `recordAutoAllow` 执行。
- **验证**:parity golden(未重生成)**零差异**——47 case 含 12 个 auto 案例全过;decision table 17 例;check 0;vitest 923;contracts 43+3todo。
- **台账**:DEVIATIONS #116 补记;docs 模块表 Step1 行更新于本 commit。

## 2026-10-08 C4-Step1：permission 裁决 module — bypass/规则/plan/ask 迁入 decide（P2-1 1/3）

- **对拍 harness 先行**(commit 6c01665):47 case 矩阵(模式×工具族×规则×UI,classifier 恒禁用)驱动真实 modes gate,记录 result+ui 对话框+notifications+持久化规则+session grant+family adjudication+outside-write 计数;golden 落自基线 2902384 旧 handler,两次生成字节一致;UPDATE_PARITY_FIXTURE=1 人工门。
- **实现**:`adjudicate.ts` 纯 decide(判定顺序表在头注释;bypass→rule deny→plan hard→verdict allow/ask(含 family 首见)→legacyAuto(过渡)→embedded(仅 ask)→plan allowlist→ask dispatch)+ `createPermissionAdjudicator(deps).check(call)`;`interpret.ts` interpretDecision 八端口(全部映射既有闭包函数);index.ts handler 退化为组装 facts→check;auto 分支(embedded auto 扫描+tier 梯子+classifier)逐字抽出为 legacyAutoGate,行为零改动。
- **验证**:decision table 12 例(adjudicate.test.ts);parity 对比 golden **零差异**;check 0;vitest 919(+13);contracts 43+3todo。
- **台账**:docs/{en,zh}/modes.md 模块表;DEVIATIONS #116;本条。

## 2026-10-08 C3：P3-1 S3 无 UI family 首见建议规则（D6=B）

- **实现**：`firstSeenPrompt` 无 UI 分支保留原拒绝前缀,追加 family `suggestAllowRule` 原样规则 + 「在父会话/交互会话预置后重试」指引;不写授权、不弹窗、不创建父会话转发请求(family 首见不进转发协议)。规则获取沿用既有 `match.family.suggestAllowRule`,未自拼 canonicalId。
- **测试**：p4-families 新增 S3 describe 3 例——headless 拒绝+规则+零授权(文件不变/无 session grant);subagent 无 UI(env 具备转发条件)同步本地拒绝且 forwarding 目录零请求;既有 allow 规则 headless 放行(钉新文案路径不阻塞)。基线红取证:撤回实现后 2 红(用例 1/2)1 绿(用例 3),恢复后 31/31 绿。
- **门禁**：check 0;contracts 43+3todo;vitest/node:test 见终批汇总。
- **台账**：CHANGELOG(P3-1 段)、docs/{en,zh}/modes.md S3 小节、DEVIATIONS #113 补记 S3 已实施、spec P3-1 状态行。本 commit 即 C4 对拍基线。

## 2026-10-08 C2：D4=B 删除 runtime reader（`./types` 纯类型化）

- **契约先行**：commit 62f3642 在契约表登记 D4-READER-REMOVE（撤除范围、保留面、迁移方式、验收手段、P1-BUS-02/07 关闭）。
- **实现**：删除 `types/core-status.mjs`、`CoreStatus` 接口与 `readCoreStatus` 声明;`exports["./types"]` 仅剩 types 条件;bus.ts 去 CoreStatus re-export。保留 CoreSnapshot/CoreCommand/CoreCommandResult、bus、legacy key、writeLegacyAliases。
- **测试迁移（D4b=A，断言意图不变）**：bus-channels/rules-wiring/memory 改读真实快照;bus-types 删 reader 总函数/回退链用例,孪生守卫直证真实 publish 形状 + instance(patch 不可覆盖);observation-sites ② 删 reader 白名单两断言。
- **B7 验收**：`test/contracts/types-subpath.test.ts` 3 例——外部 tsconfig fixture 编译 type-only 消费者(self-reference)、node 运行时 import 负例(ERR_PACKAGE_PATH_NOT_EXPORTED)、npm pack 清单不含 `types/core-status.mjs` 且含 `types/index.d.mts`。
- **门禁**：check 退出 0(main+contracts,fixture 同时被两个 project 编译);vitest 903(bus-types 5→3 用例,-2 为被删 reader 用例);node:test 502;contracts 43 passed + 3 todo(+3 为 B7)。
- **台账**：契约表 D4-READER-REMOVE 行、DEVIATIONS #115、CHANGELOG Breaking 条目(发布时 ≥0.4.0)、docs/{en,zh}/bus.md、AGENTS(.zh) 布局行、spike RESULT.md 归档注记。spec P1-1 状态行同步。

## 2026-10-08 C1：P0-2 锁策略 A + G3 落地（goal 回合锁收窄）

- **实现**：删除 `tool_call` handler 的 non-progress 误锁 else 分支（只有 pause_goal / abort_goal / update_goal complete(审计通过) / apply_goal_tweak 成功 execute 设 `turnStoppedFor`）；G3 进度例外读取从不存在的 `event.args` 修正为宿主真实 `event.input`（echo bash / 读 `.pi/goals/` 例外自此生效）。goalExtension deps 新增可选 `auditor` 透传 runCompletionAudit（与 audit flow 既有参数 seam 同构，生产留空）。
- **测试**：`extensions/goal/tests/goal-turn-lock.test.ts` 2→14 例。基线取证（实现前）：L1/L2/L5a/L5b 红（对应待修复项）、L3d 红（auditor 未透传走真实路径 19s）、L3a/b/c、L3a-neg、L3d-neg、L4、L7、L6×2 绿（钉现状）。修复后 14/14 绿。
- **门禁**：check 退出 0；vitest 905 + node:test 502 全通过；contracts 40 passed + 3 todo。
- **台账**：DEVIATIONS #114、CHANGELOG Unreleased、docs/{en,zh}/goal.md goal.ts 行、extensions/goal/FORK.md P0-2 段、spec P0-2 状态行。C1 revision 即 C5(goal lifecycle 迁移)的行为基线。

## 2026-10-08 决策确认与下一轮范围核对（文档更新，未实施新代码）

- 用户已确认 D3=A、D4=B、D6=B；前一批“待用户决策”记录为历史状态。当前续做：P0-2 锁策略+G3、P1-1 reader 删除、P3-1 S3、P2-1 三步迁移、P2-2 lifecycle。
- 源码/提交核对：core `2ebd226`，TUI `1bf9b7f`；usage 生产方真实提交为 **d539346**（下方旧批次记为 d1e8101，已在此勘误）；TUI 第二步已在 710c9c7/1bf9b7f 落地，不再等待上游/消费方实施。
- 本次实际门禁：core check 0；unit 905 vitest + 490 node:test 全通过；contracts 40 passed + 3 todo。TUI 272 passed / 0 skipped，typecheck 0。仅核对现状，不代表下一轮尚未实施的功能通过。
- 真实多 session drain、footer/usage/工具显示与 widget 顺序证据仍 open。TUI 新确认窗口回退混源 U-F1 单列后续修复；其余原批次已做部分不重复派发。
- 执行入口：`spec/2026-10-08-followup-execution.md`、`spec/2026-10-08-execution-prompt.md`；配对 TUI 同日后续规格。

## 2026-10-07 spec 批实施(9 份规格;P0-1/P0-3/P0-2 CORE-05/P1-1 可实施面/P2-4/P2-3/P3-1(除 D6)完成;P2-1 未实施)

- **P0-1 plan 权限优先级:完成**(3 commits:① d36828f plan-gate 搬移 ② 4cadd77 FUS-SHAPE ③ 本 commit 优先级翻转)。D1/D2 已拍板;红测试取证 9 例(T1-T6/T10/T13a-c,既有 820 全绿对照);T7-T9/T11 由既有用例+新 T15/T16 family 矩阵钉住;T12 plan-gate 单测 13 例。两处测试标题按规格补前提说明(index.test.ts fail-closed / p4-families D2b)。三门全绿。
- **P2-1 permission 裁决 module:未实施(0/3 步)**。纯架构重构零行为变化;P0-1 已铺好第一步(evaluateToolPermission/plan-gate/applyPermissionVerdict 三步结构),但本批会话预算不足以安全完成 3 步迁移+对拍 harness+decision table+用例删减闭环,有序推迟优于半成品 —— spec 文件已记实施记录。
- **独立审查(只读 subagent ×2 轮)**:首轮覆盖 09c2dcb..HEAD 全量 diff,两轴(spec 符合/仓库不变量)均 PASS,7 份已落地 spec 全部 CONFORMS;1 P2(reclaim 路径嵌套 claim 后缀,违反 P0-3 §3 名字语法)+3 P3(死导出/W-T6 过滤器无效/writeJsonAtomic 偏差未登记)→ 修复 commit 27ba11c。定向复审发现修复自身引入 1 个新 P2(eager claim 超出 QUEUE_DRAIN_MAX 搁浅候选)+1 P3 → 再修复 commit 4893ba2(惰性 claim + cap 序回归测试 + W-T6 简化)。复审确认嵌套孔全路径关闭、回归测试真实。三门终态:check 0 / 905 tests / 40+3todo contracts。
- **P3-1 小项:S1/S2/S4/S5/S6 完成,S3 待 D6**(3 commits:221ff55 S1+S5、07f7a62 S2、edb1e5b S4+S6)。S1 三 adapter 合一(测试注入统一单注入器+fallback 语义,15 对双设合并);S2 startPlanExecution 三转移合一(plan_ready 补 widget 同步+新断言);S4 两处 JSON 读取走 readJson+stat 指纹缓存(3 测试);S5 diff-file 删除+git status 单次采样;S6 死代码清理(goal 3 个无调用函数/不可达判断/未用 import/nudge 文案)。三门全绿 903。
- **P2-3 memory writer + drain:完成**(2 commits:① 7a006c0 writer+身份收敛 ② 本 commit drain 归位)。writer 三动词(write raw/memory、remove、reindex)+ 单向依赖 + W4 双身份命名;drain 编排搬 queue-drain.ts(ports 注入、DrainSummary 返回、automation 只聚合);ConversationPart 归 queue。W-T1..T6 + D-T1/D-T2 新增;memory-v2 全套断言零改动通过(编排等价证据)。可选的「消息文本扁平化」(§4.3)未实施 —— 明确记录为可选项跳过。
- **P2-4 结构化用量:完成**(单 commit d1e8101)。workingStatsEntry 拆两步(字符串格式化不变);refreshWorkingMessage 同一次 publish 写 workingStats+usage;publishCapability 以 "usage" in patch 区分保留/显式清空(session_start/tree/shutdown 三处清);sanitizeUsageNumbers 只发 finite 非负、必填缺失整体缺省、可选项不伪装 0;types CoreSnapshot.modes.usage 登记(CoreStatus/reader 白名单不动,归 D4)。U-T1/2/4/5/6 新增,U-T3=既有 ST 套件零改动通过。三门全绿。**生产方已就绪:TUI P1-2 第二步可消费 modes.usage**。
- **P1-1 bus 跨包面:可实施部分完成**(3 commits:契约表 ff0f7e7 → instance 320e7e5 → footer 本 commit)。instance 字段 + patch 不可覆盖 + dispose 终态(B1);契约新文件 bus-cross-package.test.ts 钉 XPKG-01/02/03/04/05 + XPKG-09-HOST todo;footer-lines helper(B4/B8)+ 降级时机改 session_start(B5 两套件改写)+ modes footer 渲染 display.footer(B6 含宽屏路径修复)+ 双语 bus/ui 文档。**D4 未决:reader/exports/断言原样保留**;B6 的 TUI 联合验收(两种加载顺序、off/on、reload 失败的真实槽位)待 TUI 侧配对 spec,core 侧接口已就绪。生产方就绪标记见 spec 实施记录。
- **P0-2 goal 回合锁:仅 CORE-05 落地**(L6 红取证后修复:sendMessage 抛错复位 confirmationIntent + syncGoalTools,与 tweak 路径对称;goal-turn-lock.test.ts 2 绿)。锁策略(L1-L5/L7)与 G3(args→input)按 D3 待决策整体暂缓,禁止单独合入字段修复 —— FORK.md 已登记边界。
- **P0-3 memory queue claim:完成**(契约表先行登记;Q-T1 基线红取证 `expected 2 to be 1`)。queue.ts 重写为单次 rename 所有权协议(claim/pending/GC token;claim 后重读;TTL+owner 探测回收;软预算不删活 claim);drain 编排改 claim→重读→路由/上限→bump→complete→apply→settle/release,每条出口 finally 终结 token;Q-T2/Q-T6/Q-T10 用真实子进程验证跨进程互斥与崩溃窗口;契约 disk-layout 钉 claim/pending 后缀形状。claim 套件 19 例 + automation 套件 51 绿。三门全绿。真机多 session 重叠 drain 属实机项,未做。

## 核心扩展性能与可靠性批(2026-10-05,spec 2026-10-05-core-architecture-reliability;11 项 AR1005 全量)

- **状态:11/11 项已实施并按项提交**(JS c05e4e1 → RC f70ffbe → AU ddbeac7 → FU 2d76e53 → GO-A 564d1f8 → GO-B 4601129 → RU 834d23b → ST 208882d → OB 07c34f1 → CL 6b09fb9 → RV b27e1c7)。Phase 0 基线在 76e933a 干净树取得:三门真实退出码全 0(check / vitest 54 文件 776 测 + node:test 452 / contracts 28)。每项缺陷测试先以 stash 方式在基线确认红(记录于各 commit message 与 DEVIATIONS #98-108)再转绿。
- **JS**:repair 改字符状态扫描(字符串保真,基线复现 `"literal ,} sequence"`→`"literal } sequence"`),候选改私有惰性 generator(整文/fence 成功 0 次 span 扫描;基线 2K/8K/32K 花括号 5.3/55.9/887.8ms → 0 扫描);span fallback 平方最坏情形按 AR1005-JS-03 保留并披露。
- **RC**:RecallMachine 增终态 dispose;每请求 generation+AbortController+timer+cancelled resolver(在途 await 即时返回 null;晚到完成零 history 读/零投递/零污染);onUserMessage total promise(入口/延迟段抛错收敛 null + 每失败请求至多一条 diagnose);deferred 仅在 deliver 同步成功后记账;wiring session_shutdown 任意原因同步 dispose + session_start 防御性 dispose + 重建/关闭先 dispose 旧机。契约 AR1005-RC-HOST:真实 ExtensionRunner + invalidate,晚到完成零发送零 unhandledRejection(基线红:SCENARIO_UNHANDLED + exit 2),隔离子进程由 bun 显式拉起。
- **AU**:封套顺序「内部取消结果→连接外部 signal→检查当前状态」,预中止不调用 auditor、返回既有 rejected outcome(started=被请求而非模型已启动);auditor session 创建一解决即全剩余生命周期 try/finally(subscribe/prompt/unsubscribe 异常均恰一次 dispose;创建失败不调不存在 disposer;超时后晚到完成只清理永不 passed);sessionAdapter 内部测试 seam。
- **FU**:新增 action-fusion/outcome.ts 纯解释模块 —— 结构化 details.thenRun 第一权威(生产 [then_run:succeeded] 现在真的显示成功徽标:旧扫描找的是生产从不写的 [then_run:ok];成功日志含相反 marker 不再翻转);文本兼容行锚定(独立协议行/text block 开头,不再任意行中子串;历史 ok alias 保留);render facts 能力探测(args 无 then_run 永不包装、partial 无终态;契约 AR1005-FU-HOST 编译期钉住)。
- **GO-A**:新增 goal/goal-accounting.ts 时钟模块(段起点+每 goal 毫秒 carry;settle 保留余数、preview 零副作用、pause 保留各 goal 余数、forget 释放);8×250ms 基线记 0 秒(红:actual 0 ≠ expected 2)修后记 2 秒;落盘仍整数 activeSeconds(冻结格式,重启至多丢当前段亚秒余数)。**GO-B**:accountProgress 持每事件读取上下文,聚焦文件每事件恰解析一次(基线 4 → 3;1/10/100 goal 每事件 N 解析、零额外聚焦读);零 usage 早退保持在 reconcile 后(外部取消/删除检测不跳过);writeActiveGoalFile 安全检查全保留。
- **RU**:新增 rules/activation.ts 累计预算模块(turn = turn_start→下一 turn_start,同 turn 全部激活共享 DYNAMIC_STEER_MAX;基线复现 3×6K=18,036 字符红 `expected 18036 ≤ 8000`);阶梯 全文→既有指针→短指针(完整路径)→本轮不发不标记(下次匹配重试);预留-发送-回滚单一同步过程(send 同步抛错回滚、重入不双花)。
- **ST**:新增 modes/working-stats.ts(cheap key = sessionManager 实例+sessionId+leafId;合法空 branch null 可缓存、getter 缺失/抛错不可缓存走旧路径);预热后 200 次 message_update 零 getBranch/getContextUsage(基线红 `expected 200 to be 0`;1K/10K/50K 同零,O(1) key 读/事件);失效表全接(session_start/tree/shutdown reset、compact invalidate、message_end markDirty、model_select usage 失效、turn_start/end force、before_provider_request 仅 forceUsage;turn_end 旧版同 handler 双读改单读);读取失败绝不缓存为成功空快照。ST-T03 对真实 SessionManager.inMemory 对照 brute-force 一致。
- **OB**:ProjectionState 稳定 placeholder memo(同 identity 键,值仅字符串+token;8MiB 热请求基线 ~26ms 构造 → 每 identity 恰 1 次,热请求 ~0.001ms);full-send 阶段零构造;ledger 失败保留 memo 但计数/节省不提交;每次 replacement 仍写 ledger 行(审计绝不跳过);placeholderConstructions 为状态上的诚实计数 seam。
- **CL**:applyMemoryOps 每 op 死读取 `existing = listMemoryFiles(dir)` 删除(引用检查确认零消费;batch 起始计数与真实存在/安全检查保留)。
- **RV**:prepareRun 规则发现改「workspace 重试落定后、以最终 workspacePath」(基线:调用仓无规则+目标仓有 → rulePaths=[] 并静默跳过 rulesheriff);manifest.rulePaths/ChangeProfile/路由/directive 消费同一 prepared 值;冻结相对路径数组形状不变;重试竞态取最终 workspace 规则;gh diff 权威/重试语义/local·diff-file 选择/config 优先级全保留。
- **对抗审查(REVIEW-2026-10-05-...-adversarial.md)**:R1(P1,已修复)— ST 强制快照以无 getContextUsage 的 host 调用使 usageFresh 被污染为 true,真机流式期 ctx% 行消失(fake ctx 无该能力故 460 项测试全漏);修复 = wiring 单一 statsHost 形状 + 模块侧能力缺席不再置 fresh + 回归测试钉住;R2 备注显式 epoch 以清键等价实现;R3 备注基线预存在的分类器时序 flake(本批未触碰)。审查结论 ACCEPT(修复后)。

**三门(最终)**:check 退出 0;test 55 文件 818 测全绿(vitest)+node:test 89/178/176/17/27(一次孤发 flake:modes 分类器重试时序测试,后续 3 轮全量不复现,非本批引入);contracts 31 通过 + 2 todo 退出 0。
- **登记与遗留**:契约表新增 AR1005-{ST,RC,RU,FU}-HOST 四行(先登记后测试);DEVIATIONS #98-108;CHANGELOG Unreleased 五段;docs en/zh 八模块同步。**遗留 todo(§13.2 协议)**:⑨ RU-HOST(真机 turn_start 每 turn 一次、同 turn 多工具共享)与 ⑪ ST-HOST(真机 message_end 先于 SessionManager append)—— 无法以受控 adapter 无付费调用驱动真实 run-loop(ModelRuntime 无自定义 provider 注入 seam),已按协议登记 + test.todo 指向宿主验收 + 契约注释内保留可执行人工步骤;两项实现均已双保险(RU 预算以事件为准、ST 以 leafId key 失效),正确性不依赖该时序,但按 §17 该两 fact 未取证前对应项的宿主时序证据项保持 open,待用户真机会话执行注释内步骤后回填。

## goal 用量统计增强批(2026-10-04,spec 2026-10-04-goal-cost-accounting;免计划对抗——用户豁免)

- **状态:已执行**。GoalUsage 增 costUsed(美元、浮点不 floor、老 record 回 0);parent 记帐增 usage.cost.total;新挂 tool_result 事件计 subagent/codemode 执行用量(修 2026-10-03 实证的结构性漏记);七个显示 surface(footer/oneLine/面板/compaction/pool/goal-achieved 行/归档报告)+ formatCostValue 三档格式化(≥$1 两位 / <$1 三位);新增 goal-cost-accounting.test.ts ×8。aborted 聚合路径同步带 cost。

## pi 1.0.x 适配批(2026-10-03,spec 2026-10-03-pi-1.0-adaptation;计划对抗 2 轮 R1 修订→R2 ACCEPT)

- **状态:已执行**。依赖矩阵全量升级(四 devDeps 1.0.1 + 三 peerDeps `<2.0.0`,floor 不动);唯一代码适配 = modes 测试 fake host 补 `registerToolRenderer` no-op;三门禁全绿(check / 774 test / 28 contracts,契约直面真实 1.0.1 包)。codemode 钉测试 ×2(ask 静默放行钉现状 + plan 快照/恢复共存)。DEVIATIONS #97;详见 CHANGELOG Unreleased 段。

## 架构巡查后续批(2026-10-03,spec 2026-10-03-arch-followups-batch;对抗审查 R1 REJECT→修订→R2 REJECT→定向复核 ACCEPT)

- **状态:已执行**。管线:总 spec → 计划对抗 2 轮(R1: C8 整文件跳过设计否决+3P2+10P3;R2: 抓出 sessionsDirFor 真机恒空的生产 bug → 修 spec 后 parent 定向复核,轮数封顶)→ 按序执行 → code 对抗审查(见下)。
- **C1** observation-pack identity/stored memo + ledger mkdir-once(5 新测)。
- **C7** recall 候选池复用(两次 derive 保留,RV-07 红线未破)+ conversationParts 尾部回走(补直测)+ memdir 1s TTL + 全写路径失效(store/consolidate/importers/测试 helper)。
- **C6** 渲染三件套 → goal/renderers.ts;oneLineSummary → goal-core;auditorRejectionBlock 统一(丢冗余门,DEVIATIONS #87;paused header 增 goalId)。
- **C5-B** ProfileController(profile-apply.ts,四保真点);**C5-A** alt+t → effort,decideCycleShortcut 纯决策(noop 零写入守卫修 probe 污染 bug,ctrl+shift+e 同修),modes 负例钉死无双注册。
- **C8** sessionsDirFor 包裹横杠修复(真机从恒空变为可用)+ async 有界读 + 三重上限(200/1MB 部分读/8MB)+ 透明度行(DEVIATIONS #90)。
- **随手修** readJson×2+死成员、glob memo(含同一性 pin 测试)、drain 并行、cast 三处收敛(DEVIATIONS #91)。
- **提交切分**:C1/C7/C6/C5-B/C5-A/C8/随手修 七个 commit(spec §7 逐条对齐)。
- **测试计数**:vitest 771 + node:test 全绿;contracts 28(直跑真退出码全 0)。
- **code 对抗审查**(flash 档 glm-5.3-flash,2 轮用满):R1 REJECT → 真实 P1 修复(session_recall limit-break fd 泄漏:挂起 generator 显式 iterator.return(),回归测钉住;drain 诊断单点聚合)+ 3a09f63;R2 ACCEPT(with notes)→ 抓出 R1 处置两处虚记(P3-2/P3-4 脚本未断言未落地),断言+grep 复核真正落地(DEVIATIONS #93);R2 report-only 两项采纳。审查文档:REVIEW-2026-10-03-arch-followups-code-r{1,2}-adversarial.md。

## 架构巡查批(2026-10-03,双轴 arch+perf review,方案见 ../specs/design/2026-10-03-arch-review-followups.md)

- **状态:已完成**(C2/C3/C4 落地;C1 判定为上游原设计非迁移 bug,修复待拍板;C5/C6/C7 探查结论已沉淀 spec 文档;C8 方案已规划待批)。
- **C2 compact→queue seam**:automation.ts 抽出共享 `stageUnextractedTail`,compact/shutdown 同 seam 零 LLM;测试 2 重写 + 44 全绿;docs en/zh model 描述同步;DEVIATIONS #85。
- **C3 utils 拆分**:modes/utils.ts(1247 行九概念)→ bash-analysis/path-safety/outside-writes/plan/mode-prompt/auto-risk/ui/format 七模块,utils.test.ts 按序 describe 同构拆七份;消费者 9 文件 import 改向;disk-layout 契约仅改 import 不改断言;docs en/zh modes 表更新。纯搬移零行为变化。
- **C4 json-lift 归一**:lib/json-lift.ts(jsonCandidates/liftJson/repair/balancedObjectSpans)取代四套漂移实现(classifier-client 最强版为基底);修 selector 字符串感知 bug(回归测 13b);test/lib/json-lift.test.ts 13 测钉 canonical 顺序;DEVIATIONS #86。
- **测试计数**:全仓 762(54 文件)+ contracts 28 全绿;check 双项目 tsc 通过。
- **剩余风险**:C4 的 review 兑底行为放宽(见 #86 ③)无现测试钉 — review 25 测通过但未新增形状用例;C5 的 probe-write 污染 bug 仍在(修法已探明,待批执行)。

## memory 召回 v2 批(2026-10-02,spec 2026-10-02-memory-recall-v2 R1 + 附记 A.1)

**状态:全部完成。R1/R3/R2 各自单独提交;R0 已按协议执行完毕(用户 2026-10-02 批准「可以执行了」):6 文件迁移(备份于 ~/.pi/agent/memory/.backup-2026-10-02/,逐文件复制+字节核对+删原件)+ 4 文件 paths: 作用域化(pi 生态)+ pi-subagents 项目层按建议新建;验收复算泄漏 17→0(replay v3,31 session 池);project 层 reinject-symptom 已改写为 RC-1×RC-2 结论并清双 frontmatter。**

- **R1 投递重构(D1/D9)**:context 钩子删除;召回 = 每条真实用户消息至多一次,持久化为 `pi-memory-recall` custom message。prompt 路径(before_agent_start 返回 message)+ steer 路径(message_end → 挂起 → 首个 continues=true turn_end 经 sendMessage triggerTurn:false 投递)+ agent_end 中止/清理。全部会话态从 buildSessionProjection 历史推导(硬判重 RV-06 / 已读 RV-07 / 字节预算 RV-08 / recentTools RV-13)。
- **R1 选择器(D3/D6)**:`selector.ts` LLM 清单判断(新→旧 ≤200 行,recentTools 反噪音,宁空勿滥);`memory.recallModel` 必须显式配置,未配置/无法解析 = 不召回(无词法回退);`recallWaitMs` 默认 4000 钳 0-15000。
- **删除**:selection.ts / recall-session.ts / context 钩子 / tool_call markRead 分支;新增 recall.ts(深模块三入口)+ selector.ts;llm.ts 抽出 completeText 共享车道;`RECALL_*` 常量入 lib/context-budget.ts(不发布上 bus,DEVIATIONS #77)。
- **附记 A.1 评审增量全落**:① host-semantics ⑥ 钉真实包 buildSessionProjection 的 custom_message details 存活;② RecallDetailsV1 加 elapsedMs;③ automation 双 frontmatter bug 修复(hoistLeadingFrontmatter,红绿钉住,DEVIATIONS #78);④ docs 两句已知代价(before_agent_start 串行等待、子进程每 dispatch prompt 一次选择器调用)。
- **测试(replace, don't layer)**:新增 recall.test.ts 11 用例 + memory-llm-selector.test.ts 4 组 + memory.test.ts RV wiring 5 用例;契约登记 P0-CT-08 `pi-memory-recall` 行(先登记后写测试)+ status-entries 冻结 pin;FakeHost FAKEHOST-02(projectionMessages + hasPendingMessages)。删除/改写清单见 DEVIATIONS #74-75。
- **R3 分层治理(RV-14/15/16)**:lib/glob.ts 上提(rules re-export);paths: 内联列表解析 + eligibleMemories/policy 索引按 git canonical root 过滤(scopeMatches 含目录本体匹配,DEVIATIONS #80);automation 三提示词注入当前项目名 + 路由规则 + WHAT_NOT_TO_SAVE;store apply 层 user→project 重路由(projectKey 启发式)+ AutomationState.routed;/memory 错层诊断(misplacedUserFiles);importer 外项目条目改路由到对应项目层(缺失 = skip+注明,migration 两用例改写,DEVIATIONS #79)。
- **R2 评测工具**:`test/spikes/recall-eval.ts`(JSONL 标注集在仓库外,--model 或 memory.recallModel,provider env 凭据;输出 precision/recall/empty 正确率/p50·p90)。跑标注属 R2 后续,需用户提供标注集。
- **R0 执行记录**:worklist 12 项呈报两轮 + pause/resume 后用户明示批准。错层诊断剩余 5 条均为启发式误报(通用尾段键 "review"/"test"/"gd32" 撞词)或用户拍板保留的全局记忆(work-style 提及 CherryDev)——真阳性 0;该启发式的噪音profile 已知,属 advisory 工具非 gate。
- **剩余**:R2 跑标注(需用户提供标注集,属 spec 后续非本 goal 范围);真实运行时冒烟(用户侧,配置 memory.recallModel 后验证)。

## goal notes 批(2026-10-02,用户直接请求,无 spec)

**状态:实现完成,三门全绿(check / vitest 735 / 契约 27 / goal-notes 5 用例)。**

- `/goal-resume <text>` 尾注不再被丢弃:一次性 `<resume_note>` 随 resume 后首条 checkpoint 带出,sendFollowUp 消费(goal.ts pendingResumeNote 内存态——one-shot 不落盘)。
- 新命令 `/goal-note`(贴/清 standing note):GoalRecord.userNote 持久字段(normalizeGoalRecord 解析),`<user_note>` 随 goalPrompt + continuationPrompt 带出,get_goal/detailedSummary 展示;agent 不可写。
- **批 2(同日)**:pause/abort/clear 尾注 — pause 注 → `pauseReason`(user: 前缀,paused 提示向模型展示,honor 措辞;pauseReasonLabel 单一标签权威);abort/clear 注 → `goal_aborted` ledger 事件(user aborted:/user cleared: + archivePath,补齐用户终止路径的审计空白);/goal-focus 按用户决定保持纯选择器(禁参数直选)。
- 测试:extensions/goal/tests/goal-notes.test.ts(6 用例,纯 seam:record 往返 + prompt 注入 + 标签)。

## memory 退出零 LLM 批(2026-10-03,spec 2026-10-03-memory-exit-flush)

**状态:实现完成,三门全绿(check / test 748 / contracts 28);DEVIATIONS #84;两轮 subagent 审查(classic REQUEST_CHANGES→全修 + 对抗 A1-A3/B1 击穿→全修,报告存 specs/REVIEW-2026-10-03-memory-exit-flush-{classic,adversarial}.md)。**

- 根因:宿主串行 await 全部 session_shutdown handler 无超时兑底 + 主模型(glm-5.3)实测 11-12.4s(cache 命中仍 10.5s,瓶颈=生成)→ 每次长会话退出必卡满 10s。
- shutdown 零 LLM:cursor 相对后缀 60 条原子落盘 `~/.pi/agent/memory-queue/`(queue.ts 新文件,P0-CT-09 登记行 + disk-layout 行为断言);下一同项目 session_start 后台 drain(≤5 条/次、≤3 次/条、attempts 前置持久化、projectsDir 精确路由、7 天/2MB GC、apply-fatal=消费、unparsable=删、写失败黑名单)。
- A1 现存 bug 修复(对抗审查发现):session_start 重置全部每会话闭包态 + 换新 AbortController —— 原实现在进程内 /new,/resume,/fork 后 automation 全部静默死亡。
- side-channel 模型链:model → recallModel → 会话模型(llm.ts resolveModelRef 单一实现,selector.ts 委托,D3 不动);本机 settings 已配 memory.model=CPA/model-fast。
- compact flush 保留;queue 明文副本/跨项目驱逐/B5 重叠披露于 docs。
- 方案 3(fork 重放)规划文档:specs/design/2026-10-03-memory-fork-replay-plan.md(不实现)。

## recall v1.2 零阻塞投递批(2026-10-03,cctui handoff §3 诊断驱动)

**状态:实现完成,三门全绿;DEVIATIONS #83。**

- 默认 recallWaitMs 4000→0(prompt 路径永不阻塞上屏);挂起选择完成即投递(deliver 端口 → sendMessage triggerTurn:false → pi pending 队列 → 下一个 turn_end 落盘);onTurnEnd 删除;agent_end 不再 abort。display:false 隐式性经 vanilla(interactive-mode live+resume)+ cctui(不碰 custom message 通路)双源核证。

## core 工具渲染器批(2026-10-02,spec 2026-10-02-core-tool-renderers)

**状态:实现完成,三门全绿(check / 47 文件 735 用例 / 契约 27 / 渲染器 14);cctui 侧接手(typecheck + 90 用例全绿,各自单独提交)。**

- **A obs_recall**:`observation-pack/renderers.ts` + registerCall/Result 接线——短 id/人读 offset 调用行、分页头(size·lines·range)、协议头剥离(details 在场才剥)、5 行预览/expanded 全量、lastComponent 复用。
- **B then_run 徽标**:`action-fusion/renderers.ts` —— Container 包装追加 `↳ then_run: cmd` 调用行 + marker 只读扫描的着色状态行;零包装规则。
- **C core 工具**:`memory/renderers.ts`(session_recall 摘要行 + 首条指针;memory_consolidate applied 行);`lib/tool-render.ts` 共享 helper(ThemeLike 结构化,humanBytes,renderRows)。
- **D cctui 接手**(pi-claude-code-tui 仓库):FORCE_RESULT_EXEMPT += obs_recall;force 调用行 obs_recall args 短化;then_run 徽标在 force 模式重述(包装 ccCall 组件 render 追加行)。
- 偏差台账:#81(emoji 弃用、包装式实现)。

## goal-hijack 修复批(2026-10-01,spec 2026-10-01-goal-hijack-fix)

**状态:实现完成 + 对抗 review 通过折入(v1.2,F1-F9 全处置:runner env 纪律/GH-04 断言/台账同步),三门全绿(常规与模拟子代理 env 双复验)。**

- **GH-02** `loadState` 子会话跳过磁盘收养 + **GH-02b** `reconcileFocusedGoalFromDisk` 同判定返回(补充守卫:命令/工具路径 mid-session 重读盘,实施中发现);**GH-03** `queueContinuation` 顶部早退(双保险,五调用点)。
- 探测复用 `modes/permission-forwarding#isSubagentChildProcess`(goal→modes 跨模块 import,无环;PI_SUBAGENT_* 只消费,P0-CT-06 边界不动)。
- FakeHost 补 `idle`/`hasPendingMessages` ctx 选项(既有 fidelity 缺口:缺 hasPendingMessages 时 product try/catch 吞 TypeError,续跑在 fake 从未武装)。

## memory 召回修复批(2026-10-01,spec 2026-10-01-memory-recall-fix v3.1)

**状态:实现完成 + 对抗 review 通过折入(v3.2,findings F1-F11 全处置:1 major 补计费守卫测试、F4/F5 两处代码缝隙修复、其余文字/nit),三门全绿复验。**

- **MR-01/02/03** per-turn pin & re-project:`pinnedTurn` 状态,turn 首个 context 事件选取+pin(查询=最后一条非 customType user 消息),turn 内逐请求重投影字节级同一块;`before_agent_start` 清 pin,`session_compact`/`session_start` 全量重置。删除 `surfacedRecallKeys`(宿主源码取证:投影 request-ephemeral,反查永远空集)。
- **MR-04** 双域匹配:primary(title+description ≥2)或次级(≥1 且 body ≥2)入选,body 仅 tiebreaker;body-only 永不入选。
- **MR-05/08** `surfacedKeys` 计费化(每文件每 session 一次,`isPrePaid` 谓词不再消耗剩余预算);read 抑制保留。
- **MR-09** 缓存纪律:尾部追加不变量、turn 内字节稳定、systemPrompt 索引字节稳定(三守卫用例)。
- **用例翻转**:memory-v2-storage AD1 用例改写为 v2 语义;mode-inherit.test 预存隔离 bug 顺手修(ambient env 泄漏)。
- 新增 describe `MR memory-recall fix v3.1` 8 用例 + isPrePaid 直测。

## 二轮深审修复批(2026-09-22,REVIEW-II)

**状态:实现完成 + 对抗审计通过(红队 3 subagent:真实性轴全绿,回归轴 4 残留已修),三命令全绿,已待 commit。**

来源:code-review skill 双轴全量深审(4 并行子代理 + 关键发现亲验)。处置面:Spec 轴 4 应修全修 + Standards 轴 11 应修全修 + 实质性建议项;台账 #48-#61 连号(DEVIATIONS)。分组:

| 组 | 内容 |
|---|---|
| Spec 语义 | S1 effort 兜底翻转(§3.3 兑现,resolveEffortForMode 无显式→undefined,modes 守卫成真,2 用例红绿翻转);S2 settings/model-id 收敛补完(P0-LB-04「P2 收尾全收敛」兑现;PLAN §1.4「×2 份」表述失实记录);S4 memory 通道 readCoreStatus 断言补真(#47b② 闭案);S5 特异度分层(精确>server 前缀>裸 mcp_*);S6/C5 RuleFamily.matchesRule+familyRuleMentions(web ask 走全弹窗、deny 展示真实规则+source);S3 web 认领限定 mcp 形态;S7 flag pin 提示;S11 defaults 文案 |
| memory 核心 | C1 CJK bigram 分词(中文 lexical 注入从不可用变可用,最重发现);C7 字节口径统一(byteLength 全面);A4 缓存键控+namesKey 失效;A5 scanMemoryDirCached 指纹缓存+git root memo(每 turn 3 遍全文读→零内容读) |
| memory 其余 | C2 secret regex(无引号/base64 padding);C8 readLines UTF-8 边界 withhold;C10 customType 过滤;C11 导入不覆写本地编辑;C9 query 移除+子域名预批准;C13b reset 文案 |
| mcp/web-gov | C3 broker 复用 canonicalize(native 前缀不再误拼);C4 mirror 防重入+shutdown 清理;A3 面板 ruleValueText;A7 ALL_LEVELS 加 max;C6 appliesNow 口径(fake-host 防御) |
| lib/rules 小项 | rule-text 去反向依赖(structural 内联);readJson onInvalid throw 传播;A8 steerRule 提取;A9 死参数+globalHome env 默认;C13a 降级净增守卫;review-run/paths 死代码清理(#46 闭案) |

- **测试**:vitest **574**(558 + 深审新增 12 + 对抗审计新增 4)+ node--test **312**(72+75+165,断言零改动)+ 契约 **17**;`bun run check` exit 0。
- **对抗审计批(#62)**:红队抓出 4 项修复残留并修毕——C8b(4 字节 emoji 边界,回扫上限 3→4)、C11b(hermes invalid 本地文件覆写,existsSync 化)、C13ab(小预算 break 出口超预算,整块丢弃最小块)、C1b(虚词 bigram 停用词 + bigram 分支补过滤);顺手:broker probe 前 stop、globalHome 惰性。挂账疑点 5 项记录于 #62。
- **用例翻转(行为变更,均 spec 背书)**:profiles「defaults to medium」→「returns undefined」;index.test 两处 applyProfileModelForMode 断言 medium→off;p4 webfetch 认领→null、extractHost query→null。
- **挂账(#61)**:rule-families 四职责拆分、yield 标记 systemPrompt 语义真机验证、空 diff 守卫顺序、C6 无独立单测。

## REVIEW-2026-09-22 修复批(codebase-design 规划)

**状态:处置完毕,复查通过(2026-09-22,一轮有条件 PASS + 补修),已 commit。**

### 修复分组(deep-module 视角:散点知识收敛进汇聚点)

| 组 | review 发现 | 处置 |
|---|---|---|
| A 放行链 | #11(Minor 最重)+ #38③ | 一次性 Allow 记录点收敛到 `applyApprovalDecision`(交互/转发/规则 ask 三路必经的汇聚点),`allow_always_*` 落盘后记 rule-allow;step-2 allow 分支复用同一 helper;新增端到端用例(显式 ask 规则 → Allow → adjudication 在 → mirror allow_once) |
| B rules | #13 #14 #15 #16a/b/c | 降级循环核算全部输出字节(段头/连接符/尾注预留),预算改精确断言;降级次序「条件 fold-in 先降」对齐 spec;首触 steer 超 DYNAMIC_STEER_MAX 改按需 Read 指针(不截全文);指纹升级文件级(mtimeMs+size,内容编辑可见);tool_call 复用指纹缓存(collectRules 结果随缓存,零额外扫描);activatedNames 不随指纹清空 |
| C memory | #17 #18 | 可写探测 accessSync(W_OK);不可写真降级 policy-only(不注索引);chmod 555 测试落地;reconciler 热路径零内容读(entries 走缓存) |
| D lib 收敛 | Standards #4/#6 + 真实 bug | 新增 `lib/rule-text.ts`(ruleValueText/ruleMatchesId/isInsideDir),替换 4 份提取、2 份尾通配、guard 裸 startsWith;25K 常量统一 MEMORY_INDEX_MAX。**修实真 bug**:parser 对象 ruleValue 经 `String(.value)` 提取失明(持久规则对 first-seen/ruleMentions 不可见) |
| E 清扫 | Standards #1/#2/#3/#8/#9 + Spec #3/#6/#7/#20 | resolve 序 stale 注释 ×4、check.mjs 消息(成功路径保留输出)、types 注释旧文件名、memory/memdir/importers/paths/render 死代码与投机参数、`@/abs` 双斜杠、overlay 死 disable、planPhase 生产者补齐、fresh-clone 守护(check.mjs)、effort-owner d) 用例实化、session_recall 空文案口径(web-gov 注册序注释与 void ctx ×2 属复查二轮补修,见 #47b) |
| F 台账 | #1 #8 #9 #10 #12 #19 | #20 引证改本地 ec2bcbe;FORK.md 命令族 14 枚举补全;goal bus 发布移出 hasUI 门控(与 review 通道对称;**复查二轮补修——初版虚报**)、direct 形态配置 seam(`PI_CORE_MCP_DIRECT_SERVERS`)+ README 注明;contextBudget/memory 通道 readCoreStatus 断言(**复查二轮补修——初版虚报**);随机性质测试(seeded PRNG ×10:≤budget + 字节确定);rules↔pm/goal 共存测试(append-only 不碰既有标记);chmod 测试 |

**择优认定(不修,已挂 DEVIATIONS #47)**:#5 写入即 0600(安全正向)、#4 malformed mtime 缓存内不 re-warn(诊断降级)、Standards #8 的 context `as never`(类型面成本)、#12 的 env 配置 seam(已接)。

### 测试计数

- vitest **557**(554 + review #11 端到端 + plan/auto 首调 + chmod + 随机性质 + 共存 + B1 ask-vs-allow 断言)+ node--test **312** + 契约 **17**
- `bun run check` exit 0(含 fresh-clone sibling 守护)

### 复查结论(2026-09-22,新鲜眼 subagent,一轮)

**有条件 PASS → 补修后达门槛。** 复查亲证:28 条中 21 条真实修复(A 组全、C 组全、D 组主体含真 bug 修复成立、E 组 7/9、F 组部分);两个 PARTIAL(#13 块间连接符欠账、#16a 双扫→单扫)均 Minor 且无红线击穿;三命令全绿、契约与 441 随迁零改动。

- **复查抓出四处自报失实**(python replace 静默失败再现):#10 goal bus 门控、通道断言、web-gov 注释、void ctx ×2——**全部已补修**,台账以 #47b 修正并记录教训(「已修」自报必须实测背书)。
- 顺手补修:#13 连接符核算、#16a 激活热路径真零扫描(cachedRules 内存匹配)、mirror allow_always 写失败 fail-closed、check.mjs 成功输出、两处幽灵注释。
- 挂账:allow_always 写失败深化(P4-MC-02)、MC-05 floor、MC-06 inventory 链(已在 #38)。

## P4 — mcp-gov + web-gov(1.3.0,本次不发)

**状态:实现完成,复查通过(2026-09-21),已 commit(未发版——1.3.0 + deprecate 留用户)。**

### 交付项与 spec ID 对照

| spec ID | 内容 | 状态 |
|---|---|---|
| P4-FAM-01 | RuleFamily 扩展点:modes/rule-families.ts registry;evaluateToolPermission 在 mapPiToolToCcTool 未命中后、passthrough 前遍历;verdict 折算进既有 behavior 契约(step2 消费机制零改动) | ✅ |
| P4-FAM-02 | 首见弹窗语义:ask/plan/auto 经 step2 统一(先于 ladder);plan 的 mcp 不在 PLAN_READ_TOOLS 天然不进只读 carve-out;auto 下 family verdict 先于 classifier;非 mcp 未知工具不受影响(direct 命名 knownServers 白名单,宁漏勿误) | ✅ |
| P4-FAM-03 | suggestAllowRuleForToolCall 委托 family | ✅ |
| P4-FAM-04 | 红绿:ask mcp first-seen 弹窗(原静默放行);Allow once/session/always 三路;非 mcp 未知工具 ask/plan passthrough 不变 | ✅ |
| P4-FAM-05 | sessionGrants:内存 Set;session_start/shutdown 清;first-seen「Allow for this session」写入;/permissions 列出 + /permissions-clear-grants 清除 | ✅ |
| P4-FAM-06 | web-gov 第二 family 注册进同一 seam | ✅ |
| P4-MC-01 | canonicalize 三形态(native 前缀/proxy input.tool/direct+knownServers);resolve deny>allow>ask 前缀匹配 | ✅ |
| P4-MC-02 | Allow always 落盘复用 addPermissionRule(global);建议 `mcp_exa_*`;写失败 fail-closed | ✅ |
| P4-MC-03 | broker 镜子:同步纯 decide(五支放行链:adjudicated→bypass→rule→sessionGrant→allow_once,否则 fail-closed deny 计数);noteAdjudicated 单点记录(gate allow 路径 + first-seen 各放行分支) | ✅ |
| P4-MC-04 | 一致性矩阵:5 结局 × bypass 两态(gate 放行⇔mirror allow;deny 计数) | ✅ |
| P4-MC-05 | McpEventPort seam:动态 import 探测(本机 adapter 未装 → absent idle 零副作用,实测路径);版本降级(未知字段忽略) | ✅ |
| P4-MC-06 | /core 面板 MCP 段:live snapshot ‖ readStaticMcpInventory 降级 + 规则摘要 + install hint | ✅ |
| P4-MC-07 | 首查:本机无 pi-mcp-adapter,claim 语义无法实测——按 spec 风险①预案实现(架构不变;callId 不依赖,canonicalId 走 server/tool;记 OPEN-QUESTIONS) | ✅(按预案) |
| P4-WB-01 | createWebRuleFamily:URL 工具→host;`webfetch(domain:host)` 规则(显式规则 > 预批准) | ✅ |
| P4-WB-02 | 预批准域名清单(builtin 14 域)可经 pi-core-web.json 覆盖 | ✅ |
| P4-WB-03 | D7 落地:README exa 接入引导;defaults 搜索文案改定版「exa MCP 优先」;pi-web-access 退役用户侧 | ✅ |
| P4-WB-04 | Sources 尾注规则已在 P3 defaults(P4 不重复实现) | ✅ N/A |
| P4-REL-01 | 发 1.3.0 + 旧四包 deprecate:用户侧 | ⏸ 用户 |

### 测试计数

- `bun run test`:vitest **553 passed**(P4 新增 16)+ node--test **312 passed**
- `bun run contracts`:**17 passed**
- `bun run check`:exit 0

### 剩余风险

1. P4-MC-07 两项(broker claim 同步性/approval callId)未实测(本机无 adapter)——mirror 架构对两者免疫(同步纯函数 + canonicalId 走 server/tool),真机验证归 P4-REL 冒烟。
2. /permissions 的 grants 展示为文本段 + 独立清除命令(非交互清除),v1 可接受。

### 复查结论(2026-09-21,新鲜眼 subagent)

**PASS(修复后)— 达 commit 门槛。** 三命令实测全绿、计数精确对账;modes diff 审计干净(全部 hunk 属 family 机制所需,441 零改动);契约零变化;absent port 零副作用经真机探针证实。

- **阻塞发现(已修复)**:B1 resolve 序 deny>allow>ask 违背 spec「deny>ask>allow」(显式 ask 被 allow 前缀吞)——mcp/web 两处改序 + 断言。
- 非阻塞修复(已随本次处理):mirror bypassActive 生产断裂(setBypassIndicator 同步);session_shutdown 清 grants;WB-01 注册序(web 先于 mcp,域名规则优先);ruleMentions 尾通配;矩阵注释诚实化 + uiPrompts≤1 断言;plan/auto 首调弹窗端到端(红队 #2 增补态);PROBE 残留;OPEN-QUESTIONS #6(P4-MC-07)与 README knownServers 注明兑现。
- 挂账(DEVIATIONS #38):MC-05 版本 floor、MC-06 inventory 链/cached、FAM-05 转发计入结构性不可达。
- 遗留:P4-REL-01(1.3.0 发版/deprecate/真机 exa+bypass 冒烟)用户侧。

## P3 — rules 引擎 + memory 模块(1.2.0,本次不发)

**状态:实现完成,复查通过(2026-09-21),已 commit(未发版——1.2.0 留用户)。**

### 交付项与 spec ID 对照

| spec ID | 内容 | 状态 |
|---|---|---|
| P3-RU-01 | 四层优先级 builtin<global<compat<project;project/compat trust 门控;同名 shadow(render.ts collectRules) | ✅ |
| P3-RU-02 | frontmatter name/description/globs/always;** 退化 always;无 frontmatter=always(scan.ts) | ✅ |
| P3-RU-03 | @include 四形态;缺失静默;环重访丢弃;深度 5;include 体在前(scan.ts expandIncludes) | ✅ |
| P3-RU-04 | 预算 40K:内联超限降级最大 always→索引;索引整行尾部丢弃;单文件>4K 只索引;>40K 整体剔除;绝不截中部 | ✅ |
| P3-RU-05 | total function:缺失目录 0 贡献;坏文件静默+尾注 `skipped N invalid`;字节级确定 | ✅ |
| P3-RU-06 | before_agent_start append-only systemPrompt(不动 contextFiles) | ✅ |
| P3-RU-07 | 索引+首触 steer(tool_call 捕获 path→glob 命中→sendMessage steer;每规则每 session 一次;session_start 重置) | ✅ |
| P3-RU-08 | mtime 指纹缓存;stat 计数断言(unchanged turn ≤3 = dir 数) | ✅ |
| P3-RU-09 | /rules 只读输出(名称/scope/globs/预算占用/激活数) | ✅ |
| P3-RU-10 | lib/context-budget.ts 静态切分 + bus `contextBudget` 可选通道(rules session_start 发布;reader 透传) | ✅ |
| P3-RU-11 | 文件布局 index/render/scan/paths/defaults(~700 LOC);paths.ts 的 session 历史挖掘未实现(不在行为规范,见 DEVIATIONS #29) | ✅ |
| P3-RU-12 | v1 无 setEnabled/lint/subscribe(工厂壳接口不变) | ✅ |
| P3-RU-13 | 首查:①input.path 实测确认(read.js schema `path: Type.String` + pm 同款用法);②parallel steer 以 0.85 文档语义实现,真机冒烟归 P3-REL(见 DEVIATIONS #28) | ✅ |
| P3-ME-01 | 磁盘格式 CC 1:1(memory/<slug>.md + MEMORY.md;git-canonical-root;pi 同款 sanitizer) | ✅ |
| P3-ME-02 | reconciler:≤200 行/25KB+WARNING;mtime 短路;坏 frontmatter 排除+skipped 计数 | ✅ |
| P3-ME-03 | policy 注入(自写 POLICY_COMPACT)+ capped 索引 entrypoint | ✅ |
| P3-ME-04 | selectForTurn lexical(阈值 2,≤5 文件×4KB,session 60KB,新鲜度头,不落 session);session_compact 重置 | ✅ |
| P3-ME-05 | 写路径=plain files;guardMemoryWrites secret 拦截器(7 类 pattern);无 memory_write 工具 | ✅ |
| P3-ME-06 | InjectionGate 双探测(静态 npm/settings 扫描+动态 `<memory-policy` 标记);只管注入;结果上 bus memory 通道 | ✅ |
| P3-ME-07 | session_recall 工具(AND 匹配,流式扫,toolResult 不命中,坏行计数,limit≤50,只读) | ✅ |
| P3-ME-08 | /memory-import-claude(不信源索引)+ /memory-import-hermes(§ 拆条+type 启发式);双跑幂等 | ✅ |
| P3-ME-09 | 降级与韧性:notifyOnce、注入 try/catch 永不阻断 turn、空目录友好文案 | ✅ |
| P3-ME-10 | v1 不做 provider seam/双工具/LLM(设计定稿) | ✅ N/A |
| P3-ME 首查 | ①hermes 本机在装(实测 node_modules 命中)→ 静态探测路径真实;②lexical 标定回放 CherryDev 存量 81 文件(见 DEVIATIONS #27) | ✅ |
| P3-PM-01 | modes carve-out(ask-ladder write/edit 分支+promptWithPermissionOptions 漏斗;路径特判);红绿 3 例(免审批/外仍弹/secret 仍拦) | ✅ |

### 测试计数

- `bun run test`:vitest **536 passed**(441 modes + 31 lib + 26 P1 + 5 P2 + 33 P3:rules-render 11 + rules-wiring 6 + memory 12 + carve-out 3 + review-degradation 3 中的 P3 无…… 精确列:11+6+12+3=32 新增) + node--test **312 passed**
- `bun run contracts`:**17 passed**
- `bun run check`:exit 0

### 真机冒烟(P3 可做子集)

lexical 标定回放(真实 CherryDev 存量 81 文件)即本 Phase 真机数据冒烟:强重叠命中目标文件、无关 prompt 零注入。P3-REL-01 完整清单(放规则生效/steer 可见/hermes 双装无双重注入)需发版后用户侧执行。

### 剩余风险

1. lexical 阈值 2 首日偏召回(标定实录:1 prompt 召回 3 弱相关,被 5 文件上限钳制);推翻条件(误报高烧预算)触发时升 3。
2. parallel tool mode 下 steer 送达批次未真机验证(按 0.85 文档实现);P3-REL-01 冒烟项。
3. rules 的 project/compat trust 门控在 wiring 层默认 true(pi 上游有 project_trust 事件门控扩展加载),若 pi 语义变化需跟随。

### 复查结论(2026-09-21,新鲜眼 subagent)

**PASS(修复后)— 达 commit 门槛。** 三命令实测全绿且计数精确对账;modes diff 审计确认 carve-out 仅 18 行、441 测试零改动;契约断言零变化;P3-PM-01 联合红绿为真实双模块链。

- **阻塞发现(已修复)**:①P3-RU-04「绝不截内容中部」红线——收尾 slice 硬截 + 尾注超预算,已改为降级循环核算全部字节(含尾注预留),测试容忍收紧为精确 ≤budget;②调试残留 PROBE9 已删。
- 非阻塞修复(已随本次处理):>4K globs 规则首触永不 steer 且永久标记(steer 改取 collectRules 原文);动态 yield 翻转后 bus 快照不更新(补 publish);extraDirs 静默失效(collectRules filter);contextBudget/memory 通道零断言(补两条);深度 6 专项(红队 #11)补 fixture;60KB 预算耗尽 + session_compact 重置补断言;session_start 探针与 session_recall 的 cwd 口径统一;lastInjectedFiles 只写不读删除;5 条未申报偏差补台账(#32b)+ #31 残留补修(#31b)。
- 遗留:parallel steer 真机冒烟归 P3-REL;lexical 阈值推翻条件记录在案。

## P2 — pi-goal fork + pi-review 整体并入(1.1.0,本次不发)

**状态:实现完成,复查通过(2026-09-21),已 commit(未发版——1.1.0 + CCTUI 1.5.0 留用户)。**

### 交付项与 spec ID 对照

| spec ID | 内容 | 状态 |
|---|---|---|
| P2-GO-01 | fork 入树 extensions/goal/(基线 ec2bcbe = npm 0.6.0 内容);FORK.md 完整(基线 hash/npm 0.6.0 比对/差异清单/跟进策略) | ✅ |
| P2-GO-02 | 75 项随迁全绿断言零改动(计数考证见 DEVIATIONS #20);磁盘布局与 entry 类型不变(CT-08/09 对 core fork 实测绿) | ✅ |
| P2-GO-03 | 白名单:import 包内化(tests 扁平化)、auditor config→lib/settings、questionnaire→showComponentOverlay(bare 等价)、status 槽/widget 不变 | ✅ |
| P2-GO-04 | 命令族 14 + 工具族 8 签名不变(diff 审计:除白名单三文件外与 npm 0.6.0 逐字节一致) | ✅ |
| P2-GO-05 | 共存红绿:test/lib/coexistence.test.ts(双工厂同 pi,context 链式,互不误伤) | ✅ |
| P2-GO-06 | 上游跟进策略入 FORK.md | ✅ |
| P2-REV-01 | review 0.8.6 全量迁入 extensions/review/;165 测试随迁零适配全绿;4 命令 + pi_review_report 工具 + renderer 签名不变 | ✅ |
| P2-REV-02 | peer `pi-subagents >=0.41 <1.0` + peerDependenciesMeta optional | ✅ |
| P2-REV-03 | 降级路径红绿 3 例(test/lib/review-degradation.test.ts):缺工具拒跑+一次性 install hint;有工具放行 | ✅ |
| P2-REV-04 | 8 个 agent .md 随包分发;package.json `pi.subagents.agents` 声明;directive.ts 陈旧产物防御保留(源码未动) | ✅ |
| P2-REV-05 | 磁盘布局不变(CT-09 切 core review 后实测绿) | ✅ |
| P2-REV-06 | review config 读写迁 lib/settings.ts(165 测试兜底)——PLAN §1.4 三类重复中 settings/model-id/picker 收敛(effort 的 fast-mode 落盘按 P0-LB-04 白名单保留自有实现,非收敛对象) | ✅ |
| P2-BUS-01 | bus goal 通道(active/paused/summary,updateUI 挂 publish)+ review 通道(running/done+lastRunAt) | ✅ |
| P2-BUS-02 | 通道红绿(test/lib/bus-channels.test.ts):goal 恢复→active→pause 翻转;review done 经 pi_review_report 真实工具路径;readCoreStatus 类型断言 | ✅ |
| P2-CCTUI | **用户侧**(本次派发不改 CCTUI 仓库;bus 双写保证现版无感) | ⏸ 用户 |
| P2-REL | 发 1.1.0 + CCTUI 1.5.0 + settings 切换:用户侧 | ⏸ 用户 |

### 测试计数

- `bun run test`:vitest **504 passed**(441 modes + 31 lib + 26 P1 + 5 P2 新增)+ node--test **312 passed**(effort 72 + goal 75 + review 165)
- `bun run contracts`:**17 passed**(goal/review 目标已切 core,断言零改动)
- `bun run check`:exit 0(goal 0.6.0 类型漂移已入树修复,P0 白名单机制自动过期撤除)

### 真机冒烟(P2 可做子集)

`pi -e ./extensions/index.ts --no-session --no-tools`:四模块装配加载无自身错误;goal 工具族(get_goal/create_goal/update_goal)注册并使本机旧包冲突弃用(切换期预期形态)。完整冒烟(P2-REL-02:/review 全轮、goal 建目标→widget、共存一晚)需发版切换后执行,用户侧。

### 剩余风险

1. review `/review` 的 bus running 发布仅在命令 handler 内(prepareRun 后),单测未驱动(需 git/PR 环境);由 P2-REL-02 真机冒烟覆盖。
2. goal-auditor 的 0.85 modelRuntime 行为(不再继承主会话 registry)——auditor model 均显式解析,真机 /goal 完成审计时观察。

### 复查结论(2026-09-21,新鲜眼 subagent)

**PASS(修复后)— 达 commit 门槛。** 随迁零改动 diff 审计全部通过:goal fork 对照 npm 0.6.0 tarball 仅白名单三文件不同;review 的 tests/agents/reference 与源包零差异,src 差异逐 hunk 判定为申报内改动;契约断言文件零变化。DEVIATIONS #20-#26 裁定合理。

- **阻塞发现(已修复)**:review running 发布因替换锚缩进不匹配静默未插入,与三处自报不符——已补(index.ts prepareRun 成功后),P2-BUS-01 完整。
- 非阻塞修复(已随本次处理):types/index.d.mts CoreSnapshot.goal 补 paused?: boolean;reader paused 透传显式 false;bus-channels 补 /goal-resume 后 paused:false 断言;DEVIATIONS 补 26b(165 vs 161 考证);.gitignore 补 .pi/;FORK.md 注 docs/README 未随迁。
- P2-GO-05 的真机同屏冒烟半边、P2-CCTUI、P2-REL:用户侧(P2-REL 窗口)。

## P1 — modes + effort 并入 + capability bus 首发(1.0.0,本次不发)

**状态:实现完成,复查通过(2026-09-21),已 commit(未发版——1.0.0+ 留用户)。**

### 交付项与 spec ID 对照

| spec ID | 内容 | 状态 |
|---|---|---|
| P1-PM-01 | pm 2.8.0 全量迁入 extensions/modes/(import 包内化;改动仅白名单+bus 接线) | ✅ |
| P1-PM-02 | 441 vitest 随迁零断言改动全绿 | ✅ |
| P1-PM-03 | 契约套件 modes 目标切 core 模块,CT-01..09 断言零改动持续绿 | ✅ |
| P1-PM-04 | 白名单:①profiles :effort → EffortOwner.setFromProfile;②alt+t → setExplicit("shortcut")+envPin;③settings→lib/settings.ts(config/profiles/permissions-loader)、plan-approval-dialog 底座→lib/overlay.ts | ✅ |
| P1-EF-01 | @mariozechner→@earendil-works 全量替换,peer 提至 >=0.85<1.0;API 面 tsc 为准(漂移适配见 DEVIATIONS) | ✅ |
| P1-EF-02 | effort 迁入;命令/快捷键/flag 保持;picker 底座→lib/overlay.ts;fast-mode 落盘键不变 | ✅ |
| P1-EF-03 | 72 项随迁全绿(spec 写 74,源包基线实测 72),node--test 保持 | ✅ |
| P1-EF-04 | status 槽 pi-effort-thinking/pi-effort-fast 不变(契约套件对 core effort 实测) | ✅ |
| P1-EF-05 | lib/effort-owner.ts 所有权链 ①env>②explicit>③profile>④默认(接口微扩见 DEVIATIONS) | ✅ |
| P1-EF-06 | 红绿 a)–f) 六条 + changed()/共享单测(test/lib/effort-owner.test.ts,12 用例) | ✅ |
| P1-EF-07 | source-scan:extensions/{modes,effort} 零直接 setThinkingLevel 调用(红→绿钉住) | ✅ |
| P1-BUS-01 | __piClaudeCodeCore frozen 纯数据快照 + __piClaudeCodeCoreCmd 写通道(extensions/bus.ts) | ✅ |
| P1-BUS-02 | ./types subpath:纯 .mjs + .d.mts,total reader readCoreStatus(fallback 新 key→legacy→默认) | ✅ |
| P1-BUS-03 | publishCore 唯一发布口,显式 per-channel patch,同批次派生写 legacy | ✅ |
| P1-BUS-04 | version 固定 1、revision 单调、无定时器;presence gate 留在 modes 实现细节 | ✅ |
| P1-BUS-05 | publish 后新 key + 2 个 core 可写 legacy key 同步一致(bus.test.ts) | ✅ |
| P1-BUS-06 | frozen/整体替换/revision 单调/未触碰 channel 引用不变 | ✅ |
| P1-BUS-07 | reader total 矩阵(undefined/{}/v0/v1/v99+garbage)全不 throw(bus-types.test.ts) | ✅ |
| P1-BUS-08 | Cmd unknown → {ok:false,"unknown-command"} 不 throw;dispose 清 core 自有 key(legacy 残留按 CT-03) | ✅ |
| P1-BUS-09 | 写侧(bus.test.ts)与读侧(bus-types.test.ts)文件互不 import,撤除互不阻塞 | ✅ |
| P1-BUS-10 | v1 无订阅字段断言 + v2 onChange 数据字段预案注释(bus.ts/types) | ✅ |

### 测试计数

- `bun run test`:**498 passed**(modes 随迁 441 + lib 31 + effort-owner/bus 新增 26)+ node--test **72 passed**(effort 随迁)
- `bun run contracts`:**17 passed**(modes/effort 目标已切 core 模块,断言零改动)
- `bun run check`:main OK + contracts OK(goal 0.6.0 两行已知漂移白名单)

### 真机冒烟(P1 可做子集)

`pi -e ./extensions/index.ts --no-session --no-tools -p hi`:core 装配(bus+modes+effort)加载无自身错误;flag `--effort/--permission-mode/--model-profile` 与工具 `plan_ready` 均注册,与本机旧包并装时 pi 判定旧包冲突并弃用旧包、core 胜出(切换期预期形态;P1-REL-03 完整清单需发版+切 settings,本次不做,见 OPEN-QUESTIONS)。

### 剩余风险

1. bus effort/goal/review 通道的 P2 填充(goal/review 空骨架已发布)。
2. `setMode`/`setEffort` Cmd kind 的真实处理器未注册(v1 只交付 registry + unknown 契约;待 /core 面板 P4 接 ctx)。
3. effort 的 integration 测试对 0.85 loader 的三处 setup 适配(见 DEVIATIONS #9),上游再变需跟随。

### 复查结论(2026-09-21,新鲜眼 subagent)

**PASS — 达 commit 门槛。** 21 个实现 spec ID:20 PASS + P1-REL 流程项(与 P0-SK-04 同性质,待发布窗口)。要点:

- 三命令实测全绿且计数精确对账(498 = 441+31+26;effort 72;contracts 17)。
- 随迁断言零改动经独立 diff 审计:pm 22 个测试文件**逐字节零差异**;effort 3 文件 diff 逐 hunk 判定全部为 DEVIATIONS #9 申报的 setup 适配,断言行零改。
- 契约测试文件与 P0 commit diff 审计:断言文件实质零改动(disk-layout/env-forwarding 仅 import 随被测对象切换,属 P1-PM-03 本身)。
- DEVIATIONS #8-#18 全部裁定为合理裁量。
- 修复的复查发现:permissions-loader malformed 语义恢复(#19);两处测试注释失真修正。
- 遗留:P1-REL-01..04 待发布窗口执行(发 1.0.0、切 settings、完整冒烟、symlink 核查)。

## P0 — 脚手架 + 契约冻结(0.1.0)

**状态:实现完成,复查通过(2026-09-21),已 commit + 发 0.1.0-next。**

### 交付项与 spec ID 对照

| spec ID | 内容 | 状态 |
|---|---|---|
| P0-SK-01 | git init + package.json(name/pi.extensions/peer 0.85<1.0/devDeps pin 0.85.1) | ✅ |
| P0-SK-02 | extensions/index.ts 空装配(八模块位注释)+ test/contracts/ | ✅ |
| P0-SK-03 | `bun run check`(scripts/check.mjs 双 tsc 门)/ `bun run test`(scripts/run-tests.mjs 统一入口)/ `bun run contracts`(独立 vitest config) | ✅ |
| P0-SK-04 | npm 发 0.1.0 `--tag next` | ⚠️ 被阻:本机 npm 未登录(ENEEDAUTH),记 OPEN-QUESTIONS #1 由用户执行;包体与 publishConfig 就绪 |
| P0-SK-05 | spike① `/types` subpath 布局(npm pack + jiti + tsc 三验证过,见 test/spikes/types-subpath-spike/RESULT.md);spike② 显式 per-channel patch(5 个 @ts-expect-error 编译期证明,见 test/spikes/per-channel-patch.ts) | ✅ |
| P0-LB-01 | lib/settings.ts(readJson 从不 throw / writeJsonAtomic tmp+rename) | ✅ 9 测试 |
| P0-LB-02 | lib/model-id.ts(parseModelId,非法→null 不 throw) | ✅ 15 测试 |
| P0-LB-03 | lib/overlay.ts(showOverlay:custom overlay → select 降级 → headless null) | ✅ 7 测试 |
| P0-LB-04 | lib 单测(等价 + 边界);旧实现零删除(按白名单随 P1/P2 并入时删) | ✅ |
| P0-CT-01..03 | globalThis 契约(capability 形状/CCTUI 在场抑制+双 key/shutdown 残留+poller 停) | ✅ 5 测试 |
| P0-CT-04..06 | env/转发契约(INHERITED_MODE/转发目录约定/pm 不设 PARENT_SESSION) | ✅ 3 测试 |
| P0-CT-07 | status 槽白名单(容忍 effort 槽 undefined 清理写;pm 对 modes 槽的 undefined 写合法) | ✅ 2 测试 |
| P0-CT-08 | appendEntry 类型白名单(modes 经 shift+tab 路径行使;goal/review entry 由 P2 套件行使,此处钉「实例化+session_start 无白名单外类型」) | ✅ 1 测试 |
| P0-CT-09 | 磁盘布局逐一钉住(行为断言为主;pm config 默认路径与 review runs 路径为源码行钉住,原因见 DEVIATIONS) | ✅ 6 测试 |
| P0-CT-10 | test/contracts/README.md 契约→消费方→移除条件表 | ✅ |
| P0-CT-11 | `bun run contracts` 一键,测试名带 spec ID | ✅ |
| P0-CT-12 | test/contracts/fake-host.ts(pm createFakePi 模式扩展:status/widget/workingMessage 记录、env 快照、globalThis 清理、四包实例化) | ✅ |
| P0-CT-13 | (逃生门)本 Phase 无 todo 用例——四包工厂全部真实例化通过 | ✅ N/A |

### 测试计数

- `bun run test`(lib 单测):**31 passed**(settings 9 + model-id 15 + overlay 7)
- `bun run contracts`(契约):**17 passed**(globalthis 5 + env-forwarding 3 + status-entries 3 + disk-layout 6)
- `bun run check`:main OK + contracts OK(goal 0.6.0 两行已知漂移白名单,见 DEVIATIONS #2)

### 真机冒烟

`pi -e ./extensions/index.ts --no-session --no-tools -p hi`:core 空壳加载无错、无命令/工具注册、LLM 正常往返(输出中 SoL-Pi 报错为本机另一已装包在 --no-session 下的已知行为,与 core 无关)。

### 剩余风险

1. goal 0.6.0 ↔ 0.85.1 类型漂移两处(goal-auditor.ts:142/206)——P2 fork 入树后修复并撤 scripts/check.mjs 白名单(自动过期机制会强制提醒)。
2. 契约套件 vitest SSR 的 bare-import 解析经 core/node_modules(0.85.1)而非各源包声明版本——与真机 pi 0.85.1 行为一致,反而是更真实的被测环境;但「源包声明版本(0.72/0.74/0.84)下的行为」不在本套件覆盖内(P1/P2 迁移后统一到 0.85,该差异自然消失)。

### 复查结论(2026-09-21,新鲜眼 subagent)

**PASS — 达 commit 门槛。** 全部 19 个 spec ID 逐项核对:18 PASS + P0-SK-04 PARTIAL(发版为流程待办,复核查毕后执行)。要点:

- 三命令实测全绿;四源包 git status clean(effort 包一个 untracked plan.md 为 Sep 19 真机残留,早于实施,与套件无关);空壳实例化复核 0 注册。
- 契约断言与 pm/goal/effort 源码并排对照,确认为钉住现状的真行为断言,无空转/名不副实。
- DEVIATIONS 7 条全部认定为合理工程裁量,无违反 spec 硬要求。
- 修复的复查发现(2 项,均非阻塞):contracts README 补 PLAN §3.2 第 6 条豁免登记;DEVIATIONS #6 表述修正(fake-host 由 contracts project 而非主 project 的 tsc 覆盖)。
- 遗留提示(不阻塞):package.json `files` 的 `types/` 目录为 P1-BUS-02 预布,当前不存在(npm pack 无害)。

---

## Core/UI 解耦批（DC1–DC5b，2026-09-23）

spec rev2（红队处置版）全 Phase 落地，见 `../CORE-UI-DECOUPLE-PLAN.md` §11 偏离记录。十三次 commit（core 9 + cctui 4）：

- **DC1** `03053be` / cctui `818e168`：MODE_META 呈现素材过 bus 快照 + legacy 投影，cctui 删本地表只留 paint。
- **DC2** `6c1bf17`：`effort/ui/`（status 槽/loader/picker）+ UiAdapter interface 冻结（`ui/base.ts`）。
- **DC3** `ede4a07`：`modes/ui/` 四件（meta/footer/plan-widget/confirm + dialog git mv）+ `ui/notify.ts` 尾队列（cap 20、单调 id、无 ACK）+ modes 26 notify。
- **DC4a** `3a1ef29`：goal 36 notify 接队列 + `goal.widget` 快照字段。
- **DC4b** `89c04ed` / `d1d425d`：goal 状态机 5 例行为测试（FakeHost + 磁盘 fixture，经 bus 频道断言——goal.ts 主文件首次有测试）+ widget 投影完备化 + 呈现接线半边物理搬移 `goal/ui.ts`（闭包状态参数化为 6 getter，状态机测试零改动全过=搬移安全网）。
- **DC5** `e3558f6` / cctui `fc8a963`：bus v2 `onChange` DATA field（订阅点即数据）+ publish always-full + `__pmWorkingStats` 写入侧存活键门控（P0-CT-02 negative 在新语义下保持）+ `ui/fallback.ts` 持有 working-message 写权（§4.3 丙案：写入点让路、轮询自愈）+ cctui `readPmStatus` 切快照本体。
- **DC5b** `6db4ae2` + `fde5305` / cctui `1f8a5ee`：fallback adapter 经 onChange 消费尾队列（首个 v2 真实消费者）；cctui 声明 `notificationsConsumer` 能力并自消费（attach 快进 + 帧路径幂等重试）；core 直写收敛为旧 cctui 兜底 leg——新/旧/无 cctui 三组合每条消息恰好显示一次。

### 测试计数（终态）

- vitest **591** + node --test **324**（79+80+165）+ contracts **17**；cctui **72**；tsc 双仓零错；每批 TUI 冒烟通过。
- 新测试面：尾队列合同 6 + fallback adapter 8 + goal 状态机 5 + cctui 消费者 3 + bus v2 契约更新（14）。

### 剩余（版本门控，非实施项）

1. notify 直写 leg 的删除：旧 cctui 装机清零时。
2. `deriveLegacy` 撤除：cctui ≥1.5.0 且装机率到位（contracts/README.md 准则）。
3. 命令区交互类触点（select/editor）按 spec §3 呈现/交互分治有意留在逻辑侧。

---

## memory v2 批（V2-M1/M-C/M-A，2026-09-24）—— 全量替代 pi-hermes-memory

spec `../specs/design/DESIGN-MEMORY-V2.md`，报告 `../MEMORY-V2-REPORT.md`（替代矩阵/冒烟脚本/卸载清单在报告）。四阶段全落地，**未 commit**（等用户真机冒烟）：

- **P1 存储+写入（MV2-S）**：用户层 `~/.pi/agent/memory/`（同款 per-file + 同一 reconciler）；注入=用户索引(≤8K 含 pinned 常驻段)+项目索引吃 25K 车道余量；selection 池合并两层；guard 双目录；modes carve-out 换 `isMemoryWritePath`（DEVIATIONS #67）；`pinned: true` frontmatter 吸收 STANDING 语义（≤5 文件/2KB，超限整丢不截断）。
- **P2 整合（MV2-C）**：`store.ts` ops engine（preflight 全量校验→批原子落盘，单文件 tmp+rename；mkdir 锁 TTL 10min）；`memory_consolidate` 工具（必须收缩不变量，原生渲染，reject 即 throw）；directive+triggerTurn（followUp）；turn_end 自动触发（索引截断 WARNING/条目>200，会话 ≤2 次、10-turn 间隔、tool_result/agent_settled 清 in-flight）；`/memory-consolidate` 兜底命令。
- **P3 自动维护（MV2-A）**：`llm.ts` side-channel `completeSimple()`（auth 轮换重试一次/60s 超时/严格 JSON ops 提取——schema 仅 prose 防思维链复述误解析）；纠正检测（EN 强/弱/负 + CJK 补齐——hermes 仅英文，对本机用户实质改进；1/3 turns 节流）；review（≥10 turns 或 ≥15 tool calls，≥3 user turns 预热，fire-and-forget）；flush（before_compact 60s 跟 signal + shutdown≠reload 10s）；settings 两旋钮（`memory.automation`/`memory.model`）；整合指令 turn 不计入捕获计数；yielded 时全部静默。
- **P4 迁移+收敛（MV2-M）**：§ 切分修复（v1 `/^§ /m` 与真实数据不匹配）+ 全量迁移（USER.md→用户层、全局 MEMORY.md 按 project64 路由、failures.md→feedback 带类别前缀、projects-memory 项目匹配 endsWith 规则、跨源去重、created 保留）；`/memory` 诊断升级（两层占用+automation/consolidation/lastError+hermes 提示）；命令面=2 稳态+2 一次性迁移。

### 测试计数（终态）

- vitest **662**（+72：storage 12 + consolidate 19 + automation 28 + migration 12 + 既有回归）；既有 memory/carveout 用例零改动全绿；tsc 双 project 零错。
- 真实数据实弹：临时 HOME 拷贝跑 `importHermesFull`（Pi-Extension 身份）→ 39 条全量路由正确、幂等、去重生效。

### 剩余（用户门控）

1. 真机冒烟（报告 §7 脚本）→ 卸载 hermes（packages 移除 + 数据目录归档，清单在报告 §7）。
2. commit 拆分建议：P1+P2+P3+P4 各一或两批（`memory v2` 主题）。
3. 冒烟后观察项：side-channel parse_error 率（高则按 spec §10a 降频/改 directive 形态）、CJK 纠正误报率（高则收紧强模式）。

## 架构优化 8-batch（2026-10-02 起，方案 v2 定稿 + 2 轮对抗审查）

> 来源：improve-codebase-architecture 走查（3 并行 reviewer → 9 候选 → HTML 报告）；方案 v1→v2 经 2 轮 glm-5.3-flash 对抗审查定稿（Round1 22 findings 全处置、Round2 verdict 定稿可执行 + 4 条 P2 勘误随批更正）。

- **B1（C1 MCP-shape 谓词下沉）✅ commit 2a8da74**：`lib/mcp-shape.ts` 纯底座（5 分支 + env 解析）；family.ts 组合（authority 不变）；plan gate 消费同一底座 —— 4 个泄漏形态（全单下划线/proxy/direct-named/裸 mcp_*）从放行变拒绝；4 条 shape pin + p4-families 回归绿；AGENTS.md 不变量 4 精确化 + web-gov 注释 + DEVIATIONS #72 + CHANGELOG。三绿。
- **B2（C8 quick wins）✅ commit 88d63b9**：INDEX_MAX_BYTES 派生权威常量（MEMORY_INDEX_MAX）；POLICY_MARKER 常量化（policy↔yield 单侧改名编译期红）；slugify 去重（memdir 唯一实现）；core-economy 收编 readJson（语义保持：missing 静默/malformed+empty+non-object warn、字段归一留 caller、setCoreEconomyPath seam 保留）；ledger.ts header 正名（write-only 审计，非 sentinel 数据源）；FORK.md 白名单补 ui.ts+questionnaire-layout.ts（DC4b）；selection↔session-recall tokenizer 分工互注；contracts README MemoryPatch 附注 P1-BUS-05（零消费方不独立登记）。三绿。
- **B3（C4 goal kind 化 + 死代码）✅ commit 66fa7d9**：GoalStateEntry 加可选 kind（5 产生点标注，version 不 bump）；renderGoalResult kind 优先分派 + legacy prefix 回退（孤儿 prefix 留回放）；删 evaluateDraftingToolGate/ToolGateDecision（no-op + 绿测试假信心）；goal.ts 内联谓词改调 shouldQueueContinuation（B7 step1 搬家时曾回滚为内联，终审 F1 修复：goal-continuation.ts 消费 policy 谓词、goal.ts 死 import 删除）；三单例入 factory closure；renderGoalResult 导出 + 3 条渲染 pin。三绿。
- **B4（C6 pi-compat 注入+degrade 收拢）✅ commit 42b5c81**：probePiCompat 未提供探针不再报 problem（obs 纯 version 探测无噪音）；mutationQueue 纯诊断化（FUS-03 死锁实证，移出 problems）；degradeEconomyModule 共享降级尾巴（纯函数收回调）；ActionFusionOptions.version 注入 + assembly economy 块穿线（首个生产性 options）；obs hostExports 同语义；两条自禁用回归 pin（0.85→零注册+真 bus footer）+ pi-compat 3 新用例。三绿。
- **B5（C2 obs 纯投影）✅ commit bf17a70**：projection.ts 纯投影步骤（store/appendLedger 两端口 + outcome 携带 failOpenReasons/sentinelWarning/counters）；handler 退 thin adapter；sentinel flags 移入 ProjectionState、noSessionWarned 留 adapter 闭包（module-global 状态清零；终审建议的台账补句）；invariant 9 显式 pin（非候选引用透传 + 替换项仅 content 变）；6 条直驱 node:test（原需 ~286 行 FakeHost）；sentinel 触发路径勘误（ledger 抛，非 store 抛——store 抛时 eligible 不计数）。CON-03/04 零改动全绿。三绿。
- **B6（C7 fusion outcome 结构化）✅ commit a22e471**：executeMutationThenRun 在合并 details 上盖 thenRun:succeeded（既有 details 保留）；两处 substring 嗅探改读字段（THEN_RUN_SUCCEEDED 文本逐字不动，FUS-04）；runFused 单点收拢编排+计数，edit/write 注册块缩至差异项；resolveToolPath+normalizeToolPath 搬 tool-path.ts；fused-count.test.ts 经真注册 write 工具端到端 pin 计数（tmpdir+cat，bus fusedCount 恰好一次）。三绿。
- **B7（C3 goal monolith 拆分）✅ 分步 3 commits，验收缩水已记 DEVIATIONS #73**：step1 continuation loop → goal-continuation.ts（7 直测）；step2 completion-audit flow → goal-audit-flow.ts（auditor 可注入，3 直测）；step3 pendingGoalAchievement → audit 域 slot。statemachine 全程零改动全过。FORK.md P2-GO-06 改写为结构性 fork 自持。状态机核心（persist/setGoal/池/记账）+ confirmation 粘合仍在 goal.ts——thin adapter 终态未达，终审复核。
- **B8（C5 memory RecallSession）✅ commit 8d0e189**：recall-session.ts 吃掉四个闭包绑定（MR-01..09+AD1 全部不变量单点，7 条 vitest 直测）；context handler 退 wiring（MR-03 快照提取+两层扫描+投影）；memory.test.ts FakeHost 回归零改动 36/36；/memory 渲染移 diagnostics.ts（纯函数，预算 cap 引权威）。三绿。
- **C9（fail-open seam）：跳过（2026-10-02 决定）**。理由：(a) B8 抽走 recall 后 memory/index.ts hook body 只剩 wiring 胶水，各 catch 降级值语义各异（undefined / {systemPrompt} / {messages}），adapter 参数化不减少理解面；(b) invariant 8「注入永不阻塞 turn」已由 memory.test.ts FakeHost fail-open 用例端到端钉住；(c) R1 审查判定 deletion test 弱（Speculative）。

### 终审（2 轮对抗，2026-10-02，glm-5.3-flash read-only）：通过 ✅

- Round1「有条件通过」：F1 major（B7 step1 搬家回滚了 B3 谓词收编——goal-continuation.ts 内联两份 active+autoContinue 谓词 vs 头注释宣称 policy 单实现，无行为 bug 但声明失实）+ F2 minor（docs/en/zh 模块表缺 tool-path.ts）+ F3 minor（selfCheck 双调用残留）→ 全部修复（commit f739978）。
- Round2 判定：四项修复闭合、谓词替换行为恒等、无新问题，verdict **通过**。
- Residual risks 由主会话闭合：三绿复跑（check OK / vitest 720 / contracts 25）；git diff --stat 证实 goal-statemachine.test.ts / test/lib/memory.test.ts / pi-host-semantics.test.ts 整批（12 commits）零改动；legacy 白名单 git show 与 pre-B3 逐字等价。
- 设计维度判定：mcp-shape / projection / recall-session / goal-continuation 真加深（deletion test 全过）；goal-audit-flow 诚实搬家+seam（auditor 注入 + emit seam）；diagnostics 合适的浅 formatter——无「搬家不加深」失败案例。
- 全批终态：12 commits（2a8da74^..HEAD），方案 v2 定稿 2 轮 + 终审 2 轮对抗，全部 glm-5.3-flash。

### Esc 劫持修复（用户报告 bug，2026-10-02，goal 批后独立修复）

- **现象**：goal 活跃 + agent 卡住（如 update_goal audit 挂起）时按 Esc 无法打断模型——Esc 被 goal 的 Esc-to-pause 绑定吃掉。
- **根因**（证据链：goal/ui.ts:149 → pi-tui tui.js:681-698）：onTerminalInput listener 同步执行完整 pauseActiveGoal 业务流（写盘/UI 更新），在 TUI 输入分发循环内造成副作用链断裂 → focusedComponent（打断处理）永远收不到 Esc。onTerminalInput 是观察通道，被当成了按键处理通道。
- **修法**：三重守卫——busy agent 时 Esc 不认领（打断优先，probe 失败按 busy）；pause 分发移 queueMicrotask + try/catch（listener 零副作用）；仅 idle 时保留 Esc-pause 便利绑定。goal-ui-escape.test.ts 5 条直测 pin（busy 放行 / idle 异步分发 / pause 抛错不炸输入链 / 非 Esc 键忽略 / headless 零订阅）。三绿。
