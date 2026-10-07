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
- `snapshot.instance` (XPKG-03, 2026-10-07 P1-1): a random id minted once
  per bus instance, constant across that instance's publishes. pi loads
  extensions with jiti `moduleCache:false`, so `/reload` builds a NEW bus
  while `globalThis` still serves the old snapshot until the new bus's
  first publish — consumers detect the swap by comparing `instance` and
  re-subscribe via the new snapshot's onChange. Old snapshots may lack the
  field (fall back to comparing onChange identity).
- `display.footer` is a multi-source channel (XPKG-07): producers call
  `extensions/ui/footer-lines.ts#setFooterLine(source, line)` which keeps
  one map per bus instance and publishes the whole merged, source-sorted
  array in one patch. Rendered by whichever footer holds the slot — the
  core modes footer appends the lines (dim, clamped) after its own two
  lines; a live cctui's cc-footer renders them instead. After an explicit
  `/claude-tui off` the host stock footer shows nothing from this channel
  by design (no presence-based hand-back).

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
