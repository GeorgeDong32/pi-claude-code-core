# SPEC SR — 拆分、阻塞等待与真机验收批（2026-11-15）

来源：E4（BH 非目标遗留）/ E13（goal.ts 与 modes/index.ts 拆分）/ CORE-17（PlanSession）/ 审查 P3 残留的死代码部分 / H-SC 真机验收清单。调查输入：四份 explorer 报告（goal.ts 切口、modes/index.ts 切口+PlanSession、TaskOutput 阻塞设计、真机前置条件，2026-11-15）。

## 用户决策

- **D-SR-1**：范围包括代码批 E4+E13、真机验收批，以及先装 0.6.0 并清理。
- **D-SR-2**：E13 的 modes/index.ts 拆分时同时做 PlanSession，借此关闭 CORE-17。
- **D-SR-3**：E4 通过给 `TaskOutput` 加 `block`/`timeout` 参数实现，不新增工具名。
- **D-SR-4**：真机验收用 rex 新开 pi 标签页，模型为 `CPA/glm/glm-5.3-flash`。
- **D-SR-5**：代码批只在本地提交，不 push、不发版、不打 tag。安装 0.6.0 已获授权，只限这一次。

## 内定取舍（审批时已确认）

| 项 | 取舍 |
|---|---|
| E4 timeout | 单位为秒，默认 30，最大 600。超过 600 直接报错，不截断，报错文案为 `timeout is in seconds (not ms); maximum is 600`。不带 `block:true` 时传 `timeout` 也报错。 |
| E4 用户插话 | 用户发消息（`input` 事件，且 source 不是 extension、处于 streaming）时结束等待，正常返回已有输出。照搬 pi-subagents 的 `bg_wait`。 |
| E4 非阻塞读 | 普通 TaskOutput 读到已结束的任务时，也调用 `claimCompletion`，补写状态条目并压缩日志。 |
| 死代码 | 拆分完成后，每个模块单独一个提交删除死代码，行为为零变化。goal 侧：`:138`、`:150-172` 和 9 个未用导入。modes 侧：`allowToolCall`、`projectRoot`、`PLAN_READ_TOOLS` 和未用导入。 |
| 缩进 | 新文件用 tab。modes/index.ts 中保留下来的行维持原有的 2 空格，不整体重排。 |
| S3 | 只测 GLM-5.3-flash。MiniMax 和 OpenAI 兼容端点继续列为待证据。 |
| 证据存放 | 原始证据只放在 `~/.cache/pi-core-acceptance/2026-11-15/`，不入库。仓库里只写摘要（SC-3 先例）。 |

```mermaid
flowchart LR
  P1[阶段1 装0.6.0+清理] --> P2[阶段2 三路代码批]
  P2 --> M[审查+合入+门]
  M --> P3[阶段3 W-H 真机]
  P3 --> L[台账提交]
```

---

## 阶段 1：安装 0.6.0 与清理（orchestrator，已完成 2026-11-15）

1. 两台机器安装 clone 均为干净树（426f8e9）。✅
2. `zsh scripts/sync-deploy-copies.sh 4ce33f8` 两台均成功。✅
3. 验证两台 HEAD = 4ce33f8。✅（运行中的 pi 会话需重启才加载 0.6.0，已提醒用户）
4. 清理：flow-report.json 已归档至 `.claude/archive/flow-report-2026-11-10.json`；sc-fix / sc-t1 worktree 已移除；w/sc-review-fix、w/sc-default-on、origin-mirror-verify 已删。✅

## 阶段 2：三路代码批（worktree 建在 spec 提交上，各自 pnpm install）

### W-B：E4 TaskOutput 阻塞等待（`extensions/bg-shell/**`、docs/{en,zh}/bg-shell.md）

- **registry 侧**：
  - 新增 `awaitTaskEnd(task, ms, signal)`，每 250ms 调一次 `refresh`；`endSession` 已把任务移出注册表时提前结束。
  - Task 加运行期 `waiting` 计数。计数 >0 时 `notifyOnce` 只结算状态、不发完成消息（覆盖所有 kill 路径）。
  - 新增 `claimCompletion(task)`：设 `notified`、追加状态条目、进程组已退出时压缩日志，不发完成消息。
