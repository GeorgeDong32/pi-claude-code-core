# spec/ — core 实现规格

2026-10-08 更新：原批次 **core 9 份 + TUI 6 份** 已完成大部分实现。用户已确认 **D3=A、D4=B、D6=B**，不再作为待用户决策阻塞。

下一轮从 [剩余任务执行规格](2026-10-08-followup-execution.md) 与 [core 执行 prompt](2026-10-08-execution-prompt.md) 开始；配对 [TUI 索引](../../pi-claude-code-tui/spec/README.md)。原审查与两轮规格核对保留在 [核对记录](2026-10-07-spec-review.md)。

当前核对 revision：core `2ebd226`，TUI `1bf9b7f`，宿主依赖 pi 1.0.1。原规格背景行号属于 core `09c2dcb` / TUI `7192d9f`，实施定位以函数与当前源码为准。

## 实际状态与续做范围

| 优先级 | spec | 清单项 | 当前状态 / 下一步 |
|---|---|---|---|
| P0-1 | [plan 权限优先级](2026-10-07-p0-1-plan-gate-precedence.md) | CORE-02 / 03 + FUS-SHAPE | 已实施；后续重构保留 D1/D2 与 MCP 扫描边界回归 |
| P0-2 | [goal 回合锁](2026-10-07-p0-2-goal-turn-lock.md) | CORE-01 / 05 + G3 | CORE-05 已实施；D3=A 已确认，锁策略 + G3 同批续做（C1） |
| P0-3 | [memory queue claim](2026-10-07-p0-3-memory-queue-claim.md) | CORE-04 | 已实施并完成复审修复；跨进程自动化绿，真实多 session 验收 open（H-Q） |
| P1-1 | [bus 跨包面](2026-10-07-p1-1-bus-surface-for-cctui.md) | CORE-07 / 08 / 09 / 10 | instance/footer/契约已实施；D4=B reader 删除待做（C2）；真实 footer 联验 open |
| P2-1 | [permission 裁决 module](2026-10-07-p2-1-permission-adjudication-module.md) | CORE-12 / 18 | 0/3 步；先 C3 再固定基线迁移（C4），无决策阻塞 |
| P2-2 | [goal lifecycle module](2026-10-07-p2-2-goal-lifecycle-module.md) | CORE-13 | 未实施；C1 通过后固定基线迁移（C5） |
| P2-3 | [memory writer + drain](2026-10-07-p2-3-memory-writer-and-queue-drain.md) | CORE-14 / 15 | 必做已实施；消息文本扁平化可选未做 |
| P2-4 | [结构化用量](2026-10-07-p2-4-structured-usage-channel.md) | CORE-11 | core d539346 已发布，TUI 710c9c7/1bf9b7f 已消费；完整生产事件与真机联验 open |
| P3-1 | [小型重构与清理](2026-10-07-p3-1-small-refactors-and-cleanup.md) | CORE-06 / 16 / 17 / 19 | S1/S2/S4/S5/S6 已实施；D6=B 的 S3 待做（C3） |

CORE-01…19 全部有去向。CORE-17 本批只完成 startPlanExecution，完整 PlanSession 仍暂缓；不得在台账中记为完整生命周期重构。

## 已确认决策

| # | 用户选择与当前含义 |
|---|---|
| D1 | plan 下 read 命中 ask 照常询问并尊重结果 |
| D2 | 已授权 MCP 可用，其他 edit 不可借 allow 绕过 plan 硬限制；保留既有 family 首次询问 |
| D3 | **A，用户 2026-10-08**：仅四种真停止成功后锁回合；原进度名单不扩大；G3 同批 |
| D4 | **B，用户 2026-10-08**：删除 runtime reader/CoreStatus，保留纯类型入口；不撤 bus/legacy，不代表已发布 |
| D5 | TUI 启用由 cc-footer 展示，core modes footer 实际安装时由它展示；off 恢复 stock，没有自动交回 |
| D6 | **B，用户 2026-10-08**：无 UI first-seen 继续拒绝，补具体预置规则提示；不扩父会话转发 |

## 下一轮约定

- 默认 C1 → C2 → C3 → C4 → C5；C4 冻结在 C3 后，C5 冻结在 C1 后，避免对拍误消除本轮已批准变化。
- 跨包面先登记契约再写测试；正式入口 type-only import 与 runtime 删除负例纳入 D4 验收。
- core 三门使用 bun run check/test/contracts；TUI 双门使用 npm test/typecheck。2026-10-08 基线全部退出 0，详细数量与日志见后续规格。
- 实现、自动化、真实宿主验收分开记；保留 3 个现有 host todo 的各自证据状态。TUI 已完成 usage 第二步，不再等待其“开始实施”。
- 每批独立只读审查与修复；同步实际文档和台账，未完成项写具体恢复步骤。提交已在本地存在，push/发布另行安排。
