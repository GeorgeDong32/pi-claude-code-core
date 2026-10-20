# Batch-3 Implementation Spec: B4 MCP declaration economics (declaration diet, tier 1)

Status: draft for adversarial review (flash, 1 round) · Data basis: docs/{en,zh}/b4-declaration-recon.md (exa alone 5,370B ≈ 1,343 tokens > 1K threshold — GO) · 2026-10-20

---

## B4-F1 · 声明计量（真实数据、零外部依赖）

**设计**：mcp-gov 内建 provider-request 计量器——`before_provider_request`
钩子读 `event.payload.tools`（数组），逐工具 `JSON.stringify` 计字节，按
前缀归类：`mcp__<server>__*` → 该 server；其余按 builtin/extension 名单
（core 自己注册的工具集）归类。**纯内存累计**（最新一次请求的快照 +
历史 max），无盘写、无 timer——bus 纪律不变（数据经 /core 渲染时同步读，
不进 bus 快照；面板是拉取面不是订阅面）。

```ts
// extensions/mcp-gov/declaration-meter.ts
export interface DeclarationMeter {
  observe(payloadTools: unknown[]): void;   // before_provider_request 每请求
  last(): { totalBytes: number; perClass: Record<string, number>; perServer: Record<string, number>; toolCount: number } | null;
}
```

- 面板行：`declarations: 25 tools ≈ 6.9K tok (exa ≈1.3K — /core exposure exa codemode to drop)`。
- **fail-open**：payload 形状异常（无 tools/非数组）静默跳过（计量器永不
  影响请求——它只读 payload 不改写）。

## B4-F2 · exposure 一键切换（复用 pi 原生五档）

**设计**：`/core exposure <server> <tier>` 子命令——读
`~/.pi/agent/mcp.json`（lib/settings readJson），改 `mcpServers[<server>].exposure`
为 tier ∈ {codemode, deferred, direct, hidden}，
writeJsonAtomic 原子写回；输出确认行 + 「重启 pi 后生效」提示。server
不存在或 tier 非法 → 错误行（不写）。

- **写宿主文件的边界**：mcp.json 是 pi 本体配置——运行中改是安全的
  （pi 启动时读一次），命令必须用户显式触发（/core 面板里展示的引流）。
- 禁止：不经确认批量改多 server（本批只做单 server 单命令）。

## 测试矩阵（vitest，extensions/mcp-gov 侧 + test/lib）

| # | 用例 | 断言 |
|---|---|---|
| F1-1 | observe 注入 25 工具 payload（含 3 个 mcp__exa__*） | perServer.exa = 5,370B 量级；perClass 三类分桶正确 |
| F1-2 | payload 无 tools / 非数组 / null | 静默跳过不 throw（fail-open） |
| F1-3 | last() 在无观察时 null；两次观察取最新 | 快照语义 |
| F1-4 | /core 面板渲染含 declarations 行（有数据时） | 文案子串 |
| F2-1 | /core exposure exa codemode | mcp.json 的 exposure 改写 + 原子（tmp+rename）+ 确认行含重启提示 |
| F2-2 | 非法 tier / 未知 server | 错误行、文件不变 |
| F2-3 | mcp.json 缺失/malformed | 错误行不 crash（readJson fallback） |

## 门槛与流程

三门禁 exit 0（contracts 49+4todo 不变——本批无新契约）；台账
DEVIATIONS/CHANGELOG；双语 docs（本 spec + recon 报告已双语）；提交推送
（SSH 失败 https+代理旁路）；双机部署同步。审查轮数：spec ≤1、code ≤2。

**挂账（二档，本批不做）**：描述压缩（>1KB 截首句+参数摘要）——动
schema 面较深，等 F1/F2 的实测使用数据再评估（重开条件：单 server 压缩
后可省 ≥500 tok 且用户报告切档不便）。


---

EN mirror note (code-review R1 sync): the zh spec above is authoritative and
carries the R1 revisions — 4 tiers (codemode-deferred is an alias that
normalizes to codemode on write), self-made exact-byte fixtures (never the
recon's 5,370B), unknown-key/unrelated-server verbatim preservation in F2-1,
project-level override refusal, /reload-or-restart notice, both-state panel
rendering, pi-ai estimateTextTokens on the panel, and the tier-2 ledger
(toolExposure single-tool switch first, description diet second).
