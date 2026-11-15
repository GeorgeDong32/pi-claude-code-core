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
`PI_CORE_COMPACTION=off|shadow|on`, command `/smart-compact [status|mode …]`.
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

## Default-On Field Data (2026-11-14)

First read-only collection after the user-authorized default-on landing
(2026-11-11). Method: both machines' `~/.pi/agent/sessions/` JSONLs were
searched for `cc-core-compaction` / `cc-core-compaction-metrics` entries;
matches were copied to a private `/tmp` directory outside the repository,
analyzed, and deleted afterwards. Only counts and durations are reported —
no session content. Air was read over read-only ssh.

Inventory (strict entry-shape match, not prose mentions):

| Machine | Sessions With Entries | ST-01 Entries | Metrics Entries |
|---|---|---|---|
| Local | 0 | 0 | 0 |
| Air | 3 | 3 | 12 |

Correction to the interim count: the previously reported "34 ST-01 entries in
4 files, 2 metrics entries in 1 file" for this machine was prose contamination
— backtick mentions in assistant messages and observation-pack text objects,
zero real telemetry entries. Air's `rg` absence additionally produced a false
"NONE" on the first probe; grep confirmed the inventory above. Air runs the
git-clone install at commit `426f8e9` (includes the 2026-11-11 default-on
rework) with no `core-compaction.json`, so the default `mode: "on"` applied.

All 12 metrics rows and all 3 ST-01 entries are timestamped 2026-11-12 (the
three sessions themselves started 2026-11-02…11-04 and were resumed later).
Each session contains exactly one complete precompute cycle:

| Session (Air) | Commit Pressure | T_n | estPostTokens | summaryChars | computeMs | Outcome |
|---|---|---|---|---|---|---|
| online_platform 01a19f76 | 378,002 | 500,000 | 129,525 | 17,570 | 66,708 | applied |
| SFC_AMASGO 01a19a55 | 392,749 | 500,000 | 171,814 | 26,633 | 62,455 | applied |
| SFC_AMASGO 01a1a5c0 | 375,267 | 500,000 | 219,552 | 32,121 | 82,721 | applied |

Aggregates (`scripts/compaction-metrics.mjs`, 0 malformed lines):

- SC-6 observed early-takeover rate: **3/3 = 1.0** — 3 early confirmed draft
  commits / (3 confirmed draft commits + 0 threshold fallback attempts);
  manual 0, overflow 0 (reported separately per SC-6).
- No adverse events at all: 0 discarded, 0 refused, 0 threshold/overflow/manual
  fallbacks, 0 fallback failures, 0 shadow degradations (`degraded:false` on
  every row, `conflictEdit:0` on every ST-01 entry); every cycle is
  `origin:"precompute"`, `validated:true`.
- computeMs p50 66,708 / p90 82,721; apply elapsedMs 12–26 (draft commit is
  off the critical path). Commit pressure landed 107K–125K below T_n;
  compute-start lead p50 129,816 / p90 199,705 tokens.
- Compression: estPostTokens is 34.3% / 43.7% / 58.5% of the pre-commit
  pressure (estimates, not measured post-compaction context).

**Assessment: insufficient data.** Three cycles in three long-running sessions
is far below any stability/reliability, compression-effect, or time-saving
evaluation standard (O2). "Zero adverse events in 3 cycles" is consistent with
the design intent but is not evidence of release quality — no extrapolation is
made, and M1 remains unavailable on field data (`counterfactualM1Available:
false`). SC-1's three unattributed replay misses are **not adjudicated** by
this sample: they require discard/refusal reason codes, and this sample
contains zero discarded/refused events — the item stays open. One observation
(not a defect): in two sessions the confirmed commit landed hours after
compute-ready (≈4.7 h / ≈8.5 h, overnight or long-idle sessions) — the draft
is held ready and commits at the next host boundary, per design.

Reproduce: `pnpm exec tsx scripts/compaction-metrics.mjs <jsonl-or-dir>`.

## Real-Machine Acceptance (2026-11-15, SR batch)

