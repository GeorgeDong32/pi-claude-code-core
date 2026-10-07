# Core 剩余任务执行 Prompt

将以下正文交给在 pi-claude-code-core 工作的 agent。

```text
继续自主实施 core 剩余任务。工作目录：
/Users/gd32/Coding/Pi-Extension/pi-claude-code-core

先读 AGENTS.md、spec/README.md、spec/2026-10-08-followup-execution.md，再按引用读取详细规格和 spec/2026-10-07-spec-review.md。以 2026-10-08 已确认决策覆盖历史“待决策”：D3=A，D4=B，D6=B，无需再询问。该授权包括按规格实现、测试、修复审查问题和分批本地提交。

先核对 HEAD/工作区与实际代码，不重做已落地的 plan gate、queue、drafting、instance/footer、memory writer/drain、usage 和 P3 独立小项。起始核对 revision 是 core 2ebd226、TUI 1bf9b7f；如果已推进，按实际 diff 续接。保留用户改动与本次更新但可能尚未提交的规格；创建分支/worktree 时带入最新文档。

按后续规格推进：
C1：goal 锁策略 A + G3 同批；保留既有 CORE-05。
C2：D4=B 删除 runtime reader/CoreStatus，保留纯类型、bus 和 legacy；先登记契约，再迁移测试，验证正式 package subpath。
C3：D6=B 无 UI 继续拒绝，追加具体 suggestedRule；不扩审批转发。
C4：在 C3 后固定基线，完成 permission 重构 Step 1–3。
C5：在 C1 后固定基线，完成 goal lifecycle 四步；已删死函数不重做。
H-Q：尝试隔离的真实双 session drain 验收，保留可复现证据。

每个批次：验收映射 → bug 基线失败证据或重构 trace → 实现 → bun run check / bun run test / bun run contracts → 独立只读 subagent 审查实际 diff 的 spec 符合性与不变量 → 修复并定向复审 → 本地提交。版本控制按仓库和可用技能执行。旧测试只能在新覆盖可证明等价时删减，禁止调整期望掩盖回归。若不支持 subagent，明确记录独立审查缺口并做第二遍自查。

只修改 core；TUI 作为只读依赖。提供绿色 core revision 给 TUI 联合验收，在本仓记录生产方就绪及待证据项；不要为了等对方验收停止独立任务。遵守 AGENTS 的依赖方向、冻结面、bus 同步发布、fail-open、JSON settings 和契约登记顺序。

同步实现对应的文档、头注释、CHANGELOG、PROGRESS、DEVIATIONS。普通选择自行决定；新范围冲突只暂停受影响项并继续其他工作。真机项先利用现有终端能力尝试，确实受限才列具体恢复条件。fixture 通过不冒充真实终端通过。

持续推进所有可执行项；若执行额度确实耗尽，留可恢复 checkpoint，不把尚未完成的重构标成已完成。交付本地提交和逐项实现/自动化/真机/审查记录；push、tag、发版另行安排。最后报告 C1–C5 与 H-Q 的实际状态、验证命令/结果、双方 revision 和剩余恢复条件。
```
