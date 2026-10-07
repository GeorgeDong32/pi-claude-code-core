# Core 决策落地与剩余重构执行规格

日期：2026-10-08
状态：待实施；D3=A、D4=B、D6=B 已获用户确认，无待用户选择项。
适用基线：core `2ebd226189b1edc4fcf502a3638152bbdec2907e`；配对 TUI `1bf9b7f30c9c13c5d18c129538ca66b9145f34ee`。
执行入口：[core prompt](2026-10-08-execution-prompt.md)；配对 [TUI 后续规格](../../pi-claude-code-tui/spec/2026-10-08-followup-validation.md)。

本批只续做尚未实施的决策与重构，并补真实验收证据。2026-10-07 的详细规格继续有效；本文件更新决策、实际起点、执行依赖和交付范围，不重做已经落地的批次。

## 1. 已落地与本轮基线核对

| 工作 | 已有提交 / 事实 | 本批处理 |
|---|---|---|
| P0-1 plan 权限、真实 then_run | d36828f / 4cadd77 / 7f50bf4 | 保留行为回归，不重新实施 |
| P0-3 queue claim | d339d0a；复审修复 27ba11c / 4893ba2 | 保留真实子进程互斥测试；补真实多 session 验收 |
| P0-2 drafting CORE-05 | 6f2a402 | 保留 L6；只补锁策略 + G3 |
| P1-1 instance / footer / 加性契约 | ff0f7e7 / 320e7e5 / 1748892 | 不重写；只做 D4 删除及配对回归 |
| P2-3 writer / drain | 7a006c0 / f989a32 | 已完成，保留回归；可选消息扁平化仍不做 |
| P2-4 modes.usage | d539346；TUI 710c9c7 / 1bf9b7f 已消费 | 不再以“等待 TUI 实施”挂起；联合生产事件与终端证据仍待补 |
| P3-1 S1/S2/S4/S5/S6 | 221ff55 / 07f7a62 / edb1e5b | 只补 S3；旧 goal 死函数已经删除 |
| P2-1 / P2-2 | 未发现拟新增裁决/lifecycle module；台账亦记未实施 | 本批实施 |

2026-10-08 在上述两仓 revision 重新执行门禁：core check 退出 0；unit 为 vitest 905 + node:test 490 全通过；contracts 40 passed + 既有 3 todo；TUI test 272 passed、0 skipped，typecheck 退出 0。TUI 的真实 bus 联合 fixture 随本次 npm test 执行，不能将其升级为真实终端证据。日志在 `/tmp/spec-refresh-20261008-{core-check,core-test,core-contracts,tui-test,tui-typecheck}.log`；永久交付记录应保存命令、退出码、revision 与摘要，不依赖此临时路径存活。

这次核对依据提交、实现入口、测试与台账；不是对所有已实施代码重新做完整独立审查。既有独立审查结论与范围保留在 PROGRESS。

## 2. 用户已确定的选择

| 决策 | 本轮行为 | 明确保留 |
|---|---|---|
| D3=A | 仅 pause / abort / complete / apply_goal_tweak 成功后锁本 turn；G3 args→input 与移除误锁同批 | 原进度名单、预算、审计、续跑节奏；get_goal 停止后仍可读 |
| D4=B | 删除 readCoreStatus 运行时函数与 CoreStatus；`./types` 仅提供类型声明 | CoreSnapshot、CoreCommand 等类型，bus、legacy key、TUI 自身回退 |
| D6=B | family first-seen 无 UI 时继续拒绝，提示具体预置规则 | 已授权调用、显式规则优先级、现有交互审批；不扩展父会话转发 |

这三项无需再次询问。若实现中发现与选择无关的新产品决策，明确记录并仅暂停受影响项。

## 3. 剩余工作与顺序

### C1 Goal 锁策略与 G3

按 [P0-2](2026-10-07-p0-2-goal-turn-lock.md) 的 A 实施。现行 `goal.ts#tool_call` 仍读 `asRecord(event)?.args`，随后 non-progress 分支仍会设置 `turnStoppedFor`，是本批真实起点。

- L1/L2：obs_recall、subagent、MCP、codemode 后续 edit / 嵌套 read 不因 goal 假停止被拒；其他权限模块的正常裁决不受影响。
- L3/L4：四种真停止成功后仍阻止同 turn 后续写入，失败/审计拒绝不误锁，下一 turn 复位。
- L5：echo→edit、read-goal→edit，首调用不计进度也不锁后续调用。
- 保留已通过的 drafting 失败 L6；L7 验证 continuation 节奏未改。

锁策略与字段修复同批提交、同批回滚。通过后冻结 revision，作为 C5 的行为基线。

### C2 删除 runtime reader

按 [P1-1 §4.3](2026-10-07-p1-1-bus-surface-for-cctui.md) 执行已选 B。

1. 先在 `test/contracts/README.md` 登记 D4-READER-REMOVE：runtime reader / CoreStatus 撤除，保留的类型与迁移方式，以及未知外部消费者的 breaking 影响。当前 OBS-09-SITES 表行已无 reader 子句，保留 sites 契约，更新其测试里的 reader 部分即可。
2. 删除 `types/core-status.mjs`、CoreStatus 与 readCoreStatus 声明、bus 的对应 type import/re-export；package exports 的 `./types` 仅保留 types 条件。保留已增加的 instance / usage / costUsed 快照字段。
3. 迁移 bus-channels、rules-wiring、memory 等生产行为断言到真实快照；移除仅验证被删除 reader 的总函数/回退测试，保留 bus 自身的 legacy aliases、快照冻结与同步发布契约。
4. 新增正式包子路径的 type-only 编译 fixture 与运行时 import 负例，检查打包文件清单不残留 runtime reader；通过仓库脚本接入检查，不把“直接相对导入 d.mts 成功”当成 package exports 验证。
5. 更新中英 bus/AGENTS、CHANGELOG breaking、DEVIATIONS 与 PROGRESS。历史一次性 spike 保留并说明已归档，不为了字符串零命中删历史证据。

