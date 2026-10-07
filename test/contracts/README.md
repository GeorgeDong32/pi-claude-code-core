# Contract Suite — 契约 → 消费方 → 移除条件(P0-CT-10)

> 每条跨包契约钉在 `bun run contracts` 的一个 spec ID 测试里。
> P0 被测对象 = 四个源包(经 `targets.ts`);P1 起逐个切到 core 模块,**断言零改动**。

| 契约 | spec ID | 消费方 | 移除条件 |
|---|---|---|---|
| `globalThis.__piPermissionModes` = `{version,active,mode,workingStats}` | P0-CT-01 | CCTUI(<1.5.0)、pi-agent-panel | CCTUI ≥1.5.0 且装机率到位(切读 `__piClaudeCodeCore`)后撤 |
| CCTUI 在场(`__piCcTui.active`/`__ccTuiActive`)→ pm 抑制自身 working 行 + 写 `__pmWorkingStats` | P0-CT-02 | CCTUI 旧版 footer | 同上,与 legacy key 一起撤(core 侧 `writeLegacyAliases`) |
| `session_shutdown` 后 key 残留且 `active:true`;poller 停止 | P0-CT-03 | (按现实钉住,无清理行为) | 不移除(行为基准) |
| `PERMISSION_MODES_INHERITED_MODE` 随 mode 更新 | P0-CT-04 | pi-subagents 子代理继承 | 子代理改读 bus 快照后可撤(v2 议题) |
| 审批转发目录 `~/.pi/agent/sessions/permission-modes-forwarding/sessions/<id>/{requests,responses}` | P0-CT-05 | pm ↔ pi-subagents 双向 | 转发机制下线时整体移除 |
| pm 不设置 `PI_SUBAGENT_PARENT_SESSION`(只消费) | P0-CT-06 | pi-subagents(生产方) | 不移除(职责边界钉住) |
| status 槽 `modes` / `pi-effort-thinking` / `pi-effort-fast` / `goal`;widget `plan-todos` / `goal`;容忍 `effort` 槽 undefined 清理写 | P0-CT-07 | pi TUI footer / panel | 槽位语义变更 = 升 bus version 议题 |
| session entry 类型 `modes` / `pi-goal-{state,focus,event,audit-event}` / `pi-review{,-directive}` | P0-CT-08 | 旧 session 回放兼容 | 磁盘/session 格式永不静默破坏 |
| custom message `pi-memory-recall`（details v1：`{ v:1, delivery:"immediate"\|"deferred", model, files:[{key,bytes,truncated}], bytes, elapsedMs }`，customType 字符串与字段集冻结） | P0-CT-08（RV，spec 2026-10-02-memory-recall-v2） | core 自身（RV-06 去重、`/memory` 诊断） | 召回机制整体下线时移除 |
| 磁盘布局(pm permissions/plan/profiles/config、effort settings 键、goal `.pi/goals`、review `pi-review.json`+runs) | P0-CT-09 | 全部既有用户数据 | 不移除(冻结) |
| 磁盘布局(memory)：pending-extraction queue `~/.pi/agent/memory-queue/<sessionId[:8]>-<epoch>.json`(record v1:`{v,sessionId,projectsDir,projectKey,cwd,savedAt,attempts,parts}`,原子写,同 sessionId 精确合并、加载时年龄/GC 执法)。**P0-3 所有权后缀(spec 2026-10-07-p0-3)**:占有态 `<ready>.claim.<pid>.<claimedAtMs>.<nonce>`、可重试态 `<ready>.pending.<nonce>`(均不以 .json 结尾;nonce=每次转移新生成的 UUID,路径永不复用);GC token `.gc.<pid>.<ts>.<nonce>.tmp` 只承载独占取得的遗留写入 tmp。互斥=同目录单次 rename,claim 后必须从 claim 文件重读;死 claim 回收需 TTL(≥10min)+owner 探测确认(pid ESRCH);TTL 不剥夺活 worker;claim 计入 2MiB 软预算但不被 GC 删除;写入 tmp 只经 GC token 回收。旧 ready 名/v1 内容仍冻结 | P0-CT-09（spec 2026-10-03-memory-exit-flush + 2026-10-07-p0-3-memory-queue-claim） | core 自身（shutdown 写 / session_start drain） | queue 机制下线时整体移除 |
| (P1 起)`__piClaudeCodeCore` 快照 + 2 个 core 可写 legacy key 同步 | P1-BUS-05 | CCTUI ≥1.5.0、panel | 各自独立撤除,互不阻塞(P1-BUS-09) |
| 注：快照的 memory 可选通道（`MemoryPatch`，P3-ME-06）由 memory 模块发布，当前零外部消费方——不独立登记，俟有真实消费方时按本表规约补行（B2 处置） | —（附注 P1-BUS-05） | 无 | 有消费方时补登记 |
| CCTUI `externalToolOwner` 以 source 子串过滤外部工具;cctui 自 1.8.0 起只经 `registerToolRenderer` 换渲染器,不注册任何工具;core 不得依赖 cctui 的渲染接管 | —(豁免登记,2026-10-07 修订) | CCTUI externalToolOwner | core 若重注册任何工具,由 CT-07 同款白名单思路另行加钉 |
| 宿主 `message_end` hook 先于 SessionManager append;leaf 能标识已提交 branch 变化 | AR1005-ST-HOST(spec 2026-10-05 §13) | modes working stats | 不再使用该宿主读取缓存策略时移除 |
| session teardown 使旧 ctx 失效(invalidate/session_shutdown);core 必须取消旧 recall 且吸收晚到失败(无 unhandledRejection) | AR1005-RC-HOST(spec 2026-10-05 §13) | memory recall | recall 不再持有跨事件异步请求时移除 |
| `turn_start` 的 turn 生命周期:同一 turn 内多次工具调用共享同一预算 epoch | AR1005-RU-HOST(spec 2026-10-05 §13) | rules activation | 激活预算改为另一已登记生命周期时移除 |
| renderer 的 `args`、`isPartial`、`isError` 能力及缺失时的兼容路径 | AR1005-FU-HOST(spec 2026-10-05 §13) | action-fusion UI adapter | 不再使用这些展示上下文信息时移除 |
| 快照 `observation` 通道可选 `sites` 字段(display-only 每站点节省 `ReadonlyArray<{tool,id,avoidedTokens,toolCallId?}>`,`toolCallId` 为显示侧行关联键;仅首次替换请求携带,绝不进 provider request/projected messages;对齐 SoL-Pi showSolPiSavings 单次语义) | OBS-09-SITES(单次语义扩展) | pi-claude-code-tui(CC 工具行闪显单次节省) | TUI 不再消费每站点数据时移除 |
| 通知尾队列 `notifications`(单调 id、cap 20)+ `__piCcTui.notificationsConsumer=true` 时 core 停止 direct forward;**在场声明即所有权交接**:在场期间 fallback 只推进游标、不显示,消费方处理交接后仍保留于队列的条目;cap 20 无 ACK,不承诺任意迟到下零丢失 | XPKG-01(spec 2026-10-07-p1-1) | cctui ≥ 配对 spec 版本 | 通知改由其他通道承载时 |
| `snapshot.onChange` 订阅点(v2,数据携带的注册函数,每个 bus 实例一个) | XPKG-02(spec 2026-10-07-p1-1) | cctui、core fallback | bus 改用其他订阅机制时 |
| `snapshot.instance`:每个 bus 实例的随机标识;同一实例的所有快照相同;`/reload` 后必然不同;旧 core 无此字段时消费方回退比较 `onChange` 函数身份 | XPKG-03(spec 2026-10-07-p1-1) | cctui core-bus client | — |
| obs_recall 结果:`details { id, offset, bytes, lines, nextOffset, eof }` 为结构化来源;文本首两行 header 为模型协议,显示侧只能作为回退解析 | XPKG-04(spec 2026-10-07-p1-1) | cctui obs_recall 显示 | cctui 不再解析文本时,可删去文本那半句 |
| action-fusion `edit` / `write` 参数可携带 `then_run.command`(字符串或 `{command: string}` 对象,FUS-SHAPE) | XPKG-05(spec 2026-10-07-p1-1) | cctui then_run 徽标 | — |
| cctui 按工具名摘要依赖的字段,完整名单见 `spec/2026-10-07-p1-1-bus-surface-for-cctui.md` §4.1a(真实 schema 与旧显示别名区分;create_goal/propose_goal_draft: objective/goal/title;update_goal: objective/note/status;get_goal 无参;pause_goal: reason;goal_questionnaire: topic/question;session_recall: query+since;memory_consolidate: operations.length/reason;obs_recall: id+offset;pi_review_report: mode/scope/base;plan_ready: plan/summary;step_complete: step/result;abort_goal: reason;apply_goal_tweak: changeSummary/newObjective;goal_question: question) | XPKG-06(spec 2026-10-07-p1-1) | cctui callArgsFor | cctui 改为 schema 驱动摘要后撤除(见 cctui P1-1) |
| `display.footer`:string 数组,core modes footer 安装时或 cctui 启用时渲染(含其 native footer 模式的 cc-footer);显式 off 恢复宿主 stock 后不显示,不存在基于 presence 的自动交回 | XPKG-07(spec 2026-10-07-p1-1) | cctui footer、core modes footer | — |
| `modes.usage` 原始数字(`{input,output,cacheRead,cacheWrite,cost,tps?,ctxTokens?,ctxPercent?,contextWindow?}`,与 `workingStats` 字符串同批次发布;只发布 finite 非负,缺失字段省略,unknown 不伪装成 0;session 切换清空) | XPKG-08(spec 2026-10-07-p2-4) | cctui 状态行 | — |
| 宿主假设:aboveEditor widget 顺序受注册顺序影响;cctui 现有 macrotask 重注册仅为尽力排序,不能保证晚于所有异步 session_start 或后续 core widget 更新;跨包不新增「core 此后不能重注册」的限制 | XPKG-09-HOST(spec 2026-10-07-p1-1) | cctui 布局 | pi 提供正式排序 interface 后撤除;未取得宿主时序证据前按协议 test.todo 指向 TUI P3-1 D5 |
| **D4-READER-REMOVE(D4=B,用户 2026-10-08)撤除 `./types` 子路径的 runtime reader**:删除 `types/core-status.mjs`、`CoreStatus` 接口与 `readCoreStatus` 声明;`exports["./types"]` 仅保留 types 条件,运行时 import 抛 ERR_PACKAGE_PATH_NOT_EXPORTED。保留:`CoreSnapshot`/`CoreCommand`/`CoreCommandResult` 纯类型入口、bus 本体、legacy key(`__piPermissionModes`/`__pmWorkingStats`)与 `writeLegacyAliases`、cctui 自身的 duck-typed 回退。迁移方式:原 reader 断言改读 `coreBus().snapshot()` / `globalThis.__piClaudeCodeCore`;既有运行时 reader 消费方(已检索:TUI/panel/pi-subagents 无调用)升级后直接 duck-type 快照。验收:正式包子路径 type-only 编译 fixture + 运行时 import 负例 + 打包清单不含 runtime reader(`test/contracts/types-subpath.test.ts`)。原 P1-BUS-02/07(published total reader)就此关闭,breaking 随下次 minor(≥0.4.0)发布说明 | D4-READER-REMOVE(spec 2026-10-07-p1-1 §4.3) | 既有 `@georgedong32/pi-claude-code-core/types` 运行时 import 方(已检索范围内无) | 恢复 runtime reader 时整行改写 |

维护规约:
- 新契约必须先在此表登记再写测试;删契约先删表行并注明版本。
- todo 逃生门(P0-CT-13):跑不通的用例 `test.todo` 且必须带去向 Phase 编号,禁止静默丢弃。
