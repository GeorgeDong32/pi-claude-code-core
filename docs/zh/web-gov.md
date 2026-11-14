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
- 主机提取用 `new URL()` 解析 URL 字段(BH-S2):主机名转小写并去掉末尾的
  点。带 userinfo(`user@host`)的 URL 绝不视为预批准 —— 显式 `domain:`
  规则仍按真实主机匹配,否则一律 ask。无法解析为绝对 URL 的字段按
  fail-closed 走 ask(旧的前缀正则在 `@` 处截断且接受无 scheme 主机,
  `https://github.com@evil.example/` 曾因此搭预批准 github.com 的便车)。
  自由文本 `query` 依旧不认领(搜索词不是抓取目标)。IP 字面量按主机
  处理:`domain:` 规则照常匹配,但预批准列表永不匹配 IP。
- 在 `extensions/index.ts` 中装配于 mcp-gov **之前**,URL 类调用因此优先
  命中域名规则而非 `mcp_*` 前缀规则(P4-WB-01)。

## 不变量与坑

- 保持本模块单文件;它刻意很小——活由接缝干。
- 预批准列表的变更应走 `pi-core-web.json`,不改代码。
- 只认领携带 URL 的工具;其余全部落入 mcp 族。

## 测试

`test/lib/p4-families.test.ts`(vitest)—— 认领映射、主机提取、
deny/ask/allow 求值、预批准渲染。
`extensions/web-gov/tests/bh-s2-host.test.ts`(node:test 经 tsx)——
BH-S2 主机解析契约:userinfo、IP 字面量、末尾点归一化、无法解析字段的
fail-closed,以及标记 id 的规则语法。
