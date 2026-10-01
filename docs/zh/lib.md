# lib/ — 共享原语

> 中文版。English: [../en/lib.md](../en/lib.md)

八个小型模块,所有扩展均可使用。**规则:`lib/` 不 import `extensions/`**——
需要扩展形状数据的助手以结构化方式接收。

| 文件 | 用途 | 关键事实 |
|---|---|---|
| `settings.ts` | JSON 设置原语(P0-LB-01) | `readJson` 对缺失/空/畸形/非对象输入返回 fallback、不抛错(抛错的 `onInvalid` 回调是唯一例外);写为同目录 tmp+rename 原子写;并发写按 last-rename-wins 解决。替代了四份逐包拷贝。 |
| `overlay.ts` | Overlay 选择器骨架(P0-LB-03) | 把 `ctx.ui.custom` + `overlayOptions` 包成带选中态的竖排列表;非 TUI 环境降级为 `ctx.ui.select`,headless 返回 null。消费方:effort 选择器、plan 审批对话框、goal 对话框。 |
| `model-id.ts` | `"provider/model[:effort]"` 解析器(P0-LB-02) | 与 pm 2.8.0 的解析器逐字节等价;尾部 `:` 视为无 effort;坏输入返回 null、不抛错。用于 modes profiles 与 review 模型解析。 |
| `rule-text.ts` | 权限规则文本助手 | `ruleValueText` / `ruleMatchesId` —— ruleValue→文本与通配匹配的唯一深点(此前 4 + 2 份拷贝)。调用方:modes/rule-families、mcp-gov、web-gov。刻意自包含(结构化 `RuleLike`,无反向依赖)。 |
| `effort-owner.ts` | 思考档位所有权链(P1-EF-05) | 单一所有者:① `PI_CORE_EFFORT` env 钉死 > ② 会话显式选择(/effort、picker、alt+t)> ③ 模式 profile `:effort` > ④ 模型默认。**core 中唯一的 `pi.setThinkingLevel` 调用点**(P1-EF-07 源码扫描强制)。 |
| `context-budget.ts` | 静态注入预算切分(P3-RU-10) | `RULES_MAX` 40 000 / `MEMORY_INDEX_MAX` 25 000 / `DYNAMIC_STEER_MAX` 8 000 字符;以只读 `contextBudget` 通道发布到总线。是常量不是分配器——两个生产方场景下够用。 |
| `core-economy.ts` | economy 功能开关(SPEC DEC-02) | `~/.pi/agent/core-economy.json` → `{ version: 1, actionFusion, observationPack }`,缺省均 true;文件畸形时降级为默认值并警告一次(刻意不同于上游 SoL-Pi 的 fail-fast)。 |
| `pi-compat.ts` | pi 宿主兼容性探针(SPEC CMP-01..06) | `MIN_PI_VERSION = "0.87.0"`;探测工具工厂 + `withFileMutationQueue`。economy 模块依赖的每个 pi 能力都是显式探针,绝非隐式假设(要防的失败模式:pi 升级静默破坏机制)。不 import pi 运行时对象——全部注入,可纯单测。 |

测试:`test/lib/*.test.ts`(vitest)—— 每个原语一个套件,另有跨模块接线套件。

Agent 注意事项:

- 新增扩展共享的 lib 助手时,保持无依赖、结构化类型;若与某扩展内已有逻辑
  重复,收敛进 lib 而不是保留两份(Standards #4,REVIEW-2026-09-22)。
- `settings.ts` 是读写 `~/.pi/agent/*.json` 配置的唯一许可途径——不要在
  模块里手写 `readFileSync(JSON.parse)`。
