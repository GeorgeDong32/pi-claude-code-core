# review — 扇出代码评审

> 中文版。English: [../en/review.md](../en/review.md)

**目录**:`extensions/review/`
**来源**:并入自 `@georgedong32/pi-review` 0.8.6(P2)

## 做什么

三步扇出代码评审流水线:

1. `/review` 解析目标(分支/PR/diff),准备 diff + 目标仓库检出,写入
   `.pi/pi-review/runs/<runId>/manifest.json`。
2. 隐藏 directive 指示主 agent 用生成的 workflow script 调一次
   `subagent({...})`。脚本经 `runs.all([...])` 扇出评审子代理,把各子代理的
   `structuredOutput` 喂给 `runs.run("gate")`。每个子代理都传 `cwd` 与
   `outputSchema`。
3. 主 agent 携 workflow 返回值调用 **`pi_review_report`** 工具。工具重新
   校验输出、在代码中强制裁定、持久化 session entry、渲染确定性 markdown。

不写任何项目级权限文件 —— diff/clone/fetch 走扩展自己的 `pi.exec`;评审
子代理只需要 read/grep 和几条只读 git 命令。

## 关键表面

- **命令**:`/review`、`/review-config`、`/review-agents`、`/review-show`。
- **工具**:`pi_review_report`(`src/tool-wrapper.ts` 注册)。
- **评审角色**(`agents/*.md`):`bugbot`、`code-comments`、`conventions`、
  `gate`、`history-context`、`lite-review`、`rulesheriff`、
  `security-review` —— 经 `pi.subagents` manifest 字段注册为 subagent 定义。
- **配置**:`.pi/pi-review.json`(磁盘布局冻结,P0-CT-09);模型解析走
  `lib/model-id.ts`。
- **总线**:`review` 通道 —— `{ status: "idle" | "running" | "done", lastRunAt }`。
- **Session entry**:`pi-review` / `pi-review-directive` 类型(P0-CT-08)。

## 内部地图

| 文件 | 说明 |
|---|---|
| `index.ts` | 装配:命令、report 工具、TUI 渲染器 |
| `src/review-run.ts` | `prepareRun`:目标解析、diff 准备、manifest。**AR1005-RV(2026-10-05)**:规则发现(`discoverRulePathsLocal`)在 workspace 重试/HEAD 检查全部落定**之后**、以**最终 `workspacePath`** 运行 —— 目标仓拥有"哪些规则适用于本次变更"(其 AGENTS.md / .pi/rules),而配置加载、run artifacts 与 manifest/diff/workflow 写入仍锚定**调用者 cwd**。manifest.rulePaths、ChangeProfile.rulePaths、rulesheriff 路由与 directive 消费同一份 prepared 值;冻结的相对路径数组形状不变。基线缺陷:调用仓无规则而目标仓有规则时得到 `rulePaths: []` 并静默跳过 rulesheriff |
| `src/directive.ts` | 隐藏 directive 文本(workflow script 契约) |
| `src/gate-enforce.ts` | 裁定在代码中强制(report 工具侧) |
| `src/report.ts`、`review-report.ts` | 确定性 markdown 渲染 |
| `src/tool-wrapper.ts` | `pi_review_report` 注册/校验 |
| `src/config.ts` | 配置读/合并/校验/写 |
| `src/cli-args.ts`、`pr-ref.ts`、`target-workspace.ts` | 参数解析、PR 引用、检出 |
| `src/lean-agents.ts` | 精简评审角色选择 |
| `src/tui-renderer.ts` | TUI 内运行状态 |
| `reference/` | 评审参考资料 |

## 不变量与坑

- 裁定**在代码中**强制(`gate-enforce` + report 工具),不交给模型自由
  裁量。
- runs 在 `.pi/pi-review/runs/<runId>/` 下只追加——绝不改动历史 run 的
  产物。
- 评审子代理只读;不要在 workflow script 里给它们写工具。
- 本地 base fetch(`acquireLocalDiff` 里的 `git fetch origin <base>`)是
  尽力而为:硬上限 15s(`LOCAL_BASE_FETCH_TIMEOUT_MS`,D-FX-1)且
  `GIT_TERMINAL_PROMPT=0`——超时或失败都回落本地 `origin/<base>` 引用并记
  非致命 `diffWarning`("timed out" / "failed" 两种文案)。不可配置;PR 路径
  命令(`gh pr view/diff`、clone、PR head fetch)不动。
- **PR 干跑(`/review --no-spawn <PR>`,R12/D-CH-3)**:只取元数据——只跑
  `gh pr view` + `gh pr diff`;绝不调用 `prepareWorkspace`(不 clone、不
  fetch)。摘要输出 `workspace: not cloned (dry run)`,rules/history 标为
  `not computed (dry run)`。干跑仍会写 run 目录(manifest + diff),由 24h
  清理回收。本地目标行为不变。
- **总线对账(R11/D-CH-2)**:`review.status` 在三处对账——`agent_end`
  (live run 的 agent 轮次结束却没落地报告 → 复位 idle;仅由指令消息本身
  武装——`message_start` 且 customType 为 `pi-review-directive`,CH-8b——
  无关的 agent 轮次或排队中的指令都不会误复位)、`session_start`(跨
  session 残留的 running)、新 `/review` 入口(无 live run 跟踪时复位残留
  running)。只用现有三个状态。
- **超时(`run-cmd.ts`,T1–T3,T5/CH-8a)**:超时先 SIGTERM,2s
  (`RUN_CMD_KILL_GRACE_MS`)后 SIGKILL;子进程已死但管道被孙进程占住时,
  短暂排水(`RUN_CMD_PIPE_DRAIN_MS`)后 destroy stdio,调用有界返回;
  计时器触发时子进程已退出的,按真实退出码返回(不算超时)——判定推迟一
  个 check-phase 跳(setImmediate),计时器到期前已死的子进程按已送达的
  退出码分类,而非过期的 `exited` 标志(在该 poll 之后、check 之前才退出
  的子进程与 deadline 本质上同时,属固有边界);`timeoutMs ≤ 0` 或非有限
  值 = 不设上限(Node 惯例)。超时结果带结构化 `timedOut: true` 字段
  (T4/S5)——stderr 里的说明文字保留给人看。
- 超过 `UNTRACKED_FILE_MAX_BYTES`(1 MB,R3)的 untracked 文件得到只写
  大小的占位 hunk(不读内容),并在 `diffWarning` 里计数;PR HEAD 守卫的
  重取失败分支是硬错误(R2),不再静默放行。
- 生成的 workflow script 中,各评审者共用的提示行只生成一次(E12:
  `baseTask` / `diffOnlyExtra` / `userTask` 常量);每个评审者的最终
  prompt 与去重前逐字节一致(由 `tests/workflow-task-golden.json` 钉住),
  整个 directive 受 `REVIEW_DIRECTIVE_MAX_CHARS` 上限约束。

## 测试

`extensions/review/tests/` —— node:test 经 tsx(12 个套件,含钉住
workflow script 形状的 `workflow-contract.test.ts`,以及钉住 D-FX-1
timeout/env 适配器参数的 `run-cmd.test.ts`)。
