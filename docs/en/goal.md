# goal — Goal Lifecycle + Sisyphus Loop

> English. 中文版: [../zh/goal.md](../zh/goal.md)

**Directory**: `extensions/goal/`
**Origin**: forked from capyup/pi-goal `0.6.0` @ `ec2bcbe` (P2; provenance and
diff whitelist in [FORK.md](../../extensions/goal/FORK.md))

## What it does

Gives the agent a durable goal contract: discussion-based creation with user
confirmation, focused execution with continuation prompts, pause/resume with
structured blocker reports, an independent completion auditor, and a
**sisyphus mode** that keeps sending continuation prompts until the objective
is audited complete.

## Key surfaces

- **Commands**: `/goal`, `/goals`, `/sisyphus` (intent entry), `/goal-status`,
  `/goal-list`, `/goal-focus`, `/goal-settings`, `/goals-set`,
  `/sisyphus-set`, `/goal-tweak`, `/goal-clear`, `/goal-abort`,
  `/goal-pause`, `/goal-resume`.
- **Tools**: `propose_goal_draft`, `create_goal`, `goal_question`,
  `goal_questionnaire`, `get_goal`, `update_goal`, `pause_goal`,
  `abort_goal`, `step_complete`, `apply_goal_tweak` (names in
  `goal-tool-names.ts`; the active-tool set varies with goal status).
- **Widget/status**: `goal` widget + `goal` status slot (contract P0-CT-07/08);
  `goal` channel on the bus (objective, status, sisyphus flag, token/time
  usage).
- **Disk**: `<cwd>/.pi/goals/` — state, ledger, archive (layout frozen,
  P0-CT-09; see `storage/goal-files.ts`).
- **Env**: `PI_GOAL_AUTO_CONFIRM` auto-confirms proposals.

## Internal map

| File | Notes |
|---|---|
| `goal.ts` | Main assembly: tools, commands, widget, stop-hook continuation loop. The in-turn stop lock is set ONLY by the four real stop tools' successful execute (`pause_goal` / `abort_goal` / `update_goal=complete` / `apply_goal_tweak`, D3=A spec 2026-10-07 P0-2); every other tool call is progress-neutral — allowed, no progress credit, no lock (progress exceptions read the host's real `event.input` field). Usage accounting sums ALL FOUR token channels (`input`/`output`/`cacheRead`/`cacheWrite` — cache-inclusive, DEVIATIONS #69) plus the provider-reported USD cost (`usage.cost.total`). `tool_result` events carrying execution usage (subagent runs, codemode `models.classify`/`generateImages`) are accounted too — a goal's ledger therefore includes delegated model spend, not just the parent thread |
| `goal-core.ts` | Rendering/status helpers (footer status, duration/token formatting, one-line summary) |
| `renderers.ts` | Message renderers (result / event / audit-event) — carved from the wiring (arch review C6), testable without the factory |
| `goal-record.ts`, `goal-pool.ts`, `goal-ledger.ts` | State model: active/paused records, open-goal pool, usage ledger |
| `goal-policy.ts` | What tools are allowed in which goal status (`ACTIVE_GOAL_TOOL_NAMES`, `POST_STOP_ALLOWED_TOOLS`, …) |
| `goal-draft.ts`, `goal-questionnaire.ts` | /goals-style intent discussion → `propose_goal_draft` → Confirm/Continue dialog |
| `goal-auditor.ts` | Independent completion auditor; its approval gates `update_goal(status=complete)`. AR1005-AU-02: the session's entire remaining lifecycle is try/finally-covered from the moment creation resolves — cancel-during-creation skips the prompt and disposes once; subscribe/prompt/unsubscribe failures all still dispose; a late completion after timeout/abort can only clean up (never approves). `sessionAdapter` is the internal test seam (controlled adapter vs the real `createAgentSession`) |
| `goal-audit-flow.ts` | Completion-audit orchestration (B7 step 2): config resolution, started/rejected/passed event trio, ledger writes, bounded-wait envelope. AR1005-AU-01: internal-cancellation result established FIRST, external signal connected then checked for pre-abort (a pre-aborted call never invokes the auditor and returns the existing rejected outcome); timer + both listeners released on every exit path |
| `goal-accounting.ts` | **The activity clock (AR1005-GO-A)**: owns the current goal, the activity-segment start and each unfinished goal's millisecond remainder. `settle` returns floor((elapsed+carry)/1000) whole seconds and KEEPS the remainder (the old floor-then-reset lost sub-second fragments on every event — 8 × 250 ms tool ends recorded 0 s of a real 2 s); `preview` is a side-effect-free display read; `pause` drops the segment but keeps per-goal carries (drafting/pause/focus switches); `forget` releases a completed/cleared goal's carry. Carries never cross goals; disk records stay integer `activeSeconds` (frozen format — a restart loses at most the current segment's sub-second remainder, never per-event loss again). Injectable clock seam (tests pass a fixed clock; production uses a monotonic clock; wall-clock timestamps stay with `nowIso`). **GO-B (same-event read convergence)**: `accountProgress` owns a per-event read context — ONE disk snapshot per synchronous event segment, shared by the pool reconcile AND the persist prompt-merge (the focused file is parsed exactly once per event; measured N parses at N goals, baseline N+1). The context never survives an await or crosses events — the next event re-reads and observes external objective/status/autoContinue edits and deletions; the zero-usage early return stays AFTER the reconcile so external cancel/delete detection never skips. Commands, persists without the context, state transitions and post-await paths keep fresh reads; `writeActiveGoalFile` safety (path/symlink checks, atomic write) untouched |
| `goal-compaction.ts` | Keep the goal context within budget across long runs |
| `goal-questionnaire.ts` | Structured interview tools for ambiguous intents |
| `storage/goal-files.ts` | `.pi/goals/` disk layout |
| `prompts/goal-prompts.ts` | Prompt templates |
| `widgets/` | Goal widget + notifications |
| `FORK.md` | Fork provenance: upstream baseline, diff whitelist, license note |

## Invariants & gotchas

- Subagent child sessions (`PI_SUBAGENT_CHILD`) never adopt disk goals or arm continuations (goal-hijack fix, GH-02/03).
- The completion auditor is authoritative: completion is only archived when
  its report approves; do not bypass it on `update_goal`.
- Pause is the structured way out of blockers; abort only for
  user-requested/obsolete/impossible goals.
- Upstream fork files must keep their provenance notes — check `FORK.md`
  before rewriting forked logic.

## Tests

`extensions/goal/tests/` — node:test via tsx (16 suites: statemachine,
policy, ledger, record, pool, draft, questionnaire, auditor, compaction,
files, prompts, widget, notifications, tool-names, event-render, core).
