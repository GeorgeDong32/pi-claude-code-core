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
| CCTUI `externalToolOwner` 以 source 子串过滤外部工具;core 不重注册 CCTUI 已注册的任何工具(§3.2 第 6 条,仅记录) | —(豁免登记) | CCTUI externalToolOwner | 无 P0 行为可钉(core 空壳零注册);P1+ 若 core 重注册任何工具,由 CT-07 同款白名单思路另行加钉 |
| 宿主 `message_end` hook 先于 SessionManager append;leaf 能标识已提交 branch 变化 | AR1005-ST-HOST(spec 2026-10-05 §13) | modes working stats | 不再使用该宿主读取缓存策略时移除 |
| session teardown 使旧 ctx 失效(invalidate/session_shutdown);core 必须取消旧 recall 且吸收晚到失败(无 unhandledRejection) | AR1005-RC-HOST(spec 2026-10-05 §13) | memory recall | recall 不再持有跨事件异步请求时移除 |
| `turn_start` 的 turn 生命周期:同一 turn 内多次工具调用共享同一预算 epoch | AR1005-RU-HOST(spec 2026-10-05 §13) | rules activation | 激活预算改为另一已登记生命周期时移除 |
| renderer 的 `args`、`isPartial`、`isError` 能力及缺失时的兼容路径 | AR1005-FU-HOST(spec 2026-10-05 §13) | action-fusion UI adapter | 不再使用这些展示上下文信息时移除 |
| 快照 `observation` 通道可选 `sites` 字段(display-only 每站点节省 `ReadonlyArray<{tool,id,avoidedTokens,toolCallId?}>`,`toolCallId` 为显示侧行关联键;仅首次替换请求携带,绝不进 provider request/projected messages;对齐 SoL-Pi showSolPiSavings 单次语义) | OBS-09-SITES(单次语义扩展) | pi-claude-code-tui(CC 工具行闪显单次节省) | TUI 不再消费每站点数据时移除 |

维护规约:
- 新契约必须先在此表登记再写测试;删契约先删表行并注明版本。
- todo 逃生门(P0-CT-13):跑不通的用例 `test.todo` 且必须带去向 Phase 编号,禁止静默丢弃。
