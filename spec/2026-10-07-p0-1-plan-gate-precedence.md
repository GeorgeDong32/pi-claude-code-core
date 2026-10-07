# SPEC P0-1：plan 模式的权限优先级（ask 照常询问 · allow 不解锁写操作 · 已授权 MCP 可用）

状态：待实施（决策 D1 / D2 已由用户确认，2026-10-07）
日期：2026-10-07
分支：main
来源：2026-10-07 core × cctui 联合架构审查，清单项 CORE-02 / CORE-03（报告 C1 卡片）；补充 FUS-SHAPE（真实 then_run 参数覆盖）
后续：P2-1（permission 裁决 deep module）会把本 spec 的优先级表整体收编

## 1. 背景与证据

plan 模式的 tool_call gate（`extensions/modes/index.ts:1427-1710`）有两个已确认缺陷，根因相同：**规则层在返回前已经执行了副作用（弹窗 / 转发），上层再靠 reason 文本二次解读**。

1. **读工具命中 ask 规则后，用户的 Block 被无视**（`index.ts:1441-1458`）。
   - `applyConfiguredPermissionRules`（`853-901`）对 ask 直接调用 `promptWithPermissionOptions`，弹窗；子代理则写转发请求并轮询父会话。
   - 返回 block 后，handler 只认 `"Denied by permission rule"` 前缀，plan + `PLAN_READ_TOOLS` 一律 `return undefined`。
   - 同时 `applyApprovalDecision`（`365-368`）已置 `pendingComplianceInject`，下一轮会注入一条并未生效的"拒绝"提醒。
2. **allow 规则短路了 plan 的只读限制**（`index.ts:1443-1444`）。
   - `permResult === "allow"` 直接 `allowToolCall()`，根本到不了 plan 分支（`1524-1564`）。
   - 后果：`Edit(src/**)`、`Bash(npm run build:*)` 这类 allow 规则在 plan 中照样放行写操作 / 非只读命令；action-fusion 覆写的 `edit` 携带的 `then_run` 也绕过了嵌入命令检查（`1467-1518` 位于 rules 之后）。
3. **MCP 的现状**：mcp family 无规则时默认 `"ask"`（`mcp-gov/family.ts:68`），所以装配后 MCP 调用从不 passthrough，plan 分支的 MCP deny（`index.ts:1538`）只在"没有任何 family 认领"时才生效。
   - 两套测试看似矛盾：`modes/index.test.ts:446`（不注册 family）断言 deny；`test/lib/p4-families.test.ts:175-188`（注册 family）断言弹窗。
   - 按 D2，两者都是正确行为，只是测试标题没有说清前提。

## 2. 决策登记

| # | 决策 | 候选方案 | 选择 | 放弃了什么 | 风险与承担 | 证据 |
|---|---|---|---|---|---|---|
| D1 | plan 下读工具命中 ask 规则 | A 跳过询问直接放行；B 照常询问并尊重结果；C 一律拒绝 | **B**（用户 2026-10-07） | A 的零打扰；C 的保守 | 用户在 plan 探索时可能多一次弹窗；规则是用户自己写的，可接受 | `index.ts:1446-1456` |
| D2a | plan 下 allow 规则能否解锁内置写/执行 | A 能（现状）；B 不能，plan 硬限制先于 allow | **B**（用户：别的 edit 不能用） | 用 allow 规则在 plan 中"开小门"的灵活性 | 依赖该现状的用户会看到新拦截，CHANGELOG 明示 | `index.ts:1443-1444` |
| D2b | plan 下 MCP | A 一律拒绝；B 走 family 正常裁决（规则 / session grant / 首次弹窗批准即可用）；C 只放行预授权的（有规则或 session grant），首次调用直接拒 | **B**（对用户“Allow 的 MCP 可以用”的实现解释：保留既有首次询问，批准后才执行；用户未另行选择 B / C） | A 的绝对只读；C 的"plan 中不弹窗" | MCP 可能有副作用，由用户在弹窗 / 规则中自行授权承担 | `family.ts:55-69`、`p4-families.test.ts:175` |
| D2c | 没有任何 family 认领的 MCP 形状调用（独立加载 modes、未装 mcp-gov） | A 放行；B 拒绝 | **B**（维持现状，fail-closed） | — | 无 | `index.test.ts:446` |
| I1 | 实现位置 | A 在 `applyConfiguredPermissionRules` 内部加分支；B 在 handler 中拆成"纯裁决 → plan 硬限制 → 执行裁决"三步 | **B** | A 改动更小，但继续让副作用藏在规则层 | B 多一个 helper，为 P2-1 铺路 | — |

