# 批次三实施 Spec：B4 MCP 声明经济（declaration diet 第一档）

状态：spec 对抗审稿（flash，1 轮）· 数据依据：docs/{en,zh}/b4-declaration-recon.md
（exa 单 server 5,370B ≈ 1,343 tokens > 1K 阈值，GO）· 2026-10-20

---

## B4-F1 · 声明计量（真实数据、零外部依赖）

**设计**：mcp-gov 内建 provider-request 计量器——`before_provider_request`
钩子读 payload 的工具数组，**dialect 容忍提取**（R1 P2-1）：扁平
`tools ?? toolConfig?.tools`（Bedrock 形态），工具名 `name ?? function?.name`
（openai-responses 扁平），Google 的 `tools:[{functionDeclarations:[…]}]`
展开嵌套；提取不出名字进 "other" 桶；完全提取不出（非数组）静默跳过。
逐工具 `JSON.stringify` 计字节，三桶归类（R1 P2-2——ExtensionAPI 无运行时
工具枚举面，静态名单非运行时查询）：`mcp__<server>__*` → 该 server（**按 payload 侧
as-sanitized 名直接前缀解析**——code R1 修订取代原「id 侧 sanitize 后匹配」
设计：pi 的 createMcpToolName 在声明时已 sanitize，无需 id 侧重做；门禁侧
「是否 MCP 形态」分类仍归 lib/mcp-shape 权威，本计量器只做展示性分桶、
永不 gate——不变量 4）；core 自注册名单
（静态常量：TaskOutput/TaskList/TaskStop/bg_wait/obs_recall/goal 系/
review 系/memory_consolidate/session_recall/…）→ core；其余 →
"other(builtin+extensions)"。**纯内存**（最新一次快照 + maxBytes），无盘写、
无 timer——bus 纪律不变（面板拉取面不是订阅面）。

```ts
// extensions/mcp-gov/declaration-meter.ts
export interface DeclarationMeter {
  observe(payload: unknown): void;          // before_provider_request 整个 payload（dialect 提取在内部）
  last(): { totalBytes: number; maxBytes: number; perClass: Record<string, number>; perServer: Record<string, number>; toolCount: number } | null;
}
```

- 面板行（**两分支之外**渲染——live 与 static 态都出现，`meter.last() != null`
  即显示，R1 P3-4）：`declarations: 25 tools ≈ 6.9K tok (exa ≈1.3K — /core exposure exa codemode)`。
  token 估算走 pi-ai 的 `estimateTextTokens`（与 B3 锚点契约同源；÷4 只留在
  recon 报告，R1 P3-6）。
- **fail-open**：payload 形状异常（无 tools/非数组）静默跳过（计量器永不
  影响请求——它只读 payload 不改写）。

## B4-F2 · exposure 一键切换（复用 pi 原生五档）

**设计**：`/core exposure <server> <tier>` 子命令——读
`~/.pi/agent/mcp.json`（lib/settings readJson），改 `mcpServers[<server>].exposure`
为 tier ∈ **4 档** {codemode, deferred, direct, hidden}（R1 P3-1——pi 的
McpExposure 是 4 档；`codemode-deferred` 是校验时归一的别名，输入接受但
落盘归一为 codemode），writeJsonAtomic 原子写回；输出确认行 +
「**/reload 或重启后生效**」提示（R1 P3-2）。server 不存在或 tier 非法 →
错误行（不写）。

- **写宿主文件的边界与写者清单**（R1 P2-4）：读取侧 pi 启动读一次安全；
  写侧是三方并发（另一会话的 pi 原生 `/mcp` manager、bash 里的
  `pi mcp add/remove` CLI、本命令）——本命令是用户显式低频触发，接受
  last-rename-wins 丢更新窗口，写前重读缩小窗口；与原生 `/mcp` 的分工：
  一次性命令可从计量行引流，manager 是交互 UI，不替代。
- **项目级 override 检查**（R1 P2-5）：`<project>/.pi/mcp.json` 存在同名
  server 条目（且其覆写含 exposure）时——**拒绝写全局**并提示改项目层
  （本批不写项目层）。
- 禁止：不经确认批量改多 server（本批只做单 server 单命令）。

## 测试矩阵（vitest，extensions/mcp-gov 侧 + test/lib）

| # | 用例 | 断言 |
|---|---|---|
| F1-1 | observe 注入**自造定长 fixture**（含 2 个 `mcp__exa__*`、1 个 core 名单工具、1 个 other；名字一律 as-declared 的 `mcp__<server>__<tool>` 形态） | perServer/perClass **精确字节断言**（JSON.stringify 定长可静态预期）；5,370 只属 recon 报告不复刻 |
| F1-2 | payload 无 tools / 非数组 / null；Google 嵌套形态；Bedrock toolConfig 形态 | 静默跳过或正确提取（fail-open；dialect 覆盖） |
| F1-3 | last() 在无观察时 null；两次观察取最新 | 快照语义 |
| F1-4 | /core 面板渲染含 declarations 行（有数据时） | 文案子串 |
| F2-1 | /core exposure exa codemode（fixture 含第二个 server 带 env/oauth 字段与未知顶层键） | exposure 改写 + **无关 server 与未知键逐字保留**（R1 P2-6）+ 目录无 .tmp 残留 + 确认行含 /reload 提示（原子性主体归 lib/settings 既有测试，R1 P3-3） |
| F2-2 | 非法 tier / 未知 server / 项目层 override 存在 | 错误行、文件不变（含项目层拒写提示） |
| F2-3 | mcp.json 缺失/malformed | 错误行不 crash（readJson fallback） |

## 门槛与流程

三门禁 exit 0（contracts 49+4todo 不变——本批无新契约）；台账
DEVIATIONS/CHANGELOG；双语 docs（本 spec + recon 报告已双语）；提交推送
（SSH 失败 https+代理旁路）；双机部署同步。审查轮数：spec ≤1、code ≤2。

**挂账（二档，本批不做）**：优先评估 **toolExposure 单工具切档**（R1
P2-7——pi 原生 `McpServerConfig.toolExposure` 按工具覆写；recon 明细
`agent_run` ≈788 tok = exa 的 59%，单工具切 codemode 即拿回六成且两个搜索
工具保持 direct 可用）**再谈**描述压缩（>1KB 截首句+参数摘要——动 schema
信任面较深；重开条件：单 server 优化后仍 ≥500 tok 且用户报告切档不便）。
