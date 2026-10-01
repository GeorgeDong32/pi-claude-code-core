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
| `src/review-run.ts` | `prepareRun`:目标解析、diff 准备、manifest |
| `src/directive.ts` | 隐藏 directive 文本(workflow script 契约) |
| `src/workflow-schemas.ts` | 评审/gate 输出 schema |
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

## 测试

`extensions/review/tests/` —— node:test 经 tsx(11 个套件,含钉住
workflow script 形状的 `workflow-contract.test.ts`)。
