# bg-shell — Background Shell Tasks

> English. 中文版: [../zh/bg-shell.md](../zh/bg-shell.md)

**Directory**: `extensions/bg-shell/`
**Origin**: vendored from `gvanderclay/pi-bg-bash` v0.2.1 (MIT), Copyright (c) 2026 Gage Vander Clay — adapted for core (BG-D1)

## What it does

Gives the model's `bash` tool a `background: true` flag (plus `waitFor`).
A background call spawns the command detached in its own process group,
appends stdout+stderr to a session log, and returns a task id at once:

```
~/.pi/agent/cc-core/logs/bg-shell/<sessionId>/bg-<n>.log   (0700, owner.pid marker)
                                                          (.log.gz after completion)
```

When the command exits, the agent receives **one completion message**
(customType `cc-core-bg-shell`, `deliverAs: "followUp"`, `triggerTurn: true`,
`display: false`) carrying exit status, runtime and a pointer to the output — never the
output itself (CC `<task_notification>` parity: the notification has a
summary only, so the agent reads the output with `TaskOutput` and the read
renders as a tool-call row in the TUI) — it starts a turn if the agent is
idle, so the model never sleeps-and-polls. The notification is agent-side only (CC
`task_notification` parity): the TUI renders no `[cc-core-bg-shell]` block.
The user-visible face is the status row (BG-ENTRY-03): every completion
and every user kill appends a display-only session entry (`pi.appendEntry`
— not sent to the LLM). CH E5: stopping a task that had already ended
appends its REAL end state and exitCode at most once — never a `killed`
row unless a kill actually ended it, and nothing at all when the row was
already appended. Rendering belongs to pi-claude-code-tui
(`lib/bg-task-row.ts`): a `⏺ Background Task(bg-N)` pseudo tool row with a
state-colored dot plus a `⎿` detail gutter, visually paired with the
`TaskOutput` rows the agent emits next (CC `task_status` parity; replayed
on resume). core registers no renderer on purpose — first-wins lookup
would permanently shadow the TUI's.
A watcher process (outside the task's group) kills the group if pi dies.

## Tool surface (CC-parity names, BG-D3)

| Tool | Purpose |
|---|---|
| `bash` (overridden) | adds `background` / `waitFor` / `description` (a short human label, CC parity — shown with the id everywhere tasks are listed); without them it is pi's own bash over the same wrapper |
| `TaskOutput` | incremental read from the task's read position; `latest`, `filter` regex; optional `block: true` waits for the task to end first — up to `timeout` seconds (above 0, default 30, maximum 600, out-of-range values throw), a user message ends the wait early with the output so far |
| `TaskStop` | SIGTERM to the process group → grace → SIGKILL; no completion message follows |
| `TaskList` | one line per task: id, state, runtime, command |

When the agent reads a finished task through `TaskOutput`, the read claims
the notification (CC `markTaskNotified` parity): the tool result already
carries the output and the exit state, so no redundant completion message
follows — otherwise it would queue behind the very turn that did the reading.
Since E4 (SPEC SR, 2026-11-15) the claim runs through the registry's
`claimCompletion`, so it reports the end the way every other completion does
minus the message: the status row is appended (BG-ENTRY-03) and the log is
gzipped once the process group is gone — a read landing between the exit and
the next poll tick no longer leaves the task unreported. A blocking
`TaskOutput` (`block: true`) holds its task (`waiting` counter) while it
waits, so neither the poller nor a kill path can send the completion
underneath it — the waiter claims it; a wait aborted before claiming leaves
`notified` false, and the next poll tick reports normally.

`/tasks` opens the management panel (TUI: enter = output view, x = kill after
confirm, q/esc closes, 1 s refresh; RPC degrades to `ui.select`; no-UI prints
the list). `ctrl+shift+b` promotes the running foreground call(s); a foreground
call outlasting 120 s (unless `sleep`) promotes itself. An explicit `timeout`
no longer disables that auto-promotion (BH-R4, D-BH-2 — never guess units:
models pass milliseconds as seconds, so the 120 s safety net must stay
armed): the call still promotes at 120 s and the timeout becomes the promoted
task's deadline, exactly as for `background: true`; a timeout shorter than
the threshold still hard-caps the foreground run.

## Hardening (inherited from upstream, kept intact)

- exit markers carry a per-task nonce — output cannot forge them (sanitize
  strips markers from everything the model sees)
- 100 MiB log cap → kill + `__CC_BG_LIMIT__` marker; gzip only after the
  completion message is out
- `session_shutdown(reason === "reload")` keeps tasks, every other end kills them
- resume: ids skip any `bg-<n>` whose log/`.log.gz` already exists, and
  `session_start` seeds the counter past the ids the session's status
  entries recorded (CH E6) — pruned logs no longer reset numbering to `bg-1`
- CH E2: the `"…" never appeared` note is a promotion-path-only message;
  the normal-exit and error paths no longer append it (models passing
  placeholder `waitFor` values drowned the agent in it), and the `waitFor`
  schema description tells the model to omit the parameter when not waiting

## Held follow-ups while the agent is busy (cc-core addition, 2026-11-24)

A `followUp` is only delivered once the current run settles, and in 30 days
of session logs the model often read the result itself meanwhile
(`TaskOutput`), so the queued message woke it for nothing — an extra turn and
a second `TaskOutput` row. Now `notifyOnce` still appends the status row the
moment the poller sees the exit, but HOLDS the message while
`registry.agentBusy` (`agent_start` … `agent_settled`); `agent_settled`
(`flushHeld`) sends it unless the model already read the end
(`task.read`, set by `claimCompletion`), in which case it is dropped. Idle
behaviour is byte-for-byte the old one (send on the poller tick). A held send
that throws stays held for the next settle; `endSession` drops everything
held. Tests: `tests/held-followup.test.ts`.

## Check-pipeline exit guard (cc-core addition, 2026-11-24)

`pipefail.ts`: the model writes `pnpm test 2>&1 | tail -25` more often than
not (55.6% of test/build/check command segments in 30 days of session logs),
and the status the tool then reports is tail's — a red run reads as success.
When `needsPipefail(command)` is true, `launch()` runs that invocation's shell
with `-o pipefail` (`pipefailArgs`, bash/zsh only — dash `sh` rejects the
option), so the `__CC_BG_EXIT__` marker carries the pipeline's status.

Scoped on purpose: only a check-like command (`pnpm/npm/yarn/bun/npx
test|check|lint|build|…`, `vitest`, `tsc`, `cargo/go test`, `pytest`, `make`,
`just`, `./gradlew`, `dotnet test|build`) as the upstream of a real pipe
(`|`/`|&`, never `||`, quotes stripped); pipelines ending in `grep -q` /
`rg -q` / `grep -c` are skipped (the model reads grep's status there); a
command that already mentions `pipefail` is left alone. The flag applies to
the whole invocation, so other pipelines in the same command also become
truthful — intended. `CC_CORE_BG_DEBUG` logs a `pipefail` event per guarded
launch. Tests: `tests/pipefail.test.ts` (detection on real log shapes, argv
per shell, one real launch proving marker 127 vs 0).

## Environment (test seams, not user config)

`CC_CORE_BG_DEBUG=1` (JSONL debug log), `CC_CORE_BG_PROMOTE_MS`,
`CC_CORE_BG_GRACE_MS`, `CC_CORE_BG_LOG_LIMIT_BYTES`.

## Contracts

`BG-DISK-01` (log layout, cc-core unified logs root) and `BG-MSG-02`
(completion customType) — see `test/contracts/README.md`.

## Known deviations from CC

CC's `/tasks` also lists agent/teammate/workflow tasks and offers `f`
(reattach to foreground). We manage shell tasks only and pi has no turn
reattach — both are deliberate scope cuts (DEVIATIONS).

CC's `TaskOutput` blocks by default and takes its `timeout` in milliseconds.
Core's `block` defaults to false (the notification already wakes an idle
agent, so a plain read stays the common case) and `timeout` is in seconds —
above 0 and finite, default 30, maximum 600; an out-of-range value throws
(`timeout is in seconds (not ms); must be a finite number above 0`, or
`timeout is in seconds (not ms); maximum is 600` past the cap) instead of
being clamped, and `timeout` without `block: true` throws too (E4, D-SR-3;
SR-1b).

## Known deviations from upstream pi-bg-bash

Upstream 0.5.0+ removed timer-based auto-promotion entirely (only `waitFor`
matches or the user shortcut promote now). Core keeps auto-promotion and, since
BH-R4, extends it to calls with an explicit `timeout` (which becomes the
promoted task's deadline) — a deliberate vendored deviation (D-BH-2; DEVIATIONS).
Upstream has no blocking `TaskOutput` at all: `block`/`timeout` and the
claim-on-read report (status row + gzip) are core additions (E4, SPEC SR).
