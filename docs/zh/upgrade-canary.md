# 升级金丝雀

> 英文版：[upgrade-canary.md](../en/upgrade-canary.md) · 规格：[entropy-control-spec.md](entropy-control-spec.md) Goal 1 [C7]

## 为什么需要

升级 pi 宿主后，两个经济型机制可能**静默失效**——不报错，会话只是悄悄变差：

- **ObservationPack**：超大 tool result 可能不再被占位符替换——上下文膨胀、token 成本悄然回升，没有任何报错。
- **Action Fusion**：`then_run` 可能不再被识别为写+验证融合步骤——模型退回单独的 bash 轮次。

失效根源是宿主 API 语义漂移（工具注册、消息形状），只断言自身代码的常规单测看不见它。

## 怎么跑

```bash
npx vitest run test/lib/upgrade-canary.test.ts --config vitest.config.ts
```

**升级 pi 依赖前**跑一次，升级后的树里再跑一次。升级前绿 + 升级后红 = 升级破坏了机制。

## 失败时排查

只查两个机制：

1. `ObservationPack projection degraded` → 投影管线（`extensions/observation-pack/projection.ts#projectContext` → `observation.ts#createObservation`/`placeholderFor`）不再替换大结果。
2. `Action Fusion then_run recognition degraded` → 重注册的 write/edit schema 或 `extensions/action-fusion/then-run.ts#executeMutationThenRun` 不再合并后续命令。

## 与三门禁的关系

**不属于**三个常规门禁（`bun run check` / `bun run test` / `bun run contracts`）。升级专用：改 pi 版本时跑。
