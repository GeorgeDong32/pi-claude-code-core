# observation-pack — Large Result Projection

> English. 中文版: [../zh/observation-pack.md](../zh/observation-pack.md)

**Directory**: `extensions/observation-pack/` — economy module, ported from
NVlabs/SoL-Pi (MIT), SPEC OBS-01..10 (absorbed in 0.2.0)

## What it does

Keeps large tool results reachable without replaying them: a pure-text tool
result larger than `THRESHOLD_BYTES` (10 KiB) is sent in full for its first
`FULL_SENDS` (2) provider requests; afterwards the `context` projection
replaces it with a short stable placeholder (~1 KiB, complete lines). The
original bytes live in a per-session store and the agent pages them back with
the **`obs_recall`** tool (paging header included in the model-visible text).

**Presentation (TR, spec 2026-10-02-core-tool-renderers)**: `obs_recall`
ships its own renderCall/renderResult (`renderers.ts`) — one short call row
(`Recall Observation obs_4b1d7b39 · +15.5KB`) and a paged result view
(size · lines · range, content preview capped at 5 lines, `end ✓`/`more ▸`)
built from `details`; the two model-protocol header lines are stripped from
what the user sees (kept for the provider, read-only here). cctui auto mode
respects the renderer; force mode exempts it (`FORCE_RESULT_EXEMPT`).

## The one rule that matters

**It never edits history.** The mechanism rewrites only the projection layer
(`pi.on("context")`), so the transcript, TUI rendering, native compaction and
session resume are all unaffected. Per-message fail-open; a request-level
sentinel warns when the projection stops taking effect (CMP-04).

## Switches, storage, bus

- `~/.pi/agent/core-economy.json` → `observationPack: bool` (default true;
  `lib/core-economy.ts`).
- Storage root derived via the sessionManager public API — originals under
  `<sessionDir>/observation-pack/<sessionId>/`.
- `lib/pi-compat.ts` gates the module; degradation warns, never blocks.
- **Bus**: `observation` channel — `{ tokensAvoided, placeholders, sites? }`. `sites` (OBS-09-SITES) is display-only per-site savings — one `{ tool, id, avoidedTokens }` entry per observation first replaced by that request; the TUI flashes it as a single-shot saving. It never enters the projected messages. Entries also carry the source `toolCallId` — the display-side row correlation key (the projection rewrites only the provider request, so content shape cannot locate the packed row).

## Files

| File | Notes |
|---|---|
| `index.ts` | Assembly: context projection, obs_recall tool, sentinel |
| `observation.ts` | `createObservation`, `ensureStored`, `placeholderFor`, `isPureTextResult`, thresholds (`THRESHOLD_BYTES`, `FULL_SENDS`), UTF-8 boundary withholding (4-byte emoji safe) |
| `ledger.ts` | Cumulative `ObservationPatch` ledger for the bus |
| `projection.ts` | The pure projection step (candidate loop, send-count recovery, FULL_SENDS decision, sentinel). **AR1005-OB (2026-10-05)**: `ProjectionState` also owns the STABLE placeholder memo — keyed by the same `${root}\0${toolName}\0${toolCallId}` identity, value = the placeholder string + token estimate only. The head/tail complete-line construction (a full-text scan, ~26 ms at 8 MiB) ran on EVERY hot request; it now runs once per identity per process (measured: 1 construction across 51 requests at 16 KiB/2 MiB/8 MiB, hot requests ~0.001 ms). The memo is populated at the FIRST replacement need (never during full-send), reused verbatim, kept across a failed ledger append (the counts/savings stay uncommitted and retry), and never crosses roots/tools; a process restart regenerates. `placeholderConstructions` on the state is the honest observable (no monkeypatching, no production export config). Ledger rows are still appended per replacement request — the memo never skips the audit |

## Invariants & gotchas

- Placeholders must be stable across requests (id-addressable, obs-id
  format validated by `isObservationId`).
- Budget-aware breaks drop the smallest whole block rather than overshoot
  (C13 fix) — keep that behavior.
- Works hand-in-hand with `session_recall` (memory) but is a separate tool
  and store.

## Tests

`extensions/observation-pack/tests/` — node:test via tsx; host semantics of
the projection are additionally pinned in `test/contracts/pi-host-semantics.test.ts`.
