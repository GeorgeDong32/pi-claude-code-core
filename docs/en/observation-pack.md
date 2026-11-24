# observation-pack — Large Result Projection

> English. 中文版: [../zh/observation-pack.md](../zh/observation-pack.md)

**Directory**: `extensions/observation-pack/` — economy module, ported from
NVlabs/SoL-Pi (MIT), SPEC OBS-01..10 (absorbed in 0.2.0)

## What it does

Keeps large tool results reachable without replaying them: a pure-text tool
result larger than `THRESHOLD_BYTES` (10 KiB) is sent in full for its first
`FULL_SENDS` (2) provider requests; afterwards the `context` projection
replaces it with a short stable placeholder (~1 KiB, complete lines). The
original bytes live in a per-session store and the agent reads them back with
the **`obs_recall`** tool: page by byte `offset`, or select first — `filter`
(regex over the whole object, `context` lines around each match, default 2)
or `tail` (last N lines); `offset` then pages the selection. Selected lines
carry their 1-based number (`N: ` match, `N  ` context). The placeholder
names the on-disk path so the file can be grepped directly. Protocol header
in the model-visible text: two lines, plus a third `[selection: …]` line for
a selection (P0-2, 2026-11-24: in 30 days of session logs every recall paged
start to end — median 2, max 4 round trips — because the model had no way to
ask for the failing lines).

**Presentation (TR, spec 2026-10-02-core-tool-renderers)**: `obs_recall`
ships its own renderCall/renderResult (`renderers.ts`) — one short call row
(`Recall Observation obs_4b1d7b39 · +15.5KB`, or `· filter "FAIL"` / `· tail 40`; the result header shows `2/10 matched · …` or `last 2 of 10 · …`) and a paged result view
(size · lines · range, content preview capped at 5 lines, `end ✓`/`more ▸`)
built from `details`; the two (selection: three) model-protocol header lines
are stripped from what the user sees (kept for the provider, read-only here). cctui auto mode
respects the renderer; force mode exempts it (`FORCE_RESULT_EXEMPT`).

## The one rule that matters

**It never edits history.** The mechanism rewrites only the projection layer
(`pi.on("context")`), so the transcript, TUI rendering, native compaction and
session resume are all unaffected. Per-message fail-open; a request-level
sentinel warns when the projection stops taking effect (CMP-04).

Two BH-E3 refinements (2026-11-14): the whole `context` handler body is
fail-open too — any throw in the adapter (session-root resolution, ledger
wiring, the bus publish) is caught, logged once, and the provider request
returns unmodified (invariant 8). And `obs_recall` results never re-enter
the projection: they ARE recall excerpts, so packing them would nest packs
inside packs.

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
| `index.ts` | Assembly: context projection, obs_recall tool, sentinel. P0-2: the tool takes `filter`/`context`/`tail`; a `RecallSelectionError` (bad regex, non-positive tail, oversized object, offset past the selection) comes back as `obs_recall: <reason>` text, not as "unknown observation id"; the first header line stays byte-identical (XPKG-04) |
| `observation.ts` | `createObservation`, `ensureStored`, `placeholderFor`, `isPureTextResult`, thresholds (`THRESHOLD_BYTES`, `FULL_SENDS`), `readRecallSelected` + `SELECTION_MAX_BYTES` (8 MiB) + `RECALL_DEFAULT_CONTEXT` (2) for P0-2 selection, the on-disk `path:` line in the placeholder, UTF-8 boundary withholding (4-byte emoji safe). CH E11: `estimateTokens` counts ASCII code points /4 and every non-ASCII code point as 1 (`"中文测试"` → 4, was 1 under the upstream `length/4`) — a deliberate deviation from the SoL-Pi original; field shapes unchanged |
| `ledger.ts` | Cumulative `ObservationPatch` ledger for the bus |
| `projection.ts` | The pure projection step (candidate loop, send-count recovery, FULL_SENDS decision, sentinel). **AR1005-OB (2026-10-05)**: `ProjectionState` also owns the STABLE placeholder memo — keyed by the same `${root}\0${toolName}\0${toolCallId}` identity, value = the placeholder string + token estimate only. The head/tail complete-line construction (a full-text scan, ~26 ms at 8 MiB) ran on EVERY hot request; it now runs once per identity per process (measured: 1 construction across 51 requests at 16 KiB/2 MiB/8 MiB, hot requests ~0.001 ms). The memo is populated at the FIRST replacement need (never during full-send), reused verbatim, kept across a failed ledger append (the counts/savings stay uncommitted and retry), and never crosses roots/tools; a process restart regenerates. `placeholderConstructions` on the state is the honest observable (no monkeypatching, no production export config). **BH-E3 (2026-11-14)**: obs_recall results are exempt from projection entirely (a recall excerpt packed again nests packs — Air saw 53 nested objects); the placeholder ledger row is written ONCE per object id per process (`placeholderLedgered` seen-set — per-request rows ballooned Air session ledgers to 43 MB / 194K rows; a failed append stays unmarked and retries, OBS-08; line format unchanged); and the candidate check sits inside the per-message fail-open try, so even a malformed message fails open instead of killing the request |

## Invariants & gotchas

- Placeholders must be stable across requests (id-addressable, obs-id
  format validated by `isObservationId`).
- A selection reads the whole object (ceiling `SELECTION_MAX_BYTES`); above
  it the model pages by `offset`. `grep -q`-style probes are unaffected —
  `filter` reports coverage (`matched=N of M lines`) instead of a status.
- Budget-aware breaks drop the smallest whole block rather than overshoot
  (C13 fix) — keep that behavior.
- Works hand-in-hand with `session_recall` (memory) but is a separate tool
  and store.

## Tests

`extensions/observation-pack/tests/` — node:test via tsx (`recall-selection.test.ts`
for P0-2); host semantics of the projection are additionally pinned in
`test/contracts/pi-host-semantics.test.ts`.