本批完成代码迁移与兼容说明；版本号升级、tag、push、发布另行安排。已确认 TUI 使用直接 bus 读取，其测试需要在删除后回归，不要求 TUI 再改造一遍消费者。

### C3 无 UI first-seen 建议规则

按 [P3-1 S3](2026-10-07-p3-1-small-refactors-and-cleanup.md) 的 B 实施。原拒绝原因保留，追加 family 给出的 suggestedRule 与预置后重试提示。测试 headless 与 subagent 无 UI：拒绝、建议规则正确、零授权写入、零新转发请求；保留 allow/session/deny、bypass 和交互选择回归。

先完成并提交 C3，再做 C4：否则对拍会错误地把已批准的新文案当成重构回归。

### C4 Permission 深化 三步迁移

[P2-1](2026-10-07-p2-1-permission-adjudication-module.md) 仍是 0/3；从 §4.3 Step 1 开始，基线为 P0-1 + C3 已落地的固定 revision。

- Step 1：bypass / 规则 / plan / ask；adapter 与纯决定分开，调用方仅通过 `createPermissionAdjudicator(deps).check(call)`。
- Step 2：auto tiers；对拍返回值及全部可观察副作用顺序。
- Step 3：classifier clock/timer/signal 注入；证明重试、超时、取消与清理等价，再移除重复旧测试。

每步均为可运行、门禁通过的批次。fixture 来自旧 handler 的实际执行，禁止用新实现自动重写期望；不得因为拆了文件就宣称完成 module。FakePi 中的真实入口接线/装配/清理验证必须保留。

### C5 Goal lifecycle 深化

按 [P2-2](2026-10-07-p2-2-goal-lifecycle-module.md) 四步迁移，前置 C1。固定 C1 后的可达转移 trace，保留账本/磁盘/审计/clock/continuation 语义。

已被 P3-1 S6 删除的三个死函数不是新任务；目标是 pool/focus/drafting/turn flags 集中到 lifecycle，撤除过渡代理与外部第二份写权。clear/abort drafting 分支、审计中焦点变化和写盘失败必须有序列验收。旧代码搬进一个接受大量 getter 的壳不算完成。

建议默认顺序 C1 → C2 → C3 → C4 → C5。C4 与 C5 独立依赖，但同一仓库提交与共享台账串行管理。

## 4. 真实验收分工

- Core 负责 H-Q：隔离 agentDir / 项目 / 测试记录下启动两个真实 pi session，制造 session_start drain 重叠；保留日志和队列转移证据，确认同一记录仅一位 live owner，cap 之后候选仍可消费，失败/结束后无搁浅活 claim。已有子进程原语测试继续保留，不能代替真实宿主生命周期证据。**已验收(2026-10-08,PASS)**：四项全过，证据在 `test/evidence/2026-10-08-hq-dual-session-drain/`(脚本 `scripts/hq-drain-evidence.sh` 可复现;mismatch 记录最终去向一条 open note)。
- TUI agent 负责真实 footer、通知、usage 显示及 widget 顺序；详见配对后续规格。core 提供明确可消费 revision 与契约，读取其验收结果后更新本仓状态，不跨仓改写它的记录。
- 确实没有可用终端/模型或宿主能力时，写明已尝试命令、缺少的具体条件、可复现步骤和恢复方式；“需真机”本身不是停止尝试的理由。
- 原有 AR1005-RU-HOST / ST-HOST 与 XPKG-09-HOST 三个 todo 分别记账，不能用新 fixture 抵扣未取证事实；本批不宣称旧宿主 todo 自动关闭。

## 5. 自主检查与交付

每批更新验收映射、相关中英文文档/头注释/CHANGELOG/PROGRESS/DEVIATIONS，运行 check/test/contracts 三门；通过后做独立只读 spec + invariants 审查，修复并复审可行动发现。新缺陷先钉红再修，重构按固定基线对拍。

允许 agent 自主实现已确认范围、补测试、修审查问题并本地分批提交；常规技术选择无需再次确认。资源限额真的中断时，留下具体已完成 Step、最后绿色 revision、下一条操作与未通过项，不能将“预算问题”变成永久依赖或把半成品标成完成。

完成报告逐项给出 C1–C5 / H-Q 状态、提交、实际门禁、审查发现与解决情况、两仓联合证据；实现完成、自动化通过、真实验收通过必须分开记录。发布不属于本批。


## 6. 本轮规格复核记录

2026-10-08，独立只读 agent `spec_independent_audit` 核对两仓新规格/prompt、索引、相关旧规格 diff 和必要源码，结论：**可直接派发，未发现阻塞性矛盾**。确认三项决策已闭环、已完成部分不重复派发、C3→C4 与 C1→C5 基线顺序明确、D4 撤除/打包验收完整、两仓写入与真实验收分工可执行。

复核者独立调用真实 TUI 选择/渲染函数，再次复现 U-F1 的 `25%(50k/1.0M)`；并确认 C7-usage 现有证据仅为真实 bus + 手工 payload。新规格没有将其记为完整事件或终端验收。两仓 22 份当批规格/索引/prompt 的本地链接、表格、代码围栏与原 9+6 索引计数通过；git diff --check 通过。

此记录仅表示本轮文档可执行；新实现、U-F1 修复、生产事件联合覆盖与真实终端验收仍由下一轮执行。
