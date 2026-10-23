# Upgrade Canary

> English mirror of [upgrade-canary.md](../zh/upgrade-canary.md) · Spec: Goal 1 [C7] in [entropy-control-spec.md](entropy-control-spec.md)

## Why

After upgrading the pi host, the two economy mechanisms can break **silently** — nothing throws, the session just quietly gets worse:

- **ObservationPack**: oversized tool results may stop being replaced by placeholders — context bloat and token cost return without any error.
- **Action Fusion**: `then_run` may stop being recognized as a fused write+verify step — the model falls back to separate bash turns.

Both degrade through host-API semantic drift (tool registration, message shapes), which unit-level asserts on our own code cannot see.

## How to run

```bash
npx vitest run test/lib/upgrade-canary.test.ts --config vitest.config.ts
```

Run it **before** bumping the pi dependency and again right after, in the upgraded tree. Green before + red after = the upgrade broke the mechanism.

## On failure

Check exactly two mechanisms:

1. `ObservationPack projection degraded` → the projection pipeline (`extensions/observation-pack/projection.ts#projectContext` → `observation.ts#createObservation`/`placeholderFor`) no longer replaces large results.
2. `Action Fusion then_run recognition degraded` → the re-registered write/edit schema or `extensions/action-fusion/then-run.ts#executeMutationThenRun` no longer merges the follow-up command.

## Relation to the gates

This is **not** one of the three regular gates (`pnpm run check` / `pnpm run test` / `pnpm run contracts`). It is upgrade-specific: run it when changing the pi version.
