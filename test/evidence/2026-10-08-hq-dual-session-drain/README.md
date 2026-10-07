# H-Q: dual REAL pi session drain acceptance (2026-10-08)

Spec: `spec/2026-10-08-followup-execution.md` §4 (Core 负责 H-Q).
Runner: `scripts/hq-drain-evidence.sh` (reproducible; everything under an
isolated HOME + `PI_CODING_AGENT_DIR` + project dir in /tmp).

## Environment

- Host: real `pi` 1.0.2 from PATH, `-p` non-interactive, two concurrent
  processes (A then B 0.4 s later) in the same project.
- Implementation under test: a `git clone --no-hardlinks` of THIS repo
  (revision in `core-revision.txt`) preset into the isolated agentDir's
  `git/github.com/GeorgeDong32/pi-claude-code-core` and loaded via settings
  `packages` — the REAL extension factory, not a fixture. Load evidence:
  `[permission-modes] Created … model-profiles.json` + the review module's
  banner in `session-*.err`.
- Queue: 8 pre-staged records (7 routing-matching + 1 deliberately
  mismatched projectsDir), each `{v:1, attempts:0, parts:[user,assistant]}`.
- Sampler: 25 ms directory snapshots into `queue-timeline.json`.

## Verdict (verdict.json, from the final successful run)

| Requirement | Result | Evidence |
|---|---|---|
| 同一记录仅一位 live owner | PASS | `doubleClaims: []` across all snapshots; every `.claim.<pid>.…` basename appears at most once per original at any instant |
| cap(QUEUE_DRAIN_MAX=5)之后候选仍可消费 | PASS | t≈28 ms: session A (pid 37178) holds exactly 5 claims, 2 records stay ready; t≈294 ms: session B (pid 37195) claims those 2 — the surplus stays consumable by another session |
| 失败/结束后无搁浅活 claim | PASS | `strandedClaimsAtEnd: []`; by t≈4.6 s every claim settled; exitA=exitB=0 |
| 队列转移证据保留 | PASS | `queue-timeline.json` (9 samples: 5-claim cap → 7-claim two-owner → monotonic settle → empty), `session-{A,B}.{out,err}`, `core-revision.txt` |

All 7 routing-matching records were consumed (settle). The extraction
model judged the synthetic facts not worth persisting (empty ops → settle
without writes) — ownership-protocol behavior is what this acceptance pins.

## Failure-path observations

1. Routing mismatch (wrong `projectsDir`): claim → validation skip →
   released back to `<ready>.pending.<nonce>` with `attempts` untouched,
   no stranded claim. First observed live in the pre-fix run where all 7
   records mismatched (macOS `/tmp` → `/private/tmp` realpath difference)
   and every record landed in pending with zero claim residue.
2. In the final run the 8th (deliberately mismatched) record also left no
   claim residue, but its final resting file was not captured in the
   sampler window — its exact final state (pending vs. GC'd) is an OPEN
   note; it does not affect any verdict above (no stranded live claim at
   any sampled instant nor at the end).
3. Very short-lived `-p` sessions (the first exploratory run): the
   background drain is cancelled at shutdown — records return to pending
   (attempts 0) with zero claim residue; retryable next session. Not a
   protocol violation.

## Reproduce

```bash
bash scripts/hq-drain-evidence.sh
```

Requires: `pi` on PATH, `~/.pi/agent/{auth,models}.json` present
(credentials stay inside the isolated copy), CPA provider reachable for
`CPA/model-fast`.