- **TaskOutput 侧**：新增可选参数 `block`/`timeout`。等待结束方式：
  - 任务结束：返回 `readOutput` 结果并调用 `claimCompletion`。
  - 超时：返回 `readOutput` 结果，末尾加 `still running after N s`。
  - abort：抛 `Error("aborted")`，不读输出，读取位置与 `notified` 不动，完成消息照常由轮询发出。
  - 用户插话：正常返回已有输出。
- **验收**：
  - base 红证据先行：读取落在退出与下次轮询之间时不写状态条目。
  - 新测试覆盖：阻塞到退出时 `s.sent` 为 0；等待期间轮询不产生 followUp；超时；abort 后读取位置不变且完成消息照常送达；等待期间 deadline kill；参数校验；未知 id 立即报错。
  - 被钉住的描述子串 `so do not sleep or poll \`TaskOutput\`` 保持不变。
- **文档**：更新工具表；CC 偏离节注明 block 默认 false、单位为秒；header 注释同步。declaration-meter 不改。

### W-G：goal.ts 拆分（`extensions/goal/**`、docs/{en,zh}/goal.md、FORK.md）

- **先补钉测**（base 绿）：钉住 renderer、命令、工具、`pi.on` 事件各自的有序列表，以及工厂里那次 `setActiveTools` 调用。
- **拆出 6 个文件**（goal.ts 降到约 1140 行）：

| 文件 | 内容 |
|---|---|
| `goal-entries.ts` | 冻结 entry 常量、`goalDetails`、注入 id 解析 |
| `goal-turn-usage.ts` | 消息分类与四通道 token/cost 提取 |
| `goal-summary.ts` | 用量摘要、widget 投影、缺失 criteria 提示 |
| `goal-settings.ts` | `/goal-settings` |
| `goal-commands.ts` | `createGoalCommands(pi, deps)`，原顺序注册 16 命令，返回 `focusGoalCommand` |
| `goal-tools.ts` | `registerGoalTools(pi, deps)`，原顺序注册 8 工具；`getRunningGoalId` 以 getter 传入 |

- **约束**：默认导出签名 `(pi, deps = {})` 与 goal.ts 路径不变；15 个 `pi.on` handler、seam 单例、lifecycle/ui/loop 构造留在 goal.ts；两处靠提升按引用传入的函数改箭头包装；lifecycle 只以 `GoalLifecycle` 类型传入（#120 封装）；新文件不得出现 `type: "compaction"` 字面量；goal.ts 与新文件都要有 header 注释。
- **验收**：现有 goal 测试一行不改全绿；钉测拆分前后均绿；`git diff --color-moved` 自查逐字一致。

### W-M：modes/index.ts 拆分 + PlanSession（`extensions/modes/**`、docs/{en,zh}/modes.md、header 提到 index.ts 的同级文件）

- **先补 characterization 测试**（新文件 `extensions/modes/plan-flow.test.ts`，base 全绿）：agent_end offer 流程（hash 变化→弹窗→execute/refine）；60s 冷却与 suppress 窗口；turn_end `[DONE:n]`；plan-complete；`/plan-execute`（含执行期间、非 plan 模式）；plan_ready 无 UI 不执行；restore 只覆盖已有字段 + 旧模式名映射；`modes` 条目 `JSON.stringify` 键序；注册顺序快照（命令/工具/快捷键/flag + 17 个 `pi.on` 顺序）。
- **新增 `plan-session.ts`**：`createPlanSession(deps)` + `registerPlanSurfaces`。怪癖原样保留：`currentMode="auto"` 直接赋值；`planPhase` 在 publishCapability 的兜底；restore 只覆盖已有字段；冷却时间戳不持久化；`markPlanOfferHandled` 调两次；执行期间 agent_end 提前 return；`entryFields()` 返回原 todos 数组同一引用。
- **再拆 4 个文件**：`outside-writes-commands.ts`、`approval-flow.ts`、`forwarding-responder.ts`、`adjudication-facts.ts`。index.ts 降到约 1000–1100 行。
- **约束**：新文件平铺在 `extensions/modes/` 下（P1-EF-07 非递归扫描）；块注释不得出现 `setThinkingLevel`（该扫描只剥 `//` 注释）；不得出现 APP-04③ 禁止字面量；`adjudication-parity` golden 不变；rule family 每次调用惰性查找；依赖用闭包 getter 传入避免 TDZ。
- **验收**：现有 modes/契约/parity 测试一行不改全绿；characterization 拆分前后均绿。

