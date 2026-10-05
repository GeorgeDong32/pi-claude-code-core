# review — Fan-out Code Review

> English. 中文版: [../zh/review.md](../zh/review.md)

**Directory**: `extensions/review/`
**Origin**: merged from `@georgedong32/pi-review` 0.8.6 (P2)

## What it does

A three-step fan-out code review pipeline:

1. `/review` resolves the target (branch/PR/diff), prepares the diff + target
   repo checkout, and writes `.pi/pi-review/runs/<runId>/manifest.json`.
2. A hidden directive tells the main agent to call `subagent({...})` once
   with a generated workflow script. The script fans out reviewer subagents
   via `runs.all([...])` and feeds their `structuredOutput` objects into
   `runs.run("gate")`. Every child passes `cwd` and `outputSchema`.
3. The main agent calls the **`pi_review_report`** tool with the workflow
   return value. The tool re-validates outputs, enforces the verdict in code,
   persists a session entry, and renders deterministic markdown.

No project-level permission files are written — diff/clone/fetch go through
the extension's own `pi.exec`; reviewer children need only read/grep and a
few read-only git commands.

## Key surfaces

- **Commands**: `/review`, `/review-config`, `/review-agents`, `/review-show`.
- **Tool**: `pi_review_report` (registered by `src/tool-wrapper.ts`).
- **Reviewer personas** (`agents/*.md`): `bugbot`, `code-comments`,
  `conventions`, `gate`, `history-context`, `lite-review`, `rulesheriff`,
  `security-review` — registered as subagent definitions via the `pi.subagents`
  manifest field.
- **Config**: `.pi/pi-review.json` (disk layout frozen, P0-CT-09); model
  resolution via `lib/model-id.ts`.
- **Bus**: `review` channel — `{ status: "idle" | "running" | "done", lastRunAt }`.
- **Session entry**: `pi-review` / `pi-review-directive` types (P0-CT-08).

## Internal map

| File | Notes |
|---|---|
| `index.ts` | Assembly: commands, report tool, TUI renderer |
| `src/review-run.ts` | `prepareRun`: target resolution, diff prep, manifest. **AR1005-RV (2026-10-05)**: rule discovery (`discoverRulePathsLocal`) runs AFTER the workspace retries/HEAD checks settle, against the FINAL `workspacePath` — the TARGET repo owns which rules apply (its AGENTS.md / .pi/rules), while config loading, run artifacts and manifest/diff/workflow writes stay anchored on the CALLER's cwd. manifest.rulePaths, ChangeProfile.rulePaths, rulesheriff routing and the directive consume the ONE prepared value; the frozen relative-path array shape is unchanged. Baseline defect: a caller with no rules reviewing a target WITH rules got `rulePaths: []` and silently skipped rulesheriff |
| `src/directive.ts` | Hidden directive text (workflow-script contract) |
| `src/workflow-schemas.ts` | Reviewer/gate output schemas |
| `src/gate-enforce.ts` | Verdict enforcement in code (report tool side) |
| `src/report.ts`, `review-report.ts` | Deterministic markdown rendering |
| `src/tool-wrapper.ts` | `pi_review_report` registration/validation |
| `src/config.ts` | Config load/merge/validate/write |
| `src/cli-args.ts`, `pr-ref.ts`, `target-workspace.ts` | Argument parsing, PR refs, checkout |
| `src/lean-agents.ts` | Lean reviewer selection |
| `src/tui-renderer.ts` | In-TUI run status |
| `reference/` | Reference material for reviewers |

## Invariants & gotchas

- The verdict is enforced **in code** (`gate-enforce` + report tool), not
  left to model discretion.
- Runs are append-only under `.pi/pi-review/runs/<runId>/` — never mutate a
  past run's artifacts.
- Reviewer children are read-only; do not grant them write tools in the
  workflow script.

## Tests

`extensions/review/tests/` — node:test via tsx (11 suites incl.
`workflow-contract.test.ts` pinning the workflow-script shape).
