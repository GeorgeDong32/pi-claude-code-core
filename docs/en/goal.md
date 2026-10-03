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
| `goal.ts` | Main assembly: tools, commands, widget, stop-hook continuation loop. Usage accounting sums ALL FOUR token channels (`input`/`output`/`cacheRead`/`cacheWrite` — cache-inclusive, DEVIATIONS #69) |
| `goal-core.ts` | Rendering/status helpers (footer status, duration/token formatting, one-line summary) |
| `renderers.ts` | Message renderers (result / event / audit-event) — carved from the wiring (arch review C6), testable without the factory |
| `goal-record.ts`, `goal-pool.ts`, `goal-ledger.ts` | State model: active/paused records, open-goal pool, usage ledger |
| `goal-policy.ts` | What tools are allowed in which goal status (`ACTIVE_GOAL_TOOL_NAMES`, `POST_STOP_ALLOWED_TOOLS`, …) |
| `goal-draft.ts`, `goal-questionnaire.ts` | /goals-style intent discussion → `propose_goal_draft` → Confirm/Continue dialog |
| `goal-auditor.ts` | Independent completion auditor; its approval gates `update_goal(status=complete)` |
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
