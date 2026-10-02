# observation-pack — 大结果投影

> 中文版。English: [../en/observation-pack.md](../en/observation-pack.md)

**目录**:`extensions/observation-pack/` —— economy 模块,移植自
NVlabs/SoL-Pi(MIT),SPEC OBS-01..10(0.2.0 吸收)

## 做什么

让大体积工具结果不必重放也能继续取用:超过 `THRESHOLD_BYTES`(10 KiB)的
纯文本工具结果,前 `FULL_SENDS`(2)次 provider 请求完整发送;之后由
`context` 投影替换为短而稳定的占位符(约 1 KiB,完整行)。原文存于每会话
存储,agent 用 **`obs_recall`** 工具按页取回(模型可见文本含翻页头)。

**呈现(TR,spec 2026-10-02-core-tool-renderers)**:`obs_recall` 自带
renderCall/renderResult(`renderers.ts`)——短调用行(`Recall Observation
obs_4b1d7b39 · +15.5KB`)+ 分页结果视图(大小 · 行数 · 范围,内容预览
≤5 行,`end ✓`/`more ▸`),数据来自 `details`;两行模型协议头对人剥离
(给模型的文本原样,渲染层只读)。cctui auto 模式尊重自带渲染器;force
模式豁免(`FORCE_RESULT_EXEMPT`)。

## 唯一要紧的规则

**绝不改历史。** 机制只重写投影层(`pi.on("context")`),transcript、TUI
渲染、原生压缩与会话恢复均不受影响。逐消息 fail-open;请求级哨兵在投影
失效时告警(CMP-04)。

## 开关、存储、总线

- `~/.pi/agent/core-economy.json` → `observationPack: bool`(缺省 true;
  `lib/core-economy.ts`)。
- 存储根经 sessionManager 公共 API 派生 —— 原文在
  `<sessionDir>/observation-pack/<sessionId>/` 下。
- `lib/pi-compat.ts` 门控本模块;降级只警告、不阻塞。
- **总线**:`observation` 通道 —— `{ tokensAvoided, placeholders }`。

## 文件

| 文件 | 说明 |
|---|---|
| `index.ts` | 装配:context 投影、obs_recall 工具、哨兵 |
| `observation.ts` | `createObservation`、`ensureStored`、`placeholderFor`、`isPureTextResult`、阈值(`THRESHOLD_BYTES`、`FULL_SENDS`)、UTF-8 边界 withhold(4 字节 emoji 安全) |
| `ledger.ts` | 面向总线的累计 `ObservationPatch` 台账 |

## 不变量与坑

- 占位符必须跨请求稳定(可按 id 寻址,obs-id 格式经 `isObservationId`
  校验)。
- 预算敏感的截断宁可丢弃最小整块也不许超预算(C13 修复)——保持该行为。
- 与 `session_recall`(memory)配合但相互独立:工具、存储都分开。

## 测试

`extensions/observation-pack/tests/` —— node:test 经 tsx;投影的宿主语义
另在 `test/contracts/pi-host-semantics.test.ts` 钉住。
