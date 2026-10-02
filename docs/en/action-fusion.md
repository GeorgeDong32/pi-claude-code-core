# action-fusion — Mutation + then_run in One Turn

> English. 中文版: [../zh/action-fusion.md](../zh/action-fusion.md)

**Directory**: `extensions/action-fusion/` — economy module, ported from
NVlabs/SoL-Pi (MIT), SPEC FUS-01..11 (absorbed in 0.2.0)

## What it does

Fuses a file mutation and its follow-up command into one model turn: the
built-in `write`/`edit` tools are re-registered with an optional
`then_run` object parameter (`{ command }`). Execution delegates to the
built-in implementation, then runs the command through the built-in bash tool
(so the full permission pipeline is inherited) and merges the outputs.

## Semantics

- Marker semantics kept exactly: successful follow-up appends
  `then_run` output; mutation failure or nonzero exit routes to
  `[then_run:failed]` / `skipped` shapes.
- Guidance is dual-channel: the `then_run` schema + a tool-description tail.
- Renderers pass through the built-in renderers — zero new rendering surface (CMP-03). TR badges ADD only: a wrapped row `↳ then_run: <command>` under fused calls and a colored status row (`✓ ok` / `✗ failed` / `⊘ skipped`, scanned read-only from the result markers); plain write/edit render byte-identically (zero-wrap rule).

## The queue rule (important)

The module uses its own fused per-file queue (`file-queue.ts`,
`withFusedFileQueue`) as the OUTER layer. The official
`withFileMutationQueue` cannot be the outer layer — it re-enters against the
built-in tools' own queue and deadlocks (sandbox-proven). Don't "simplify"
this back.

## Switches & compat

- `~/.pi/agent/core-economy.json` → `actionFusion: bool` (default true;
  malformed file degrades to defaults — `lib/core-economy.ts`).
- `lib/pi-compat.ts` probes (version ≥0.87.0, tool factories, mutation
  queue) gate the module; degradation warns, never blocks.
- **Bus**: `fusion` channel — `{ fusedCount }`.

## Files

| File | Notes |
|---|---|
| `index.ts` | Assembly: re-register write/edit, guidance, execution merge |
| `then-run.ts` | `createThenRunSchema`, `executeMutationThenRun`, exit-shape logic |
| `tool-path.ts` | `resolveToolPath` + `normalizeToolPath` (path knowledge, arch B6) |
| `file-queue.ts` | `withFusedFileQueue` (the outer queue) |

## Tests

`extensions/action-fusion/tests/then-run.test.ts` — node:test via tsx.