### 共同纪律

- 只有 W-B 涉及行为修复，必须先拿 base 红证据；纯重构不改任何现有断言。
- 提交信息 `module(sr): ...`；死代码删除单独提交。
- INV-10（不新增 env/设置键）、P0-CT-08/09（entry 与磁盘布局不动）、`lib/` 不改。
- worker 不改 CHANGELOG/DEVIATIONS/PROGRESS/spec/README，台账草稿放最终报告。

### 审查与合入

- 每分支独立只读审查，两轴（Standards=AGENTS.md、Spec=验收矩阵）。E13 审查重点是行为等价，用 move 检测逐块核对。P1 合入前修。
- 合入顺序 W-B → W-G → W-M，rebase + ff。main 上四门零失败，用例数只增不减，记录各框架数字。

## 阶段 3：W-H 真机验收（合入后的 main 上执行）

- **沙盒**：`~/.cache/pi-core-acceptance/2026-11-15/`，真实路径（不用 /tmp）。core 快照 = `git archive` main + symlink node_modules；TUI 用已安装 clone（只读）；隔离 HOME 与 `PI_CODING_AGENT_DIR`；auth.json/models.json 复制进沙盒（不打印）；settings `packages:[]`，glm-5.3-flash modelOverrides `reserveTokens 880000` / `keepRecentTokens 8000`（T_n≈120K）；`core-compaction.json` `mode:"on"`。
- **探针扩展**：记录事件名+时间戳；message_end 记 leafId/branch 长度；记录 turn_start 与工具调用；定时器 setWidget（XPKG-09）。
- **启动**：每场景一个 rex 标签页（`rex window new ... -- pi --model CPA/glm/glm-5.3-flash -e ...`），`rex send`/`send-key` 驱动，`rex capture --trim` 截图，场景结束关标签页。
- **场景判据**（SC spec §7.3）：H-SC-1（多轮读大文件过 ~72K/~90K）、H-SC-2（/resume）、H-SC-3（比例组 0.98/0.99 且整组合法）、H-SC-4（/compact）、H-SC-5 后半（compaction.enabled=false）、H-SC-6（隔离 models.json 加死端口 summaryModel）、H-SC-7（沙盒 HOME 建临时 rex-flow 项目：开放+已闭环任务+诱饵 board；判不了"真实 run"则记待证据）、S3（只测 GLM）、AR1005-RU-HOST、AR1005-ST-HOST ⑪、XPKG-09-HOST 异步面（两种加载顺序）。
- **纪律**：每场景最多重试 2 次，仍不过记待证据并写原因；发现的缺陷只记录上报，本批不修。
- **产出**：沙盒 LEDGER + 截图；worker 起草 DEVIATIONS SC-3 更新、docs/{en,zh}/compaction.md 真机节、契约 README/测试注释宿主证据（不能自动化的保留 `it.todo`）。
- **抽查**：orchestrator 独立重读关键 jsonl 条目与截图。

## 台账（orchestrator）

- CHANGELOG 新增 `## Unreleased`：E4 用户可见（Added/Changed），E13 内部 Changed。
- DEVIATIONS 新增「拆分与真机验收批（SPEC SR）」节，更新 SC-3。
- PROGRESS 同日节；spec/README 新行；P3-1 行 CORE-17 改完成。
- 收尾：删 worktree 与临时分支；只本地提交。

## 非目标

- 不 push、不发版、不打 tag；不对外提交 FX-2 上游提案。
- 不改 compaction 模块代码；不碰 TUI 仓（有未推送提交）。
- 非 `&&` cd 追踪不做；SC-1 只积累遥测不裁决；真机发现的缺陷不修。
