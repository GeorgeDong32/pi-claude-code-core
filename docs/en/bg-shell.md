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
The user-visible face is the status row (`status-entry.ts`, BG-ENTRY-03):
every completion and every user kill appends a display-only session entry
(`pi.appendEntry` — not sent to the LLM) that renders inline as
`⏺ Task "cmd" completed in background` in dim (CC `task_status`
attachment parity), shown before the agent's response and replayed on
resume.
A watcher process (outside the task's group) kills the group if pi dies.

## Tool surface (CC-parity names, BG-D3)

| Tool | Purpose |
|---|---|
| `bash` (overridden) | adds `background` / `waitFor`; without them it is pi's own bash over the same wrapper |
| `TaskOutput` | incremental read from the task's read position; `latest`, `filter` regex |
| `TaskStop` | SIGTERM to the process group → grace → SIGKILL; no completion message follows |
| `TaskList` | one line per task: id, state, runtime, command |

When the agent reads a finished task through `TaskOutput`, the read claims
the notification (CC `markTaskNotified` parity): the tool result already
carries the output and the exit state, so no redundant completion message
follows — otherwise it would queue behind the very turn that did the reading.

`/tasks` opens the management panel (TUI: enter = output view, x = kill after
confirm, q/esc closes, 1 s refresh; RPC degrades to `ui.select`; no-UI prints
the list). `ctrl+shift+b` promotes the running foreground call(s); a foreground
call outlasting 120 s (unless `sleep`) promotes itself.

## Hardening (inherited from upstream, kept intact)

- exit markers carry a per-task nonce — output cannot forge them (sanitize
  strips markers from everything the model sees)
- 100 MiB log cap → kill + `__CC_BG_LIMIT__` marker; gzip only after the
  completion message is out
- `session_shutdown(reason === "reload")` keeps tasks, every other end kills them
- resume: ids skip any `bg-<n>` whose log/`.log.gz` already exists

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
