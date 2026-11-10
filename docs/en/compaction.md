# Smart Compaction (extensions/compaction)

The 14th core module: a takeover compaction controller that pre-computes
summaries in the background (parallel to the main conversation), proposes
them as `turn_end`/`agent_before_settle` boundary drafts, and confirms every
proposal against the host's own branch record (`ready → proposed →
committed`). Native compaction stays on as the overflow/threshold/manual
fallback leg; the controller's fallback leg can supply a precomputed or
freshly-generated summary to the native path (`session_before_compact`),
always behind the hard capacity gate V8a.

Full design: `spec/2026-11-08-smart-compaction-takeover.md` (§5 requirement
table). This page carries the mechanism summary and the W2 calibration
record.

## Mechanism in one page

- **Pressure policy** (`policy.ts`): `T_n = contextWindow − effectiveReserve`,
  `P = tokens / T_n`; precompute at `preRatio`, propose at `applyRatio`,
  joint feasibility (`POL-09`) before anything starts.
- **Cutpoint** (`cutpoint.ts`): capacity-first window
  `[keep, min(keep + slack, tailMax)]`, host-faithful legality, semantic
  scoring (user/idle-gap/plain-turn/tool-turn + W7/W8 signals).
- **Summarizer** (`summarizer.ts`): pi's public `compact()` through a
  `streamFn` wrapper — per-sub-call classification/capture, `maxTokens`
  injection, reasoning off, two-layer validation (SUM-04), one hardened
  retry.
- **Apply** (`apply.ts`): V1–V10 prechecks (V10 = hold), draft with a
  reconciliation nonce, branch-scan reconcile → committed/lost, post-commit
  conflict-edit audit.
- **Ledger** (`ledger/`): deterministic, regenerated at apply time, budget
  12 000 chars with a six-step degradation ladder and a Tier A/B self-check.
- **Fallback** (`fallback.ts`): `session_before_compact` supply leg under a
  single total deadline; native summaries are audited (FB-08), never
  intercepted.
- **Seam** (`lib/compaction-seam.ts`): goal/modes/memory hooks fire exactly
  once per confirmed commit (draft path) and once via their own pi events
  (native path).

Configuration: `~/.pi/agent/core-compaction.json` (ST-02), env
`PI_CORE_COMPACTION=off|shadow|on`, command `/compaction [status|mode …]`.

**POL-07 propose gate (A1, 2026-11-10 review fix)**: the draft path itself now
evaluates apply-point safety — the LAST assistant entry's stopReason is read
from the boundary branch (covers both `turn_end` and `agent_before_settle`);
`length` boundaries never propose, so native recovery is never swallowed.
**Served transition (A2)**: after the fallback leg supplies a snapshot, the
phase leaves `ready` (idle) — the controller re-precomputes instead of
re-proposing a consumed draft. **Overridden bound (A3)**: lost(overridden)
re-proposals are capped — once the CUMULATIVE per-session override count
reaches `OVERRIDE_DEGRADE_AFTER = 2` (exported from state.ts, same family as
conflictEditDegradeAfter) the controller degrades to shadow; EVERY overridden
occurrence writes APP-08 discarded telemetry (`reason:"overridden"`).

## W2 replay calibration record (2026-11-09)

Tool: `tsx scripts/compaction-replay.mjs <corpus>… [--self-check] [--json]`
(aggregates only — INV-7). Corpus: the local machine's pi sessions
(1 166 jsonl files; 11 sessions with a derivable threshold, 23 native
threshold events). **The second machine's corpus is a pending-evidence
item** (not present on this machine); re-run the same command there to
complete the record.

| Metric | Result (fixed-ratio defaults) | Notes |
|---|---|---|
| M1 threshold-precommit rate | **0.52** (12/23) | target ≥ 0.90 NOT met on this sample — attribution below |
| M2 cut legality | 1.00 (by construction, pinned by CUT-01) | |
| M3 tail ≥ keep | 0.65 | small-view fallbacks on tiny post-compaction segments |
| M3b capacity / V8b-at-apply | 1.00 / 1.00 | capacity-first selection holds on real trajectories |
| M4 split share | 0.10–0.30 across schemes | below native's (semantic boundaries find more turn starts) |
| M6 native blocking | total ≈ 2 238 s over 23 events; p50 ≈ 103 s, p90 ≈ 171 s | matches E1's 53–171 s band |
| M7 feasibility coverage | 10/11 sessions feasible | 1 small-window session (T_n ≈ 45.7 K) correctly infeasible (R15) |
| M8 estimate deviation | p50 ≈ 0.52, p90 ≈ 0.59 | chars/4 vs usage scale — the calibration factor below exists because of this |
| M9 turn increments | p50 526 / p90 2 057 / p99 6 456 / max 26 623 tokens; >5 K: 1.9 %, >15 K: 0.18 %, >30 K: 0 % | bursts exist but stay well under a 25 K lead |
| M10 wasted compute | 0.18 (fixed-ratio) / **0.00** (fixed-lead-25k/50k/75k) / 0.51 (naive adaptive) | |

**O1/O2 three-scheme comparison** (M1 / M3b / M10):

| Scheme | M1 | M3b | M10 |
|---|---|---|---|
| fixed-ratio (defaults) | 0.52 | 1.00 | 0.18 |
| fixed-lead-25k | 0.52 | 1.00 | 0.00 |
| fixed-lead-50k | 0.52 | 1.00 | 0.00 |
| fixed-lead-75k | 0.52 | 1.00 | 0.00 |
| rate-adaptive (naive) | 0.52 | 1.00 | 0.51 (V8b 0.50) |

Findings:

1. **M1's 11 misses attribute to**: 8/23 from ONE small-window session
   (T_n ≈ 45.7 K — POL-09-infeasible at default params by design, R15; the
   controller correctly refuses to serve it); 3/23 from multi-compaction
   sessions where the per-session median T_n approximation and per-turn
   usage sampling cannot see the real model's effective settings
   (modelOverrides) — a replay limitation, not a controller defect.
2. **Naive rate-adaptive is strictly worse** (M10 0.51, V8b-at-apply 0.50 —
   early snapshots grow past the efficiency gate). Any adaptive scheme must
   co-solve with POL-09, as the spec's O1 note requires. **Default stays
   fixed-ratio**; adopting fixed-lead is the only marginally better
   candidate on this sample (M10 0.00) but M1 does not move — O2 decision
   stays open for the user (no default change without it).
3. **Scale calibration**: persisted message chars/4 ≈ 22–40 % of the usage
   the host thresholds on (system prompt + tool definitions — POL-10's
   overhead). The replay scales cut-view message sizes per session
   (`sessionCharScale`, median ≈ 3.0); production needs no such factor —
   V8a estimates are calibrated from `getContextUsage()` directly.
4. **Appendix C defaults stand** pending the second-machine corpus and the
   user's O2 call.

Self-check: `tsx scripts/compaction-replay.mjs --self-check` (also pinned by
`test/lib/compaction-replay.test.ts`).
