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

## Runtime Measurements (SC-MET-01)

Only `on` writes the separate display-only `cc-core-compaction-metrics` v1
entry: compute-start/compute-ready/proposal/applied/fallback-start/fallback-end.
Rows contain timestamps, random correlation ids, token pressure, the effective
threshold, configured ratios, phase/degraded state, and durations. They contain
no conversation, summary, file paths, or credentials. `off`/`shadow` write none;
the frozen ST-01 schema and compression parameters do not change.

From this checkout, aggregate session files locally (no model/network calls):

```sh
pnpm exec tsx scripts/compaction-metrics.mjs ~/.pi/agent/sessions
```

The JSON report includes compute latency/lead-token p50/p90, threshold fallback
phases (late compute versus missing/unusable snapshot), and separate manual/
overflow counts. `observedEarlyTakeoverRate` = confirmed pre-threshold draft
commits / (all confirmed draft commits + threshold fallback attempts).
Overridden proposals never count as commits; missing pressure is not success.
Applied rows preserve proposal-time pressure because post-compaction usage can
be null (H7). Partial/incomplete sessions and failed fallback attempts remain
visible in the counters. No samples means null, not 100%.

This is an **observed operational ratio**, not replay's counterfactual M1:
an early commit prevents the threshold crossing that would define the replay
denominator. `counterfactualM1Available:false` explicitly prevents treating
these measurements as proof of the >=90% release target. Prior 0.52 replay
results below have not been recalibrated by adding instrumentation.

## Mechanism in one page

- **Boundary clock**: a host boundary is observed once; the subsequent
  apply-time `propose` transition does not tick again. Distinct `turn_end`
  and `agent_before_settle` events still each tick (including null-pressure
  observations); cooldown settings retain their existing boundary unit.
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
`shadow` = fully passive: no precompute, no drafts, no fallback supply — only
the FB-08 native-summary audit remains (DEVIATIONS SC-5).

Default: **`on`** — user-approved 2026-11-10 (DEVIATIONS SC-1 recovery
clause ②), a user override rather than a gate pass: the replay facts stand
(cross-machine deduplicated M1 = 39/50 = 0.78 vs the 0.90 full-sample
target, feasible cohort 92.9%; second-machine corpus now supplied) and the
real-machine H-SC evidence list remains open (SC-3). Automatic demotions
are unaffected; rollback is one line (`PI_CORE_COMPACTION=shadow`).

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

**Batch D hardening (2026-11-10 review)**: `off` is now fully silent — the
FB-08 native-summary audit is gated too (G5 byte-identical; `shadow` keeps
it, SC-5). Ledger carry-over (LED-02b) and run-id extraction read only the
LAST complete v1 block of the previous summary, and the composed narrative
is tag-sanitized — a forged `<cc-core-ledger>` block echoed by the LLM can
no longer shadow the real ledger (D4). The ladder's step ⑤ clamps only the
goal objective — id/status identity fields stay verbatim (LED-01⑤, D5).

## W2 replay calibration record (2026-11-09)

Tool: `tsx scripts/compaction-replay.mjs <corpus>… [--self-check] [--json]`
(aggregates only — INV-7). Corpus: the local machine's pi sessions
(1 166 jsonl files; 11 sessions with a derivable threshold, 23 native
threshold events). This is the historical baseline. The second-machine
corpus was added on 2026-11-10; see the cross-machine section below for the
latest results and limitations.

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
   controller correctly refuses to serve it); 3/23 in multi-compaction
   sessions — **unattributed**: the instrumented trace shows them as
   marginal misses under the median-T_n proxy (precompute not started or P
   below the apply ratio), which is *consistent with* a threshold-estimate
   artifact; but `tokensBefore` is the context size at compaction time, not
   the configured threshold, so controller/timing factors cannot be ruled
   out (wording corrected in the 2026-11-11 pre-release review).
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

## Cross-Machine Replay (2026-11-10)

Same repair-worktree code, defaults, and summary-latency model; only the
corpus changes. All runs are offline: no model calls, parameter changes, or
default-mode changes. Raw sessions stay in a private local temporary directory,
never in the repository or report output. Air supplied 367 JSONL files
(391,052,581 bytes), all parseable. One live file continued growing after a
single retry; the snapshot is 3,141 bytes behind the final remote inventory,
not atomic or inclusive of subsequent appends.

| Corpus Definition | JSONL / Files With Inferred Threshold | M1 (Default Fixed Ratio) |
|---|---|---|
| Local, historical per-file convention | 1,167 / 11 | 12/23 = 52.2% |
| Air, per-file | 367 / 12 | 29/29 = 100% |
| Cross-machine, conservatively deduplicated | 1,487 / 21 | **39/50 = 78.0%** |

Deduplication collapses 44 identical files and one shorter append-only
snapshot of the same session id. Two local files sharing an id but containing
divergent histories each have one compaction; exclude both from the pooled
sample rather than counting correlated branches independently or choosing the
better result. The unfiltered pooled result is 41/52 = 78.8%, also below 90%.
This is a corpus/convention change, not an algorithm improvement. Neither
source has malformed JSONL; logs without session headers can only be
deduplicated by content hash.

**Diagnostic cohorts do not replace the release denominator**: the 20 files
classified feasible achieve 39/42 = 92.9%. One session with inferred
`T_n≈45.7K` contributes eight infeasible events. Three remaining misses occur
in feasible multi-compaction sessions; all three have been traced per-event
(instrumented simulateSession trace, 2026-11-10; attribution wording
corrected in the 2026-11-11 pre-release review): replayed against the
per-session median `T_n` (441K/446K), all three were marginal — the
controller was either still below the precompute ratio or holding a ready
snapshot whose P never reached the apply ratio when the inferred crossing
fired. That is *consistent with* a median-proxy estimation error but does
NOT prove it: `tokensBefore` is the context size recorded at compaction,
not the configured threshold (late compactions land far above it), so its
spread cannot establish that the real crossings sat 119K–229K below the
median. The root cause remains unattributed — controller or timing factors
cannot be ruled out; real-machine `cc-core-compaction-metrics` proposal/
discard reason codes are the arbiter. Production uses the host's live
effective threshold (H8) and has no median approximation. The tool infers T_n from median historical
`tokensBefore`, fixes keep at 20K, and does not independently identify the
historical compaction trigger reason. These are replay proxies, not verified
real windows or observed online takeover rates. Air's inferred thresholds
span roughly 251.6K–643.6K; the difference is not evidence of faster hardware.

| Scheme (Deduplicated Pool) | M1 | M10 Wasted Compute |
|---|---|---|
| Fixed ratio (defaults) | **78.0%** | 6.1% |
| Fixed lead 25K | 70.0% | 2.0% |
| Fixed lead 50K | 74.0% | 0.0% |
| Fixed lead 75K | 76.0% | 1.3% |
| Naive rate-adaptive | 78.0% | 33.7% (V8b-at-apply pass rate 68.2%) |

The second-machine evidence item is now supplied. Keep fixed-ratio defaults;
**full-sample M1 still misses the release target**. Do not substitute the
feasible subset as the denominator. H-SC interactive acceptance and endpoint
compliance remain pending. Reproduce each source with
`pnpm exec tsx scripts/compaction-replay.mjs <session-directory> --json`;
pool only the deduplicated inputs, never average the two percentages.