> D2b 的解读：凡是经 family 裁决为允许的 MCP 调用（allow 规则、session grant、首次弹窗选 Allow once / session / always）在 plan 中都可执行。这里保留现有 first-seen 询问流程；不得将“family 认领”本身当成 allow。若改选 C，需要同步修改首次询问行为和 T9，不能仅换一个谓词。

## 3. 目标与非目标

**目标**
- plan 模式的判定顺序固定为 §4.1 的五步，且**弹窗只在会尊重其结果的地方出现**。
- 删除 reason 文本前缀嗅探。
- 测试标题说清 family 前提，两套 MCP 测试不再"看似矛盾"。

**非目标**
- auto / ask / bypass 的优先级不变。FUS-SHAPE 唯一扩展是让已存在的 embedded-command gate 也识别真实 `then_run: { command }`；auto / ask 的这类输入因此接受原先漏掉的检查，bypass 仍直接放行。
- 不改规则语法、规则文件、family 接口（`rule-families.ts`）。
- 不处理"未知非 MCP 扩展工具在 plan 中静默放行"（`index.test.ts:676-702` 钉住的现状）；如需收紧，另立 spec。
- 不做 P2-1 的整体裁决 module，只为它铺好第一步。

## 4. 设计

### 4.1 plan 模式判定顺序（新）

| 步 | 检查 | 结果 |
|---|---|---|
| 1 | `evaluateToolPermission` → deny | block，reason 文本不变（`Denied by permission rule [...]`） |
| 2 | **plan 硬限制**（不受 allow / ask 规则影响） | block，复用现有 reason 文本，不弹窗 |
| 3 | verdict = ask（规则 ask，或 family first-seen） | 弹窗 / 转发，**尊重结果**（D1） |
| 4 | verdict = allow（规则 allow / session grant） | allow（此时只可能是 plan 允许的调用） |
| 5 | passthrough | 读工具、`tool_search`、plan 文件编辑、只读 bash、未知非 MCP 工具：维持现状 |

第 2 步"plan 硬限制"的完整清单（全部来自现有 plan 分支，只是前移）：

- `codemode` → `Plan mode: codemode is not available (it can execute other tools).`
- `edit` / `write` 且路径不是 plan 文件（`isPlanFilePath`，`plan.ts:168`）→ `Plan mode: only <plan.md> may be edited.`
- `bash` / `powershell` 且 `!isSafeCommand(cmd)`（`bash-analysis.ts:302`）→ `Plan mode: read-only commands only.\n  Command: ...`
- 除下述受 family 治理的 MCP 外，嵌入命令（`extractEmbeddedCommandInputs`，`fusion-tools.ts:42`）中存在 `!classifyBashTiers(c).safe` 的 → 同上文本，附 schema hint
- `isMcpShapedCall(tool, input, knownServers)` **且** `matchFamily(tool, input) === null` → `Plan mode: MCP tool <tool> is not available (plan is read-only).`（D2c）

**D2 的扫描边界：**先判内置 `edit/write/bash/powershell/codemode` 的硬限制；这些名字不能因 family 认领而豁免。对其余工具，只有既经权威 MCP shape 判定、又被 registry 的 family 认领的调用，才跳过 generic embedded-command 扫描，继续执行该 family 的 deny / ask / allow。MCP 的 `command/run/cmd/then_run` 是远端 schema 参数，不擅自当成本地 shell；即使内容像 `npm install x`，也由 family 规则或用户批准裁决。web-gov 先认领的 MCP 同样遵循其裁决；不允许任意非 MCP family 借此绕过扫描。未被 family 认领的 MCP 仍按 D2c 拒绝，未知非 MCP 工具仍保留原扫描行为。

