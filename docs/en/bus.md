# bus — Capability Bus

> English. 中文版: [../zh/bus.md](../zh/bus.md)

**File**: `extensions/bus.ts` (+ published types in `types/`)

The single state channel between core modules and external consumers.

## Shape

- `globalThis.__piClaudeCodeCore` → `CoreSnapshot`: **frozen pure data** —
  version, monotonic `revision`, and per-module channels: `modes` (mode,
  planPhase, workingStats, meta), `effort` (level + source), `goal`,
  `review`, `notifications` (bounded tail queue, cap 20, monotonic ids),
  `display.footer`, `contextBudget`, `memory`, `observation`, `fusion`.
- Legacy keys `__piPermissionModes` and `__pmWorkingStats` are derived from
  the same snapshot in the same synchronous batch — they can never disagree
  with it.
- v2 extension point: `snapshot.onChange(fn)` — a **data-carried** subscription
  field, version-gated; do NOT bolt on an event system.

## Discipline

- Publish **only inside pi event handlers**, no `await` gaps (single-threaded
  atomicity).
- Whole-snapshot replace + `Object.freeze` + monotonic revision.
- No timers, no polling.
- Readers use the total function `readCoreStatus()` from `types/` (works on
  any globalThis shape, returns a total `CoreStatus`).

## Publishing types

`types/index.d.mts` is a hand-maintained declaration twin of
`types/core-status.mjs` (published via the `./types` subpath export). Shape
compatibility with `extensions/bus.ts` is guarded by
`test/lib/bus-types.test.ts` — change both together.

## Consumers

CCTUI ≥1.5.0, pi-agent-panel, and core's own UI adapters
(`extensions/ui/`). Legacy keys serve CCTUI <1.5.0 and old panels; their
removal conditions are pinned in the contract table.

## Contracts

P0-CT-01..06 (legacy keys, shutdown semantics, inherited-mode env), P1-BUS-05
(core snapshot + legacy sync), P0-CT-07 (status slots). See
[test/contracts/README.md](../../test/contracts/README.md).

## Tests

`test/lib/bus.test.ts`, `bus-channels.test.ts`, `bus-types.test.ts`,
`coexistence.test.ts` (vitest).
