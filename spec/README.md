# spec/ — core 实现规格

2026-10-07 联合审查已拆成 **core 9 份 + TUI 6 份**。本批当前完成的是规格编写与源码核对，代码均未实施；D3、D4、D6 保留为待用户决策。配对入口：[TUI spec 索引](../../pi-claude-code-tui/spec/README.md)。

依据：core `09c2dcb`（0.3.0）、TUI `7192d9f`（1.9.0）、本地 pi 1.0.1。文中的旧行号仅用于定位此基线，以文件/函数名为准；新文件明确标注为拟新增。续写来源与勘误见[规格核对记录](2026-10-07-spec-review.md)。

## 规格与前置条件

| 优先级 | spec | 清单项 | 规格状态 / 实施前置 |
|---|---|---|---|
| P0-1 | [plan 权限优先级](2026-10-07-p0-1-plan-gate-precedence.md) | CORE-02 / 03 + FUS-SHAPE | 已补齐；D1/D2 原则已定；含真实 then_run 对象检查 |
| P0-2 | [goal 回合锁](2026-10-07-p0-2-goal-turn-lock.md) | CORE-01 / 05 + G3 | 已补齐；锁策略与 G3 一起待 D3；仅 CORE-05 可独立实施 |
| P0-3 | [memory queue claim](2026-10-07-p0-3-memory-queue-claim.md) | CORE-04 | 已补齐；跨进程、回收、GC、混合版本和崩溃窗口均有验收 |
| P1-1 | [bus 跨包面](2026-10-07-p1-1-bus-surface-for-cctui.md) | CORE-07 / 08 / 09 / 10 | 已补齐；先登记契约，与 TUI P0-2 联合验证；reader 去留待 D4 |
| P2-1 | [permission 裁决 module](2026-10-07-p2-1-permission-adjudication-module.md) | CORE-12 / 18 | 已补齐；依赖 P0-1，按冻结基线 trace 对拍 |
| P2-2 | [goal lifecycle module](2026-10-07-p2-2-goal-lifecycle-module.md) | CORE-13 | 已补齐；依赖 P0-2（包括 D3） |
| P2-3 | [memory writer + drain](2026-10-07-p2-3-memory-writer-and-queue-drain.md) | CORE-14 / 15 | 已补齐；writer 可独立做，drain 依赖 P0-3 |
| P2-4 | [结构化用量](2026-10-07-p2-4-structured-usage-channel.md) | CORE-11 | 已补齐；先登记 XPKG-08；配对 TUI P1-2 第二步 |
| P3-1 | [小型重构与清理](2026-10-07-p3-1-small-refactors-and-cleanup.md) | CORE-06 / 16 / 17 / 19 | 已补齐；仅 S3 待 D6；CORE-17 本批只做 startPlanExecution |

CORE-01…19 均有去向。CORE-17 的完整 PlanSession 深化本批明确暂缓，仅收敛三条执行转移；不要把它记成完整生命周期重构完成。可选项（消息扁平化、effort pin、ANSI 合并）可以不做，实施报告须区分必做/可选/暂缓。

## 用户决策与实现解释

| # | 原要求 / 问题 | 本规格采用的结论 |
|---|---|---|
| D1 | “照常询问” | plan 下 read 命中 ask 要询问并尊重 Allow/Block |
| D2 | “Allow 的 MCP 可以用，但是别的 edit 不能用” | plan 硬限制不被 allow 解锁；经 family 规则/session/现有首次询问批准的 MCP 可以用。保留首次询问是实现解释，不声称用户另选过 B/C |
| D3 | “这个是啥东西，展开讲讲” | **待定**。推荐 A：仅四个真停止工具锁住本 turn；其他工具不锁，也不扩大进度名单。P0-2 已展开后果与 A/B/C/D |
| D4 | 询问 reader 与 TUI 是否兼容，允许考虑删除 | **待定**。源码确认本地 TUI 无调用，不证明不兼容；删除仅为提案，未选定前保留运行时 reader 与断言。instance/footer 不受阻 |
| D5 | “Foot 的话以 tui 为准” | cctui 启用由 cc-footer 渲染，core modes footer 实际安装时由它渲染；off 恢复宿主 stock，不自动交回 core，届时该通道不显示 |
| D6 | firstSeenPrompt 无 UI / 子代理时如何做 | **待定**。推荐 B：维持拒绝并提示建议规则；A 的父会话转发需单独扩展协议，尚未获选择 |

## 建议实施顺序

1. core P0-1、P0-3、P0-2 的 CORE-05 drafting 复位；TUI P0-1 可独立推进。
2. core P1-1 的 instance/footer/契约 → TUI P0-2 联合验收两种加载顺序、reload、native footer 与 off 的真实槽位；reader 变更另等 D4。
3. TUI P1-1 与 P1-2 第一步；core P2-4 → TUI P1-2 第二步。
4. D3 确认并同批落地 P0-2 锁策略 + G3 后做 goal lifecycle；permission 在 P0-1 后；drain 在 P0-3 后；ReplicaSession 在 TUI 两份 P0 后。
5. P3 独立小项按收益插入，S3 等 D6；共享文件重构串行落地，避免并发搬移互相覆盖。

## 验收约定

- “规格已补齐”不等于用户批准全部建议或代码已实现。实施后才填实际 commit、测试日志和未完成的真机项。
- 跨包面先登记 `test/contracts/README.md` 再写测试；本轮仅给出拟登记内容，不提前改生效契约。
- bug 先在冻结基线证实红因，再修绿；纯重构用行为 trace/golden 等价验证，不要求无意义的红测试。
- core 三门走 `bun run check`、`bun run test`、`bun run contracts`；TUI 双门走 `npm test`、`npm run typecheck`。不直接调用 tsc/vitest 绕过 core 脚本。
- 未获得宿主事实的契约用带目标批次的 test.todo；真机视觉项独立记录，不能用 fake 测试冒充。
- 代码实施时同步头注释、中英架构文档、CHANGELOG 与 PROGRESS；偏离历史 spec 登记 DEVIATIONS。本批只写 spec，不提前宣称这些交付已发生。
