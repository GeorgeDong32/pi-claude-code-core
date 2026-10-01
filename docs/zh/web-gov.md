# web-gov — Web 规则族

> 中文版。English: [../en/web-gov.md](../en/web-gov.md)

**目录**:`extensions/web-gov/index.ts`(单文件)—— 新模块(P4-WB)

## 做什么

第二个规则族,也是「族接缝真实可用」的证明(P4-FAM-06):

- 认领输入携带 URL 形态值的搜索/抓取工具(exa search/crawl/fetch、
  webfetch 等),映射到**主机名**,并以 deny > ask > allow 优先级求值
  `webfetch(domain:host)` 规则。
- 内置预批准域名列表(P4-WB-02,Claude-Code 风格:MDN、GitHub、
  docs.python.org、nodejs.org 等)无需任何规则即渲染 allow。
- 列表可经 `~/.pi/agent/pi-core-web.json` 覆盖。

## 关键事实

- 经 `modes/rule-families.ts#registerRuleFamily` 注册;规则文本用
  `lib/rule-text.ts`,并复用 `mcp-gov/family.ts`(`canonicalizeMcpTool`、
  `directKnownServersFromEnv`),不重新实现 MCP 形态判定。
- 主机提取从严:没有可用主机名的 URL(仅 query 或畸形)一律不认领
  (p4 红→绿修复)。
- 在 `extensions/index.ts` 中装配于 mcp-gov **之前**,URL 类调用因此优先
  命中域名规则而非 `mcp_*` 前缀规则(P4-WB-01)。

## 不变量与坑

- 保持本模块单文件;它刻意很小——活由接缝干。
- 预批准列表的变更应走 `pi-core-web.json`,不改代码。
- 只认领携带 URL 的工具;其余全部落入 mcp 族。

## 测试

`test/lib/p4-families.test.ts`(vitest)—— 认领映射、主机提取、
deny/ask/allow 求值、预批准渲染。
