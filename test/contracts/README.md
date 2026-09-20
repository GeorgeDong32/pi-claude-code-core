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
| 磁盘布局(pm permissions/plan/profiles/config、effort settings 键、goal `.pi/goals`、review `pi-review.json`+runs) | P0-CT-09 | 全部既有用户数据 | 不移除(冻结) |
| (P1 起)`__piClaudeCodeCore` 快照 + 2 个 core 可写 legacy key 同步 | P1-BUS-05 | CCTUI ≥1.5.0、panel | 各自独立撤除,互不阻塞(P1-BUS-09) |
| CCTUI `externalToolOwner` 以 source 子串过滤外部工具;core 不重注册 CCTUI 已注册的任何工具(§3.2 第 6 条,仅记录) | —(豁免登记) | CCTUI externalToolOwner | 无 P0 行为可钉(core 空壳零注册);P1+ 若 core 重注册任何工具,由 CT-07 同款白名单思路另行加钉 |

维护规约:
- 新契约必须先在此表登记再写测试;删契约先删表行并注明版本。
- todo 逃生门(P0-CT-13):跑不通的用例 `test.todo` 且必须带去向 Phase 编号,禁止静默丢弃。
