# spec/ — core 实现规格

2026-10-09 更新：**C1–C5 全部完成**（C5 经封装收口批重做为真终态，DEVIATIONS #120）；bare MCP 退化输入验收（TUI 侧 H-T2j）与 XPKG-09-HOST 时序因果勘误已由 TUI 2026-10-09 批取证，配对 revision core `c4dab5f`。用户已确认 **D3=A、D4=B、D6=B**。

历史执行入口：[剩余任务执行规格](2026-10-08-followup-execution.md) 与 [core 执行 prompt](2026-10-08-execution-prompt.md)；配对 [TUI 索引](../../pi-claude-code-tui/spec/README.md)。原审查与两轮规格核对保留在 [核对记录](2026-10-07-spec-review.md)。

## 新增：Smart Compaction（2026-11-08，**已实施完成 W0–W9**，2026-11-09）

| spec | 内容 | 状态 |
|---|---|---|
| [Smart Compaction — 接管式压缩控制器](2026-11-08-smart-compaction-takeover.md) | 第 14 个模块 `extensions/compaction/`：后台预压 + 语义切点 + 确定性台账（含 rex-flow orchestrator 档）+ boundary draft **提议并经对账确认提交**，原生仅兜底（供稿腿同样受硬容量闸）；含 W0–W9 派工拆分、阻断性宿主用例 BLK-1…5 与验收矩阵 | W0–W9 全部落地（2026-11-09）：BLK-1…5 保护断言 7/7 绿（真实 AgentSession）、三门全绿；默认 mode 临时 shadow（M1=0.52<0.90，DEVIATIONS SC-1）；真机已验加载/运行/遥测/off 无痕，TUI 与 rex-flow 真机项列待证据（DEVIATIONS SC-3）；旧草案 [候选 A](2026-11-08-smart-compaction.md) 已被取代 |

## 新增：PiSession 回测加固（2026-11-14，BH）

| spec | 内容 | 状态 |
|---|---|---|
| [PiSession 回测加固（P0–P2）](2026-11-14-backtest-hardening.md) | Devin 会话审查补完 + 本机/Air 回测驱动：S1/S2 安全、R1–R7 真实损失、E1–E4 资源与 IO、E5/E6 先复现再修；4 路按模块并行派工（W-A modes / W-B goal / W-C economy / W-D memory+web），独立只读审查后合入 | **已实施完成（2026-11-14）**：13 项全部落地（E5/E6 复现成立并修复），main `dd35b18` 三门 + 金丝雀全绿（唯一红为既有环境敏感项 review-degradation，见 DEVIATIONS BH-10）；台账见 CHANGELOG Unreleased + DEVIATIONS BH-1…10 + PROGRESS 同日节 |

## 新增：回测加固后续小修（2026-11-14，FX）

| spec | 内容 | 状态 |
|---|---|---|
| [回测加固后续小修](2026-11-14-followup-small-fixes.md) | BH 遗留：FX-1 review-degradation 红项修复 + 本地 fetch 时限（D-FX-1）、FX-2 E5 边界方案 B 覆盖全部宿主切模型途径（D-FX-2）、FX-3 memory 25K 核实、FX-4 SC 默认开启效果评估（含 Air 只读取数，D-FX-3）、FX-5 review/ 模块深度审查；三路并行（W-R/W-E/W-M） | **已实施完成（2026-11-14）**：FX-1…5 全部落地，main `c58ec84` 三门 + 金丝雀全绿且 **test 零失败**（BH-10 关闭）；FX-3 结论 base 即绿无缺陷、FX-4 结论数据不足（SC-1 遗漏仍未裁决）；FX-5 深审 P0=0/P1×1 已修/P2×2+P3×9 记录（REPORT 见仓库根）；三路独立审查均 PASS-with-nits（nit 已修）；台账见 CHANGELOG Unreleased + DEVIATIONS FX-1…6 + PROGRESS 同日节 |
| [清理与加固](2026-11-15-cleanup-hardening.md) | CH 批：review/ 深审遗留 R2–R12（R9 记录、R11 三处对账 D-CH-2、R12 干跑只取元数据 D-CH-3）、Standards 六异味 S1–S6、run-cmd 超时加固 T1–T4（SIGKILL 升级/竞态/≤0 语义/结构化 timedOut）、D1 memory inFlight 钉测 + D2 FX-2 上游提案草稿、BH P3 小项 E1–E12（E4/E13 不做；E1 放行 cd + 路径追踪 D-CH-4）；三路并行（W-R/W-M/W-B） | **已实施完成（2026-11-15）**：22 提交合入（W-B→W-M→W-R 变基 ff），main `d9e610b` 三门 + 金丝雀全绿且 test 零失败（vitest 1249 / node:test 1108）；三路审查均 PASS-with-nits（W-M 审查 P1 引号并置绕过合入前修复 `62a405d`）；E12 directive −26%（15,311→11,363 字符）；台账见 CHANGELOG Unreleased + DEVIATIONS CH-1…10 + PROGRESS 同日节 |
| [拆分、阻塞等待与真机验收](2026-11-15-split-wait-realhost.md) | SR 批：E4 TaskOutput 阻塞等待（block/timeout 秒制）、E13 goal.ts / modes/index.ts 拆分（modes 侧连带 PlanSession，关闭 CORE-17）+ 死代码清理；W-H 真机验收（rex + glm-5.3-flash：H-SC-1…7 + S3-GLM + AR1005-RU/ST-HOST + XPKG-09 异步面）；先装 0.6.0（两机）并清理 sc-* 残留 | 已批准（2026-11-15），实施中：阶段1 两机已装 4ce33f8 并清理完成；三路并行（W-B/W-G/W-M）后接 W-H 真机 |

