# SPEC P3-1：小型重构与清理批

状态：规格已补齐；S3 待用户 D6，其余可独立实施
日期：2026-10-07
分支：main
来源：2026-10-07 联合架构审查，清单项 CORE-06 / CORE-16 / CORE-17（第一步）/ CORE-19

## 1. 条目总览

| # | 条目 | 类型 | 证据 |
|---|---|---|---|
| S1 | review 的三份命令执行 adapter 合一 | 重构 | `review/src/review-report.ts:144-175`、`target-workspace.ts:28-62`、`review-run.ts:383-420, 575` |
| S2 | plan→auto 执行转移合一（`startPlanExecution`） | 重构 | `modes/index.ts:1043-1060`、`1161-1182`、`1964-1981` |
| S3 | firstSeenPrompt 在无 UI 时的行为（**需决策 D6**） | 功能 | `modes/index.ts:911-917`（对照 `395-446`） |
| S4 | web-gov / mcp-gov 的 JSON 读取改走 `lib/settings.ts`，并缓存 | 不变量 10 | `web-gov/index.ts:43-56, 113`、`mcp-gov/panel.ts:22-30` |
| S5 | review：删除不可达的 `diff-file` target；去掉重复的 `git status` | 死代码 / 性能 | `cli-args.ts:30-36`（`--diff` 已列为废弃 flag）、`review-run.ts:234-238, 294, 549`、`target-workspace.ts:103, 122-129`、`types.ts:177-188` |
| S6 | 死代码与未用 import | 清理 | 见 §2.6 |

## 2. 设计

### 2.1 S1 review run-cmd

- 新建 `review/src/run-cmd.ts`，导出 `RunCmd` 类型、`runCmd`、`setRunCmd`、`resetRunCmd`；spawn 实现取 `review-report.ts:159-175` 版本（保留错误信息）。
- 三个文件改为 import 这一份；删除 `setReviewRunCmd`、`setTargetWorkspaceCmd` 及 `review-run.ts:575` 的转导出。测试统一使用 `setRunCmd`。
- 决策：放弃"每个文件独立注入"的灵活性。合并后每个测试必须在 finally/afterEach reset，禁用共享全局 stub 的并发执行；fake 按 cmd + cwd 分派。先比较三个 adapter 对 spawn error / nonzero exit / stderr 的实际返回语义，不可用“保留错误信息”掩盖行为差异；如不同，则共用底层 transport，保留 caller 格式化。

### 2.2 S2 startPlanExecution

- 新增闭包内函数 `startPlanExecution(ctx, todos)`，按 `/plan-execute` 版本（`1043-1060`）的完整顺序执行：设置状态 → `applyToolRestrictions` → `clearModesStatus` → `updatePlanWidgetUi` → `persistState` → `applyForMode("auto")` → `sendMessage(modes-execute)`。
- 三处调用改为调用它。行为差异：`plan_ready` 路径在转移后多一次 `updatePlanWidgetUi`——这是可见 widget 同步修正，需记 CHANGELOG；失败发送与模型 profile 应用的原有顺序保持。
- PlanSession（把 planPhase / todos / offer 冷却收拢为一个 module）不在本批，视收益另议。

### 2.3 S3 firstSeenPrompt 无 UI（D6）

| 候选 | 做法 | 风险 |
|---|---|---|
| A | 复用 `promptWithPermissionOptions` 的父会话转发分支 | 父会话的"Allow always"会经 `suggestAllowRuleForToolCall` 生成规则，而该函数面向内置工具，对 MCP canonicalId 需要单独适配 |
| **B（推荐）** | 维持 fail-closed，block reason 补一句"可在父会话预置 `<suggestedRule>` 规则"，并写进 docs | 子代理首次调用 MCP 仍会被拒，但用户能看到如何解决 |

推荐 B。若选 A，另立 spec，与转发协议（P0-CT-05）一起评估。

### 2.4 S4 JSON 读取

