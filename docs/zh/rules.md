# rules — 规则注入

> 中文版。English: [../en/rules.md](../en/rules.md)

**目录**:`extensions/rules/` —— 新模块(P3)

## 做什么

从仓库级与用户级收集规则文件,在字符预算内渲染后追加到 system prompt。
v1 只读(`/rules` 命令);生命周期对象(setEnabled/lint/subscribe)刻意
延后(P3-RU-12),工厂外壳由此可在不破坏接口的前提下接受未来命令。

## 关键表面

- **命令**:`/rules`(列出 + 渲染预览)。
- **System prompt**:`before_agent_start` 对 `renderRules` 输出做**只追加**
  拼接——不碰 `contextFiles`、不改写既有内容(P3-RU-06)。总线一次性发布
  `contextBudget`(P3-RU-10)。
- **Steering**:`tool_call` 捕获 edit/write/read 目标路径;首次命中 `globs`
  规则时按会话一次性 steer 完整规则文本(P3-RU-07,受 `DYNAMIC_STEER_MAX`
  预算约束)。

## 便宜承诺(P3-RU-08,DEVIATIONS #42)

文件级指纹(每个规则文件的 `mtimeMs`+`size`)门控重扫:未变化的 turn 只花
**一次 readdir + 每目录 N 次 stat,零文件内容读取**。

## 内部地图

| 文件 | 说明 |
|---|---|
| `index.ts` | 工厂 `createRulesExtension(options)` —— 唯一导出(DESIGN-RULES D3) |
| `render.ts` | `collectRules` / `renderRules` / `globToRegExp`;规则目录扫描 |
| `scan.ts` | 从工具调用提取目标路径 |
| `paths.ts` | 规则目录解析(项目级 + 用户级,可选 `extraDirs`) |
| `defaults.ts` | 内置规则文本 |
| `lib/context-budget.ts` | `RULES_MAX` 40K 钳制;steering 预算与 memory 共享 |

## 规则文件形状

规则文件位于项目/用户级规则目录(见 `paths.ts`);规则可带可选 `globs:`
匹配器,门控其生效路径。`/rules` 展示当前激活与已渲染内容。

## 不变量与坑

- 注入只追加且受预算钳制——绝不重排或改写既有 system prompt。
- lib(`context-budget`)是钳制权威;不要在本模块再造预算常量。

## 测试

`test/lib/rules-render.test.ts`、`rules-wiring.test.ts`(vitest)。
