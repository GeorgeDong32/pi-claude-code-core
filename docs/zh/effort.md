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

- **命令**:`/effort`(设置/循环思考档位)、`/fast`(为 `gpt-5*` 类快速模型
  开关 fast 模式)。
- **快捷键**:alt+t 循环思考档位(含 `off`;由 modes 模块注册,经 effort
  所有者按显式选择处理);ctrl+shift+e 由 effort 模块自身循环 effort
  (感知 env 钉死——`PI_CORE_EFFORT` 置位期间拒绝并提示)。
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
- fast 模式只对快速模型 id 生效(`gpt-5*` 前缀判断)。
- modes 应用带 `:effort` 的 profile 时,调用的是所有者(`setFromProfile`),
  不直接调 pi。

## 测试

`extensions/effort/tests/` —— node:test 经 tsx(沿用来源框架):
`effort.test.ts`、`effort-picker.test.ts`、`integration.test.ts`、
`owner-adopt.test.ts`、`ui.test.ts`。所有者逻辑另在 `test/lib/` 的
`effort-owner.test.ts` 覆盖。
