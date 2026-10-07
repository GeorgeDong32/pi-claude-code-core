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

### plan 模式判定顺序(SPEC 2026-10-07 P0-1)

| 步 | 检查 | 结果 |
|---|---|---|
| 1 | `evaluateToolPermission` → deny | 拦截(`Denied by permission rule [...]`) |
| 2 | **plan 硬限制**(`plan-gate.ts`)——不受 allow/ask 规则影响 | 拦截,不弹窗 |
| 3 | verdict = ask(规则 ask,或 family 首见询问) | 弹窗 / 子代理转发,**尊重结果** |
| 4 | verdict = allow(规则 allow / session grant) | 放行(此时只剩 plan 允许的调用) |
| 5 | passthrough | 读工具、`tool_search`、plan 文件编辑、只读 bash、未知非 MCP 工具:维持现状 |

顺序修正后的效果:allow 规则不再能解锁 plan 下的写操作/非只读命令(D2a);读工具命中 ask 规则时照常询问且 Block 结果被尊重,不再被静默无视(D1);经 family 治理的 MCP 调用在 family 裁决为允许时仍可在 plan 中使用(规则 / session grant / 首见批准——D2b),无 family 认领的 MCP 形状调用维持拒绝(D2c fail-closed)。硬限制收敛在 `plan-gate.ts#planHardBlock`(纯函数;adapter 采集路径/family/env facts)。扫描边界:内置 `edit/write/bash/powershell/codemode` 名字永不豁免;只有既是 MCP 形状(lib/mcp-shape 权威)又被 family 认领的调用才跳过 generic 嵌入命令扫描——其 `command/run/cmd/then_run` 是远端 schema 参数,不是本地 shell。

### 无 UI 时的 family 首见(SPEC 2026-10-07 P3-1 S3,D6=B)

headless 会话(含 subagent 子会话)在未授权 family 首见调用上依旧
fail-closed,但 block reason 现在原样携带该 family 给出的建议 allow
规则与重试指引——例如 `mcp__exa__search` 被拒时会提示:在父会话/交互
会话向权限规则加入 ``mcp_exa_*`` 后重试。不写授权、不弹窗,family
首见不进入父会话审批转发协议(D6 将转发保持限于常规 ask 询问路径)。

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
| 裁决 module(P2-1) | `adjudicate.ts`、`interpret.ts` | 纯 `decide(facts)→Decision`(判定顺序表见 adjudicate.ts 头注释)+ `interpretDecision` 经注入端口执行副作用;入口 `createPermissionAdjudicator(deps).check(call)`。Step 1+2 已迁 bypass/规则/plan/ask/auto 阶梯;classifier 经 classify 决策留在端口(Step 3 收编)。对拍 golden:`test/lib/adjudication-parity.test.ts` |
| 规则族(接缝) | `rule-families.ts` | `registerRuleFamily` —— web-gov/mcp-gov 使用的扩展点;会话授权、裁定缓存、bypass 状态 |
| auto 分类器 | `classifier-client.ts`、`classifier-prompt.ts`、`classifier-prompts/`、`classifier-transcript.ts`、`classifier-tool*.ts`、`classifier-redact.ts`、`classifier-messages.ts` | auto 模式的可选 LLM 分类器;读取 AGENTS.md 上下文、脱敏、缓存裁定 |
| 子代理集成 | `permission-forwarding.ts`、`mode-inherit.ts` | 审批转发经 `~/.pi/agent/sessions/permission-modes-forwarding/sessions/<id>/{requests,responses}`(P0-CT-05);`PERMISSION_MODES_INHERITED_MODE` 继承(P0-CT-04) |
| Profiles | `profiles.ts` | 模型 profile(`provider/model[:effort]` 经 `lib/model-id.ts`);未设置时 `applyProfileModelForMode` 返回 undefined——没有静默 medium 默认 |
| Plan 模式 | `session-branch.ts`、`branch-stats.ts`、`fusion-tools.ts`、`injection-probe.ts`、`denial-tracking.ts`、`config.ts`、`config-cache.ts`、`plan.ts`、`plan-gate.ts` | plan 阶段跟踪、会话分支、working stats |
| Working stats | `working-stats.ts` | **AR1005-ST(2026-10-05)**:流式统计缓存 —— cheap key = sessionManager 实例(WeakMap id)+ sessionId + leafId(合法空 branch 的 null 可缓存;getter 缺失/抛错 = 不可缓存,绝不当作"空 leaf")。message_update 命中 key = 零 getBranch/getContextUsage 调用(实测 1K/10K/50K branch × 200 次 update 全零;基线为 200 次 getBranch —— 即复现的 10K 下 200 万次 parent-map 读取)。失效:session_start/session_tree/session_shutdown reset;session_compact invalidate;message_end markDirty(先于宿主 append —— 与 leafId key 双保险,契约 AR1005-ST-HOST 对真实 SessionManager 钉住 leaf 移动);model_select onModelChange;turn_start/turn_end force(已提交终态)、before_provider_request forceUsage(不再无条件重求和)。无 cheap key 的旧宿主走无缓存读路径(peer floor 不变);读取失败绝不缓存为成功空快照 |
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