Interactive H-SC acceptance executed on a real TUI (pi 1.5.2 driven through
rex PTY panes, model `CPA/glm/glm-5.3-flash` via the localhost:8317 proxy,
isolated sandbox HOME + `PI_CODING_AGENT_DIR`, controller snapshot from
`git archive`). Scenario settings per spec §7.3: `modelOverrides` put T_n at
120K on the 1M window (reserveTokens 880000, keepRecentTokens 8000); a
corpus of ~99 KB seeded-random files (~23K tokens each) drove context past
thresholds; observation-pack was disabled per scenario (it projects large
reads and keeps context below threshold — acceptance and projection are
mutually exclusive, an environment note, not a defect).

| Scenario | Outcome | Key evidence |
|---|---|---|
| H-SC-1 precompute takeover | PASS | proposal @91,369 (0.75 line), metrics four beats, ST-01 `applied/validated`, zero native spinner events, 91k→45k same-run continuation |
| H-SC-2 resume after compaction | PASS | `--continue` replays "Session compacted 1 time", answers from summary without re-reading |
| H-SC-3 ratio-group 0.98/0.99 + fallback leg | PASS | single-turn double read → 120,421; `origin:"native-backfill"`, fallback 18.8 s ≪ 150 s deadline; probe saw `session_before_compact`+`session_compact` |
| H-SC-4 manual /compact | PASS | native spinner captured; entry `fromHook:false`, no ccCore origin; controller FB-08 audit-only |
| H-SC-5 `PI_CORE_COMPACTION=off` / `enabled=false` | PASS (both legs) | off: zero trace (earlier batch); disabled-in-config: `mode: shadow (configured on)`, zero telemetry |
| H-SC-6 summary-model failure chain | PASS with caveat | dead model → `refused/reason:"error"`, cooldown shown, native takeover at 120,707, session survives. Caveat: the CPA proxy routes unknown model ids to a default backend, so a persistently-dead model is not constructible via CPA; direct-endpoint injection stays pending |
| H-SC-7 rex-flow ledger | Mechanism PASS | trusted-path board association; summary ledger lists run/open tasks/closed tasks (one line each)/gate/sentinels; decoy board absent. A real orchestrator-driven run remains pending evidence |
| S3 GLM endpoint compliance | PASS (observable criteria) | thinking-off summaries are real body text, not truncated (3,674 and 5,861 chars; 8192-token cap injected for the second). MiniMax / OpenAI-compatible endpoints pending (single provider on this machine) |

Host-side findings recorded by the same batch: AR1005-RU-HOST PASS; AR1005-ST-HOST
⑪ adjudicated with the premise INVERTED on pi 1.5.2 (message_end fires after
the SessionManager append — the modes cache marks dirty on multiple events by
design and never relied on the ordering); XPKG-09-HOST async face (timer-
registered mid-turn widget lands at map tail under both load orders). Full
field-level ledger: `~/.cache/pi-core-acceptance/2026-11-15/LEDGER.md` (raw
jsonl/screens stay outside the repository). Outstanding: H-SC-7's real
orchestrator run, S3's remaining endpoints, H-SC-6 direct-endpoint fault
injection; SC-1's three unattributed misses still have no reason codes.
TR batch close-out (2026-11-15, sandbox `~/.cache/pi-core-acceptance/2026-11-15-tr/`):
most of the items left open above are now settled. H-SC-7's real orchestrator run:
**all criteria PASS** — a full L2 pipeline ran for real (planner / 3 workers /
gatekeeper as independent sessions, t1–t3 merged, one rework round); compaction
landed exactly between t2's merge and t3's dispatch (tokensBefore 90,282, ST-01
applied/validated, 9,369-char summary); the summary ledger `[flow r1 · reviewing]`
carried the open run, one line per merged task, the open t3, and the sentinels,
with the decoy board absent from the ledger; after compaction, t3 was dispatched
from ledger ids with protocol commands only and zero board re-reads. S3-MiniMax
PASS (M3.1-Flash, applied/validated, 2,533-char body); S3-OpenAI-compatible PASS
(full openai-completions adapter path, 3,041-char body); H-SC-6 strict leg PASS
(a genuinely dead endpoint 127.0.0.1:9: precompute refused + cooldown → native
threshold trigger → the regenerate leg uses the session model by design
(`summaryModel` governs precompute only) → a real summary via native-backfill →
session survived). This closes the earlier note that CPA's fallback routing made
a persistently dead model unconstructible. Still pending evidence: S3-GPT (the
CPA deployment has no gpt backend, 400 unknown provider; resume condition = a
routable GPT endpoint); SC-1's three unattributed misses still have no reason codes.
