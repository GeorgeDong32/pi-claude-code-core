# effort — 思考档位控制

> 中文版。English: [../en/effort.md](../en/effort.md)

**目录**:`extensions/effort/`
**来源**:自 `@georgedong32/pi-effort` 0.1.2 迁移(P1)

## 做什么

经单一所有权链(`lib/effort-owner.ts`)端到端掌管 pi 的思考档位:

```
① PI_CORE_EFFORT env 钉死   —— 启动时读一次;置位期间显式写入被拒绝
② 会话显式选择              —— /effort 命令、picker、alt+t 快捷键
③ 模式 profile :effort      —— modes 应用 profile 时设置
④ 模型默认                  —— 所有者不写;pi 保留自己的默认
```

生效值经 `pi.setThinkingLevel` 下推 —— **这条模块链是 core 中唯一允许调用
它的位置**(P1-EF-07 源码扫描)。

## 关键表面

- **命令**:`/effort`(设置/循环思考档位)、`/fast`(开关 fast 模式:对
  Responses/Codex 系 API 上的 `gpt-5*` 匹配模型注入 OpenAI priority 档)。
- **快捷键**:alt+t 循环思考档位(含 `off`)与 ctrl+shift+e 循环 effort ——
  两者均由 effort 模块注册(arch review C5:alt+t 自 modes 迁入;不再用硬编码表,
  改为 cycleLevel/cycleLevelWithOff 模型感知循环,并带零写入守卫——单档模型
  不再把被 clamp 的值钉进显式槽);感知 env 钉死——`PI_CORE_EFFORT` 置位期间
  拒绝并提示。
- **总线**:`effort` 通道 —— `{ level, source: "env" | "session" | "profile" | "model-default" }`。
- **Status 槽**:`pi-effort-thinking`、`pi-effort-fast`(契约 P0-CT-07)。

## 内部地图

| 文件 | 说明 |
|---|---|
| `effort.ts` | 纯逻辑:档位、别名、`cycleLevel`、`resolveEffortLevel`、fast 模式助手。未设置时解析结果为 `undefined`——没有静默 medium 默认。 |
| `effort-picker.ts` | 基于 `lib/overlay.ts` 的 overlay 选择器 |
| `ui/index.ts` | 模块级交互包装(select overlay)—— 呈现不混入业务流 |
| `index.ts` | 接线:命令、快捷键、所有者接管、总线发布、经 owner.changed() 刷新 status 槽 |

## 不变量与坑

- 语义别名与用户可见档位随模型而异——一律经 `effort.ts` 解析,不要硬编码
  档位列表。
- fast 模式仅对 id 含 `gpt-5`(子串匹配,带 provider 前缀的 id 也能命中)
  且 API 为 `openai-responses` / `openai-codex-responses` 的模型注入
  `service_tier: "priority"` —— 这是该字段仅有的真实线上方言(pi-ai 自身
  的 serviceTier 映射也恰好只有这两个)。其余方言(如 anthropic-messages
  代理)字段会在途中被丢弃或拒绝,故 `/fast on` 会提示对当前模型无效而不
  注入;设置仍全局持久化,换到适用的模型后生效。
- modes 应用带 `:effort` 的 profile 时,调用的是所有者(`setFromProfile`),
  不直接调 pi。

## 测试

`extensions/effort/tests/` —— node:test 经 tsx(沿用来源框架):
`effort.test.ts`、`effort-picker.test.ts`、`integration.test.ts`、
`owner-adopt.test.ts`、`ui.test.ts`。所有者逻辑另在 `test/lib/` 的
`effort-owner.test.ts` 覆盖。
