# docs/ — Architecture Documentation

Bilingual, split by language: English under [`en/`](en/), 中文 under [`zh/`](zh/).
The two trees mirror each other file-for-file — keep them in sync.

> 双语分文件:英文在 [`en/`](en/),中文在 [`zh/`](zh/)。两侧目录逐文件对应,
> 修改时保持同步。

## Reading order / 阅读顺序

| # | English | 中文 | Topic |
|---|---|---|---|
| 0 | [AGENTS.md](../AGENTS.md) | [AGENTS.zh.md](../AGENTS.zh.md) | Working guide for this repo / 本仓库工作指引 |
| 1 | [en/architecture.md](en/architecture.md) | [zh/architecture.md](zh/architecture.md) | Overall architecture / 总体架构 |
| 2 | [en/lib.md](en/lib.md) | [zh/lib.md](zh/lib.md) | Shared `lib/` primitives / 共享原语 |
| 3 | [en/bus.md](en/bus.md) | [zh/bus.md](zh/bus.md) | Capability bus / 能力总线 |
| 4 | [en/modes.md](en/modes.md) | [zh/modes.md](zh/modes.md) | Permission modes / 权限模式 |
| 5 | [en/effort.md](en/effort.md) | [zh/effort.md](zh/effort.md) | Thinking effort / 思考档位 |
| 6 | [en/goal.md](en/goal.md) | [zh/goal.md](zh/goal.md) | Goal lifecycle + sisyphus / 目标生命周期 |
| 7 | [en/review.md](en/review.md) | [zh/review.md](zh/review.md) | Fan-out code review / 代码评审 |
| 8 | [en/rules.md](en/rules.md) | [zh/rules.md](zh/rules.md) | Rules injection / 规则注入 |
| 9 | [en/memory.md](en/memory.md) | [zh/memory.md](zh/memory.md) | Memory / 记忆 |
| 10 | [en/mcp-gov.md](en/mcp-gov.md) | [zh/mcp-gov.md](zh/mcp-gov.md) | MCP governance / MCP 治理 |
| 11 | [en/web-gov.md](en/web-gov.md) | [zh/web-gov.md](zh/web-gov.md) | Web rule family / Web 规则族 |
| 12 | [en/action-fusion.md](en/action-fusion.md) | [zh/action-fusion.md](zh/action-fusion.md) | then_run fusion / 动作融合 |
| 13 | [en/observation-pack.md](en/observation-pack.md) | [zh/observation-pack.md](zh/observation-pack.md) | Result projection / 结果投影 |
| 14 | [en/ui.md](en/ui.md) | [zh/ui.md](zh/ui.md) | UI adapters / 呈现适配层 |

Related docs outside `docs/`: [test/contracts/README.md](../test/contracts/README.md)
(contract table), [DEVIATIONS.md](../DEVIATIONS.md), [PROGRESS.md](../PROGRESS.md),
[extensions/goal/FORK.md](../extensions/goal/FORK.md).
