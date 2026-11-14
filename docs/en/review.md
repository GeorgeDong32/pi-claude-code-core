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
- The local base fetch (`git fetch origin <base>` in `acquireLocalDiff`) is
  best-effort with a hard 15s ceiling (`LOCAL_BASE_FETCH_TIMEOUT_MS`,
  D-FX-1) and `GIT_TERMINAL_PROMPT=0` — a timed-out or failed fetch falls
  back to the local `origin/<base>` ref and records a non-fatal
  `diffWarning` ("timed out" vs "failed" text). Not configurable; PR-path
  commands (`gh pr view/diff`, clone, PR-head fetch) are untouched.
- **PR dry run (`/review --no-spawn <PR>`, R12/D-CH-3)**: metadata only —
  `gh pr view` + `gh pr diff` run; `prepareWorkspace` never does (no clone,
  no fetch). The summary prints `workspace: not cloned (dry run)` and marks
  rules/history `not computed (dry run)`. A dry run still writes its run
  dir (manifest + diff); the 24h pruner reclaims it. Local targets are
  unchanged.
- **Bus reconciliation (R11/D-CH-2)**: `review.status` reconciles at three
  points — `agent_end` (a live run whose turn ended without a report resets
  to idle; armed only after the running publish + an `agent_start`, so a
  queued directive is never clobbered), `session_start` (stale running from
  a previous session), and a new `/review` invocation (residual running
  with no live run tracked). Only the three existing statuses.
- **Timeouts (`run-cmd.ts`, T1–T3)**: expiry escalates SIGTERM → SIGKILL
  after `RUN_CMD_KILL_GRACE_MS` (2s); a dead child whose pipes are held by
  a grandchild gets a brief drain (`RUN_CMD_PIPE_DRAIN_MS`) then a stdio
  destroy so the call resolves bounded; a timer firing after the child
  already exited resolves with the REAL exit code (not a timeout);
  `timeoutMs <= 0` or non-finite means NO timeout (Node convention).
  Timed-out results carry the structured `timedOut: true` on `CmdResult`
  (T4/S5) — the stderr note stays for humans.
- Untracked files over `UNTRACKED_FILE_MAX_BYTES` (1 MB, R3) get a
  size-only placeholder hunk (content never read) and a counted note in
  `diffWarning`; the failed-retry-fetch branch of the PR HEAD guard is a
  hard error (R2), not a silent pass.
- The generated workflow script emits reviewer prompt lines shared across
  reviewers ONCE (E12: `baseTask` / `diffOnlyExtra` / `userTask` consts);
  each reviewer's runtime prompt is byte-identical to the pre-dedup form
  (pinned by `tests/workflow-task-golden.json`), and the whole directive is
  capped by `REVIEW_DIRECTIVE_MAX_CHARS`.

## Tests

`extensions/review/tests/` — node:test via tsx (12 suites incl.
`workflow-contract.test.ts` pinning the workflow-script shape and
`run-cmd.test.ts` pinning the D-FX-1 timeout/env adapter opts).