- `loadPreapprovedDomains` 改为 `readJson(path, fallback, onInvalid)`（第三参数是回调，不能传 options 对象）。坏文件时 `console.warn` 一次，不再静默回落到内置列表。
- 缓存 key 包含配置绝对路径与 stat 指纹（mtimeMs + size + inode）；每次裁决可做 stat，命中时不 read/parse。missing 静默回默认；删除、创建、原子替换、路径切换均失效。空文件/非对象/坏 JSON 也走 fallback，按路径+指纹至多 warn 一次；警告回调不得抛。mtime 不能检测任意保留时间戳且等长的外部原地修改，此限制写入文档，不假称所有修改即时可见。
- `mcp-gov/panel.ts` 的 `mcp.json` 读取同样改走 `readJson`。

### 2.5 S5 review 死路径

- `--diff` 已被 `cli-args.ts:34` 列为"已移除、静默跳过"的 flag，`diff-file` 类型因此不可达。删除：
  - `ReviewTargetKind` 中的 `"diff-file"` 与 `ReviewTarget.diffPath`（注意 manifest 里的 `diffPath` 是另一个字段，保留）；
  - `review-run.ts:234-238` 分支、`target-workspace.ts:122-129` 分支。
- 不跨 await 复用早先的 git status：resolveReviewTarget 与 acquireLocalDiff 之间可能发生 workspace 选择/等待，复用会漏掉用户新改动。应删除较早的重复采样，让 acquireLocalDiff 在最终 cwd 上采样一次，并返回用于 label/hint 的同一份 dirty 信息。PR 路径与最终 workspace 规则发现顺序保持 AR1005-RV 语义。
- 删除 diff-file 分支前全仓检查入口及历史 manifest reader；只删新运行不可达的构造路径，不改旧 manifest 数据的读取能力。CLI 已移除 --diff 的提示也保留，不能用源码“零字符串命中”作为验收。

### 2.6 S6 清理清单

- `goal.ts`：`updateFocusedGoal`（`583-594`）、`removeFocusedGoal`（`601-610`）、`draftingHiddenWorkTools`（`391-402`）——若 P2-2 先做，则由 P2-2 处理。
- `modes/index.ts:1321-1326`：`if (!ctx.hasUI) { if (ctx.hasUI) uiNotify(...) }` 不可达。删除不可达内层判断，保留原 return；不顺手新增日志行为。
- 未使用的 import：`modes/index.ts:19` `visibleWidth`、`:28` `isBypassActive`；`memory/index.ts:64-65` `MEMORY_INDEX_MAX`、`USER_INDEX_MAX`。
- review：死导出 `adaptReviewer`（`report-tool.ts:52-75`）、`localScratchDir`（`review-report.ts:271`）、`writeWorkspaceMarker` / `clearWorkspaceMarker`（`target-workspace.ts:223-239`）；`void safeListDir` 之类的抑制行（`review-report.ts:121, 130, 250`、`review-run.ts:577`），以及 `tool-wrapper.ts:82` 的 `void ctx`。
- `memory/session-recall.ts:2` 头注释："ONLY tool" → 说明 `memory_consolidate` 另由 `consolidate.ts:249` 注册。
- `goal.ts:1552` 的 nudge 文案写的是"this turn"，但计数器跨 turn 保留 → 改为 "recently"。

## 3. 测试与门禁

- S1：review 测试改用单一 `setRunCmd`，零断言变化。
- S2：现有三条执行路径测试零改动通过；新增 `plan_ready` 转移后 widget 更新的断言。
- S3（方案 B）：断言 reason 中包含建议规则。
- S4：坏 JSON 时 warn 一次并回落；mtime 不变时不重复读文件（spy `readFileSync`）。
- S5：review 全套通过；旧 manifest fixture 可读；最终 workspace 的 status 只采一次，用户在前期 await 中修改文件时仍进入 dirty diff 路径。
- 每项单独 commit，三绿。

## 4. 台账

`CHANGELOG.md` 记 S2 / S3 / S4 以及 nudge 文案的可见变化；`DEVIATIONS.md` 记录 S5 删除的类型分支；`PROGRESS.md` 记录本批次。