### 4.2 代码改动

先补 FUS-SHAPE：`fusion-tools.ts#extractEmbeddedCommandInputs` 当前只接受 string / string[]，会忽略 action-fusion 实际注册的 `then_run: { command: string, ... }`。只为顶层 `then_run` 增加对象 `.command` 字符串解析；保留旧 string / string[]，不递归扫描任意对象，不把 `script` 加进白名单。测试必须使用真实对象形状。


1. 新建 `extensions/modes/plan-gate.ts`：`planHardBlock(tool, input, facts) → Block`，只在 plan 下调用。`facts` 由 adapter 使用既有权威函数采集：`{ planFilePath, isPlanFile, mcpShaped, familyClaimed, fusionSchemaHint }`；路径探测 / family matching / 环境读取留在 adapter，函数内仅做数据与命令判定，不读盘、不读全局。MCP 形状复用 `lib/mcp-shape.ts`，不得重写正则。头注释写明本 spec ID 与 §4.1 表格。
2. `index.ts` 的 tool_call handler（bypass 之后）改为：
   1. `const verdict = evaluateToolPermission(tool, input, ctx.cwd, mergedPermissionRules)`；deny → 返回现有 deny block。
   2. `if (currentMode === "plan")`：`const hard = planHardBlock(...)`；有则直接返回。
   3. 执行 verdict：把 `applyConfiguredPermissionRules` 改为接收已算好的 verdict（签名 `applyPermissionVerdict(ctx, tool, input, verdict)`），其中 allow / ask / first-seen 的副作用逻辑**逐字保留**。
   4. 删除 `1446-1456`（前缀嗅探整段）。
3. 原 plan 分支（`1524-1564`）里与第 2 步重复的 `codemode` / edit / write / bash / MCP 检查删除，只保留读工具与 `tool_search` 的放行，以及默认放行。原嵌入命令段（`1467-1518`）中的 plan 分支删除（已前移），auto / ask 分支不动。受 family 治理的 MCP 不得在执行 verdict 后再次掉进 generic scan。
4. 不改：`firstSeenPrompt`、`promptWithPermissionOptions`、`applyApprovalDecision`、`noteFamilyAdjudication` 的任何逻辑。broker mirror 的一致性（P4-MC-03/04）不受影响——所有 allow 出口仍经过同一记录点。

### 4.3 兼容与可见行为变化

| 场景 | 改前 | 改后 |
|---|---|---|
| plan + `Read(./.env)` ask，用户选 Block | 弹窗后仍放行，并误注入 compliance | 拦截，compliance 注入为真实拒绝 |
| plan + ask 规则 + 无 UI（非子代理） | 放行 | 拦截（`needs approval: no UI available`） |
| plan + `Edit(src/**)` allow | 放行 | 拦截（plan 文本），不弹窗 |
| plan + `Bash(npm run build:*)` allow | 放行 | 拦截 |
| plan + `Edit(src/**)` ask | 弹窗，批准即写 | 直接拦截，不弹窗 |
| plan + MCP（family 认领，allow 规则 / session grant） | 放行 | 放行（不变） |
| plan + MCP（family 认领，无规则） | first-seen 弹窗 | 不变 |
| plan + MCP（无 family） | 拦截 | 不变 |

## 5. 回归测试（先红后绿）

位置：`extensions/modes/index.test.ts`（vitest，复用 `callToolCall` `407` / `switchMode` `419`）与 `test/lib/p4-families.test.ts`（`setupModesWithFamilies` `116`）。