## 实际状态与续做范围

| 优先级 | spec | 清单项 | 当前状态 |
|---|---|---|---|
| P0-1 | [plan 权限优先级](2026-10-07-p0-1-plan-gate-precedence.md) | CORE-02 / 03 + FUS-SHAPE | 已实施（含 D1/D2 与 MCP 扫描边界回归） |
| P0-2 | [goal 回合锁](2026-10-07-p0-2-goal-turn-lock.md) | CORE-01 / 05 + G3 | 已实施（D3=A 锁策略 + G3 input 修正，C1 批） |
| P0-3 | [memory queue claim](2026-10-07-p0-3-memory-queue-claim.md) | CORE-04 | 已实施并完成复审修复；跨进程自动化绿，真实多 session 验收 H-Q 已闭环（双真实 pi session drain PASS） |
| P1-1 | [bus 跨包面](2026-10-07-p1-1-bus-surface-for-cctui.md) | CORE-07 / 08 / 09 / 10 | instance/footer/契约已实施；D4=B reader 删除已实施（C2）；真实 footer 联验已执行（TUI H-T 批）；XPKG-09-HOST 证据已回填，todo 收窄至「非 session_start 时刻的任意异步注册」（时序因果 2026-10-09 已勘误校正） |
| P2-1 | [permission 裁决 module](2026-10-07-p2-1-permission-adjudication-module.md) | CORE-12 / 18 | 已实施 3/3（C4，含独立审查修复） |
| P2-2 | [goal lifecycle module](2026-10-07-p2-2-goal-lifecycle-module.md) | CORE-13 | 已实施（四步 + 2026-10-09 封装收口批＝真终态，DEVIATIONS #120） |
| P2-3 | [memory writer + drain](2026-10-07-p2-3-memory-writer-and-queue-drain.md) | CORE-14 / 15 | 必做已实施；消息文本扁平化可选未做 |
| P2-4 | [结构化用量](2026-10-07-p2-4-structured-usage-channel.md) | CORE-11 | core 已发布，TUI 已消费；完整生产事件联验（J-USAGE）与真机联验均已执行 |
| P3-1 | [小型重构与清理](2026-10-07-p3-1-small-refactors-and-cleanup.md) | CORE-06 / 16 / 17 / 19 | S1–S6 已实施（含 D6=B 的 S3）；CORE-17 完整 PlanSession 生命周期仍暂缓 |

CORE-01…19 全部有去向。CORE-17 本批只完成 startPlanExecution，完整 PlanSession 仍暂缓；不得在台账中记为完整生命周期重构。剩余 OPEN 项：经济模块降级行真机证据（结构性不可达，见 TUI followup 规格 §10）、AR1005-RU-HOST/ST-HOST 两个 host todo（各自证据状态未变）、XPKG-09-HOST 收窄后的异步面。

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
