# Recall frequency tuning (B) — Spec

Status: draft for adversarial review (flash, 1 round) · Batch: 2026-10-20 ·
Module: `extensions/memory/recall.ts`, `extensions/memory/index.ts`

## 1. Background (session corpus, 2026-10-20)

- Delivery frequency: **one block per 2.72 user turns on average** (core
  project 2.56 / home 2.98); worst short sessions run **1:1** (6 turns →
  6 blocks); several 3–4-turn sessions sit at 1.3–1.5.
- Per-block cost: selector **p50 3.0 s** + **~4 KB** injected (p50 3951 B,
  p90 7421 B).
- Health facts that shape the fix: immediate hit rate is only 3.3%; the
  delivered block lands a median **5 turns** after its trigger. "Recalled
  a few turns late" is already the norm, so trimming frequency has small
  marginal cost.
- The dedup window works (0 same-key leaks while alive) — the problem is
  the **zero-threshold trigger**: every user message runs the selector.

## 2. Design

Two thresholds at the recall machine's entry
(`createRecall(...).onUserMessage`), both read per check from the env
(`PI_CORE_RECALL_WARMUP_TURNS` / `PI_CORE_RECALL_COOLDOWN_TURNS`;
**≤ 0 disables the gate**, non-numeric falls back to the default) —
the same test-seam pattern as `CC_CORE_BG_PROMOTE_MS`:

```ts
export const RECALL_WARMUP_TURNS = 3;   // first N user turns: no selector
export const RECALL_COOLDOWN_TURNS = 2; // min turns between selector runs
```

State inside the machine:

```ts
let userTurns = deps.initialUserTurns;  // seeded (see resume below)
let turnsSinceRun = Infinity;           // increments per turn without a
                                        // selector run; 0 after a run;
                                        // eligible at >= cooldown
```

`onUserMessage` order (before any hygiene/dedup work — skip early, skip
cheap). One uniform counter rule (review R1 P1-1/P1-2): **every turn that
does not actually run the selector increments `turnsSinceRun`; a turn
that runs it resets to 0.**

1. `userTurns += 1`
2. If `userTurns <= RECALL_WARMUP_TURNS` → `turnsSinceRun += 1`; return
   null, `stats.lastReason = "warmup"`.
3. If `turnsSinceRun < RECALL_COOLDOWN_TURNS` → `turnsSinceRun += 1`;
   return null, `stats.lastReason = "cooldown"`.
4. Else run the existing pipeline. If the selector actually ran
   (the single decision point is where the selection promise is
   constructed) → `turnsSinceRun = 0`. If the pipeline exits early for
   any other reason (query null, bytes over cap, eligible() empty) →
   `turnsSinceRun += 1` — a suppressed turn does NOT reset the cooldown
   and does not gate the next turn (still eligible next turn).

**Resume continuity**: the machine is rebuilt per session lifecycle, so a
plain counter would reset to 0 and starve a resumed conversation of
memory for 3 turns. Seed instead (review R1 P2-3 — the timing fact that
makes this exact): `ensureRecallMachine` passes `initialUserTurns` =
number of **role === "user" messages in `ctx.sessionManager`'s branch**
at machine creation. `before_agent_start` fires BEFORE the in-flight
user message is constructed or persisted (agent-session.js:
emitBeforeAgentStart precedes the appendMessage on message_end), so the
branch count never includes the message being processed — no off-by-one.
Implementations MUST count from the sessionManager branch, not from
`agent.state.messages` (which already contains the in-flight message).
A resumed session with ≥3 historical user turns is instantly eligible;
counter semantics are "user turns in this conversation", not "turns since
this process started". Sessions continued after compaction keep counting
(the compaction boundary does not reset user turn count).

## 3. Threshold rationale & expected effect

- **Warmup 3**: the shortest sessions (≤4 turns, the 1:1 cases) are
  task-in/task-out — the opening context is fresh; blocks delivered there
  are both unlikely to hit (3.3% immediate) and expensive (3 s each).
  Warmup-3 eliminates the worst quartile of frequency without touching
  long sessions.
- **Cooldown 2**: turns a legitimate recall needs to "catch up" are
  already the norm (median landing 5 turns out). Cooldown-2 halves
  steady-state selector load on long sessions (1.8–2.7 turns/block →
  ~3–4 turns/block upper-bounded by the cooldown).
- Combined expected: ≥50% fewer selector runs corpus-wide; zero change to
  block content when a run does happen (same selector, same budget).
- Thresholds are deliberately conservative: the user direction was
  "frequency is too high", not "recall less often than every few
  screens".

## 4. Observability

- `stats.lastReason` gains `"warmup"` / `"cooldown"` — surfaced through
  the existing `RecallStats` and the diagnostics path (no details-v1
  schema change; P0-CT-08 frozen surface untouched).
- `scripts/recall-aggregate.mjs` keeps working unchanged: blocks simply
  appear sparser; the landing-position section is unaffected.

## 5. Test matrix (vitest, `test/lib/`)

| # | Case | Assert |
|---|---|---|
| 1 | fresh session, 3 first turns | no selector call; lastReason "warmup" |
| 2 | 4th turn | selector runs (warmup passed) |
| 3 | run at turn 4; turns 5–6 | both skipped "cooldown" (counter 1, 2); turn 7 eligible (interval = cooldown + 1 = 3) |
| 4 | machine seeded with initialUserTurns=7 (resume) | first turn runs selector immediately |
| 5 | seeded=2 (short resume) | first turn is warmup turn 3; second turn runs |
| 6 | pipeline early-exit (eligible() empty) at an eligible turn N | counter +1 (not reset); turn N+1 is still eligible and runs |
| 7 | abort() mid-warmup | counter preserved (abort clears request state, not turn counters) |
| 8 | aggregate script smoke on a synthetic jsonl with new reasons | parses; counts unchanged in shape |
| 9 | steer path (waitMs=0) shares the machine | warmup/cooldown counters shared with the normal path — a steer during cooldown still skips |
| 10 | machine rebuilt mid-session (settings change) | warmup seed re-derived from the branch (no warmup replay); the cooldown clock restarts — rebuilds are rare and the first post-rebuild turn is eligible immediately |

## 6. Non-goals

- No evaluation-set / quality-scoring work (separate decision).
- No changes to selection content, budget, or delivery mechanics.
- No cross-turn repetition detection (different problem domain).
