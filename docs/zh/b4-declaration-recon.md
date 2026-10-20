# B4 数据侦察报告：MCP 工具声明 token 占用实测（2026-10-20）

方法：临时扩展钩住 `before_provider_request`，dump 真实 provider 请求的
tools 数组逐工具声明字节数（headless `pi -p "say hi" -e /tmp/decl-probe.mjs`，
当前用户配置：exa 单 server、exposure: direct）。token 估算按 ÷4。

## 实测数字（本机当前配置，25 工具全量）

| 类别 | 工具数 | 声明字节 | ≈tokens | 占比 |
|---|---|---|---|---|
| **MCP（exa，exposure: direct）** | 3 | **5,370** | **≈1,343** | **19.3%** |
| 内置（read/bash/edit/write/codemode/subagent/…） | 8 | 12,857 | ≈3,214 | 46.0% |
| core 扩展（goal/review/memory/bg-shell/observation/subagent 系） | 11 | 9,698 | ≈2,425 | 34.7% |
| **合计** | 25 | 27,925 | ≈6,981 | 100% |

MCP 明细：`mcp__exa__agent_run` 3,152B（≈788 tok）> `mcp__exa__web_search_exa` 1,459B（≈365）> `mcp__exa__web_fetch_exa` 759B（≈190）。大头是 schema+营销性长描述（agent_run 的 schema 三层嵌套 + 长 description）。

## 收益判定（阈值：≥1K token/server 显著则 go）

- **exa 单 server = ≈1,343 tokens > 1K → GO**。
- 且这是**每请求重复计费**的 input 体积（tools 参数随每个 provider 请求发送；prompt cache 命中时按 cacheRead 计费但成本仍在）。长会话（百次请求）量级 = 1.3K × N tokens 的持续占用。
- 当前用户仅配 1 个 server；多 server 场景（用户曾用过的形态）线性叠加——每增一个 direct server 再加 ~1K+ tokens。
- 佐证：观察包（输出侧）已省大结果；输入侧声明体积无任何经济面——B4 补齐该象限。

## 方案方向（按上游 spec §B4：mcp-gov declaration diet，复用 pi 原生 exposure 五档，不发明新机制）

1. **声明体积可见**：`/core` 面板（mcp-gov 已有）加各 server 声明字节数/token 估算行——数据面 bus 已有 mirror，读 tools 清单即可算。
2. **一键 exposure 切换**：面板/命令支持 direct ↔ codemode 档切换（写 ~/.pi/agent/mcp.json 的 exposure 字段 + 提示重启生效）——切 codemode 即省该 server 全部声明（pi 原生 deferred 机制承接按需调用）。
3. **（可选二档）描述 diet**：对 direct 保留的工具压缩超长 description（>1KB 截到首句+参数摘要）——动 schema 面较深，本批先做 1+2，二档挂账看实测收益。

## 依据的上游事实

- pi 原生 exposure 五档：codemode（可脚本调不声明）/ codemode-deferred / deferred / direct / hidden——`~/.pi/agent/mcp.json` 的 `exposure` 字段即开关。
- exa server 在 token 过期状态下声明仍在（direct 声明不依赖连接活性）——本报告数字即稳态数字。
