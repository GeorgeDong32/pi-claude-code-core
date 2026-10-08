# H-Q: dual REAL pi session drain acceptance (2026-10-08, re-run after evidence review)

Spec: `spec/2026-10-08-followup-execution.md` §4 (Core 负责 H-Q).
Runner: `scripts/hq-drain-evidence.sh` (reproducible; everything under an
isolated HOME + `PI_CODING_AGENT_DIR` + project dir in /tmp).

## Evidence review findings that forced this re-run (2026-10-08)

The first evidence batch had three defects, found by the follow-up review
and fixed in the runner before this re-run:

1. **Staging filename collision (the mismatch record never existed).** The
   old staging used `Date.now() + 8` for the mismatch record and
   `Date.now() + i` (i ≤ 7) for the matching ones; a millisecond boundary
   made loop i=7 write `T0+1+7` over the mismatch's `T0+8` file — silently
   destroying the mismatch record before any session ran. The old "final
   resting state not captured" open note was actually "record never
   staged". The runner now uses a monotonic staging clock + a post-staging
   uniqueness/count assert and writes `staging-manifest.json`.
2. **Sampler blind window.** The sampler booted AFTER both sessions; the
   staged-ready baseline was never captured. It now starts BEFORE session
   A, so sample #1 pins all 8 records ready.
3. **README/PROGRESS number drift.** "9 samples" vs 8 in the JSON, "by
   t≈4.6 s every claim settled" vs an empty-at-t=2846 ms timeline. This
   README quotes the JSON directly.

## Environment

- Host: real `pi` 1.0.2 from PATH, `-p` non-interactive, two concurrent
  processes (A then B 0.4 s later) in the same project.
- Implementation under test: a `git clone --no-hardlinks` of THIS repo at
  `4b0f8d9` (revision in `core-revision.txt`) preset into the isolated
  agentDir's `git/github.com/GeorgeDong32/pi-claude-code-core` and loaded
  via settings `packages` — the REAL extension factory, not a fixture.
- Queue: 8 pre-staged records (7 routing-matching + 1 deliberately
  mismatched projectsDir), each `{v:1, attempts:0, parts:[user,assistant]}`
  — asserted on disk before the sessions start (staging-manifest.json).

## Verdict (verdict.json, from this final run)

| Requirement | Result | Evidence |
|---|---|---|
| 同一记录仅一位 live owner | PASS | `doubleClaims: []` across all 9 samples; every `.claim.<pid>.…` basename appears at most once per original at any sampled instant |
| cap(QUEUE_DRAIN_MAX=5)之后候选仍可消费 | PASS | t=486 ms: session A (pid 33074) holds exactly 5 claims, 2 records stay ready; t=729 ms: session B (pid 33081) claims those 2 — the surplus stays consumable by another session |
| 失败/结束后无搁浅活 claim | PASS | `strandedClaimsAtEnd: []`; last claim gone by t=3710 ms, t=5733 ms shows only the pending mismatch record; exitA=exitB=0 |
| 队列转移证据保留 | PASS | `queue-timeline.json` (9 samples: 8-ready baseline → 5-claim cap + 1 pending → 7-claim two-owner → monotonic settle → mismatch-only pending), `session-{A,B}.{out,err}`, `staging-manifest.json`, `core-revision.txt` |
| 失败记录的最终归宿（原 open note） | **PASS — explicit** | The mismatch record: ready at t=27 → claimed and released to `<ready>.pending.<nonce>` at t=486 (session A's drain) → re-claimed and re-released under a NEW nonce at t=729 (session B's drain) → **final state: pending** (`finalPending: 1`, content in `final-pending-record.json` with `attempts: 0` untouched and the wrong projectsDir preserved) — retryable by a future session, never a stranded claim, never GC'd without explanation |

All 7 routing-matching records were consumed (settle). The extraction
model judged the synthetic facts not worth persisting (empty ops → settle
without writes) — ownership-protocol behavior is what this acceptance
pins.

## Failure-path observations (carried over, still valid)

- Routing mismatch (wrong `projectsDir`): claim → validation skip →
  released back to `<ready>.pending.<nonce>` with `attempts` untouched
  (now proven twice in ONE run — each session's drain re-validated and
  re-released it), no stranded claim. The macOS `/tmp` → `/private/tmp`
  realpath trap (pre-fix run where all records mismatched) is handled by
  staging with the canonical path.
- Very short-lived `-p` sessions (first exploratory run): the background
  drain is cancelled at shutdown — records return to pending (attempts 0)
  with zero claim residue; retryable next session. Not a protocol
  violation.

## Reproduce

```bash
bash scripts/hq-drain-evidence.sh
```

Requires: `pi` on PATH, `~/.pi/agent/{auth,models}.json` present
(credentials stay inside the isolated copy), CPA provider reachable for
`CPA/model-fast`.