| # | 用例 | 基线预期 |
|---|---|---|
| T1 | plan + ask `Read(./.env)`：选 Block → block；选 Allow → undefined；`select` 各 1 次 | Block 分支**红** |
| T2 | plan + ask 规则 + `hasUI:false`（非子代理）→ block | **红** |
| T3 | plan + allow `Edit(src/**)`：edit `src/a.ts` → block、`select` 0 次 | **红** |
| T4 | plan + allow `Bash(npm run build:*)`：`npm run build` → block | **红** |
| T5 | plan + ask `Edit(src/**)` → block、`select` 0 次 | **红** |
| T6 | plan 文件的 `edit` 带 `then_run: { command: "npm install x" }` + allow `Edit(**)` → 因嵌入命令 block（路径本身合法） | **红** |
| T7 | plan + family + allow `mcp_exa_*` → undefined | 绿（钉现状） |
| T8 | plan + family + session grant → undefined | 绿 |
| T9 | plan + family + 无规则 + first-seen 选 Allow once → undefined | 绿 |
| T10 | plan + 编辑 plan 文件 + ask 规则 → 弹窗、Allow → undefined | 绿 |
| T11 | plan + deny `Read(./secret)` → reason 含 `Denied by permission rule` | 绿 |
| T13 | 真实对象 `then_run.command`：plan 文件 + safe 命令放行；unsafe 拦截；旧 string / string[] 不变；非 then_run 的嵌套对象不扫描 | unsafe 对象分支**红** |
| T14 | 无 allow 规则时，auto / ask 的 unsafe 对象 then_run 进入既有询问；bypass 零询问；显式 allow 在非 plan 下保持既有优先级 | 新覆盖 |
| T12 | `plan-gate.ts` 单测：五类硬限制各 1 条 + plan 内允许的调用返回 undefined（函数无 mode 参数） | 新文件 |
| T15 | plan + family 认领的 MCP：allow / session grant / first-seen Allow 均可调用；first-seen Block 与 deny 仍拒绝。每类带顶层 command/run/cmd（危险 shell 字符串与业务字符串）及 then_run；不触发本地 shell 拦截或额外询问 | 绿（钉 D2 与原优先级） |
| T16 | native / 配置允许的 direct / proxy MCP 参数形状；含 URL 被 web family 先认领时尊重其结果；同样输入无 family 则拒绝；非 MCP family 认领不豁免扫描，内置名字仍受硬限制 | 新覆盖 |

同时：
- 把 `index.test.ts:446` 的标题改为 "plan without any MCP family: declared MCP tools are denied (fail-closed)"；
- 把 `p4-families.test.ts:175` 的标题补上 "(family-governed in plan, D2b)"。

两处断言均不改动。auto / ask 全部既有用例零改动通过。

## 6. 实施顺序

1. 在临时基线 checkout 验证 T1–T6、T13 的红因；不要让正在合入的中间提交留下失败测试。
2. 抽 `plan-gate.ts`，在原有 plan 分支的位置接入，补 T12（行为不变，三绿）。
3. 单独修 FUS-SHAPE，补对象 / 旧形状 / 非 plan 回归并三绿。
4. handler 改为三步并删除前缀嗅探，纳入缺陷测试、T15/T16 与台账，三绿。

建议分 3 个 commit：①门控搬移；②真实 fusion 参数识别；③优先级调整。

## 7. 验证门禁

`bun run check` 退出 0；`bun run test` 全绿（按仓库脚本运行全量，不钉历史测试文件数）；`bun run contracts` 全绿（P4-MC-03/04 的 mirror 一致性用例必须零改动通过）。

## 8. 风险与回滚

- **风险**：依赖"allow 规则在 plan 中放行写操作"的用户会被拦截——这是 D2a 的有意变化，CHANGELOG 写明并给出替代方案（切到 auto / ask 模式执行）。
- **风险**：子代理在 plan 下命中 ask 规则时，现在会真正等待父会话的答复并遵守。这是预期行为，转发协议（P0-CT-05）不变。
- **回滚**：三个 commit 按依赖逆序 revert；plan-gate 搬移 commit 可单独保留。

## 9. 台账与文档

- `docs/en/modes.md` 与 `docs/zh/modes.md` 新增"plan 模式判定顺序"小节（§4.1 表格），两边同步。
- `CHANGELOG.md` Unreleased：列出 §4.3 的可见变化，并说明 auto / ask 开始检查对象形状的 then_run。
- `DEVIATIONS.md`：登记"plan 硬限制先于 allow 规则"偏离 pm 2.8.0 继承行为（附 D2a）。
- `PROGRESS.md`：批次条目。
- `index.ts` gate 区块头注释更新，引用本 spec ID。
