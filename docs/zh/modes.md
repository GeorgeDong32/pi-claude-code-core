# modes — 权限模式

> 中文版。English: [../en/modes.md](../en/modes.md)

**目录**:`extensions/modes/`(~40 个文件,最大模块)
**来源**:自 `@georgedong32/permission-modes` 2.8.0 迁移(P1)

## 做什么

为 pi 提供 Claude-Code 风格的权限模式,Shift+Tab 循环切换:

| 模式 | 行为 |
|---|---|
| `ask` | 编辑、越出 cwd 访问、变更型 bash 一律人工审批 |
| `plan` | 只读;只允许写 `plan.md` |
| `auto` | 分层自动批准 + 可选内置分类器 + 风险黑名单 |
| `bypass` | 全自动批准(旧 auto 语义);少量安全提醒 |

**codemode(pi 1.0)**:`plan` 模式直接拒绝 `codemode` 本体——它会执行其他工具。codemode 脚本发起的嵌套工具调用走完整 agent tool pipeline(`tool_call` 门、权限检查),上述模式规则对它们逐工具生效;codemode 不是权限旁路。

## 关键表面

- **命令**:`/mode`、`/permissions`、`/permissions-clear-grants`、
  `/plan-execute`、`/model-profile`、`/outside-writes`、
  `/undo-outside-writes`,外加每个模式名各一条命令。
- **状态**:`modes` footer 槽 + `plan-todos` widget;向总线发布 `modes`
  通道(及 `display.footer`),并写 legacy 键 `__piPermissionModes` /
  `__pmWorkingStats`。
- **Session entry**:`modes` 类型(契约钉住,P0-CT-08)。

## 内部地图

| 领域 | 文件 | 说明 |
|---|---|---|
| 权限引擎 | `permissions.ts`、`permission-rule-parser.ts`、`permissions-loader.ts`、`bash-permission-match.ts`、`path-permission-match.ts`、`shell-rule-matching.ts`、`dangerous-permissions.ts` | 规则解析/加载/匹配(Claude-Code 风格 `tool(content)` 规则);loader 合并用户级 + 项目级规则文件 |
| 规则族(接缝) | `rule-families.ts` | `registerRuleFamily` —— web-gov/mcp-gov 使用的扩展点;会话授权、裁定缓存、bypass 状态 |
| auto 分类器 | `classifier-client.ts`、`classifier-prompt.ts`、`classifier-prompts/`、`classifier-transcript.ts`、`classifier-tool*.ts`、`classifier-redact.ts`、`classifier-messages.ts` | auto 模式的可选 LLM 分类器;读取 AGENTS.md 上下文、脱敏、缓存裁定 |
| 子代理集成 | `permission-forwarding.ts`、`mode-inherit.ts` | 审批转发经 `~/.pi/agent/sessions/permission-modes-forwarding/sessions/<id>/{requests,responses}`(P0-CT-05);`PERMISSION_MODES_INHERITED_MODE` 继承(P0-CT-04) |
| Profiles | `profiles.ts` | 模型 profile(`provider/model[:effort]` 经 `lib/model-id.ts`);未设置时 `applyProfileModelForMode` 返回 undefined——没有静默 medium 默认 |
| Plan 模式 | `session-branch.ts`、`branch-stats.ts`、`fusion-tools.ts`、`injection-probe.ts`、`denial-tracking.ts`、`config.ts`、`config-cache.ts`、`plan.ts` | plan 阶段跟踪、会话分支、working stats |
| Bash 风险分析 | `bash-analysis.ts` | safe/destructive/auto-fallback/auto-approvable 分级裁决（自旧 `utils.ts` 拆出，arch review C3） |
| 路径安全与项目身份 | `path-safety.ts` | outside-cwd/敏感路径检测；project root/id/tmp-dir（自 `utils.ts` 拆出） |
| Outside-write 快照 | `outside-writes.ts` | `<ts>__<hash>.json` track/list/restore/pop 引擎（自 `utils.ts` 拆出；命令层在 `index.ts`） |
| Mode prompt 手术 | `mode-prompt.ts` | 锚点式 mode 提醒注入 + skill 块过滤（自 `utils.ts` 拆出） |
| Auto 风险 | `auto-risk.ts` | auto 模式的 bash 分类模式 + outside-cwd 写入风险（自 `utils.ts` 拆出） |
| UI | `ui/footer.ts`、`ui/meta.ts`、`ui/confirm.ts`、`ui/plan-widget.ts`、`ui/plan-approval-dialog.ts` | `MODE_META` 单点维护 icon/label/role(总线 `meta` 通道) |

## 不变量与坑

- 会话授权/裁定状态在 `rule-families.ts` —— 各规则族必须经过它,不得自持
  授权状态。
- 模式 profile 触发的 effort 副作用走 `lib/effort-owner.ts`(绝不直接调
  `pi.setThinkingLevel`)。
- `PERMISSION_MODES_INHERITED_MODE` 此处只消费,由 pi-subagents 生产——
  core 不得写入。
- legacy 键写入(`writeLegacyAliases`)与总线发布在同一同步批次内完成。

## 测试

就近 vitest 套件(`*.test.ts`,约 5 000 行)—— 唯一就近放测试的模块;
`bun run test` 直接拾取该目录。
