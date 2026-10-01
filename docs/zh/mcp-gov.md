# mcp-gov — MCP 治理

> 中文版。English: [../en/mcp-gov.md](../en/mcp-gov.md)

**目录**:`extensions/mcp-gov/` —— 新模块(P4-MC)

## 做什么

三项职责,在 `index.ts` 装配:

1. **规则族**(`family.ts`):把 MCP 规则族注册进 modes 引擎——匹配
   `mcp_*` 形态工具(native / 代理 / knownServers 上的直连)并求值
   `mcp(server)` / `mcp(server, tool)` 规则。此处的 `canonicalizeMcpTool`
   是「是否为 MCP 形态工具」的**唯一权威**——web-gov 复用它。
2. **Broker 镜像**(`broker.ts`):从 pi-mcp-adapter 的探测端口镜像审批事件。
   adapter 不在 → idle、零副作用。镜像为同步纯函数,canonicalId 取自
   server/tool(不依赖 callId),对同步/异步两种 adapter 语义都免疫。
3. **`/core` 面板**(`panel.ts`):从总线快照渲染 core 状态(modes/effort/
   goal/review/memory/economy),规则经 `lib/rule-text.ts` 展示。

## 关键表面

- **命令**:`/core` 面板。
- **env**:`PI_CORE_MCP_DIRECT_SERVERS` —— 允许认领裸工具名的 server id
  逗号列表(如 `exa`);native `mcp__…` 命名始终可用。
- **特异度阶梯**:精确规则 > server 前缀 > 裸 `mcp_*`(S5)。

## 不变量与坑

- web-gov 装配在 mcp-gov **之前**,URL 类调用先命中域名规则(P4-WB-01)
  —— 保持 `extensions/index.ts` 中的顺序。
- 镜像必须保持为输入的纯函数;防重入,并在 `session_shutdown` 清理
  (C4 修复)。
- 直连命名按 server 经 env 显式开启;不要在代码里放宽。

## 测试

`test/lib/p4-families.test.ts` 覆盖两个规则族行为;broker 语义另在
`test/contracts/`(宿主语义)钉住,真机验证归 P4-REL(OPEN-QUESTIONS #6)。
