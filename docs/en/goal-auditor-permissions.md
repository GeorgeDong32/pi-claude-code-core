# Goal Auditor — Permission Status (G3-C17, 2026-10-19)

> Entropy-control spec [C17] record ([中文版](../zh/goal-auditor-permissions.md)).
> Answers the plan's open question 1: do permission-modes rules apply inside the auditor session?

## Status (verifiable at file:line)

- **The auditor session loads ZERO extensions**: `extensions/goal/goal-auditor.ts:214`
  `getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() })`.
- permission-modes IS an extension (this package's `extensions/modes/`): its
  allow/deny/ask rules, tool_call gate, and rule families all load through the
  extension system — the auditor does not load it ⇒ **permission-modes rules do
  NOT apply in the auditor session** (the plan's inference, now verified).
- The auditor's bash boundary is currently **prompt self-discipline only**
  (goal-auditor.ts prompt: stay inside the project dir, never scan the home
  dir, no long-running foreground processes, no destructive commands).

## Residual risk

- The auditor holds **unruly bash**: no hard gate behind the prompt. It has
  historically `find`-scanned the entire home directory and hung on an
  OneDrive CloudStorage mount (mitigated by prompt constraints + a fix — but
  the constraint is soft).

## Why the read-only profile is deferred

- The auditor's job includes **re-running tests** — tests write tmp, run
  builds. A pure read-only profile would leave it unable to verify anything,
  degrading audit quality.
- A correct design (allow read + an allowlisted bash + tmp writes) extends
  permission-modes' profile semantics, whose rule model today has no
  Write/Edit path patterns (verified in the arch-review batch, DEVIATIONS
  #122) — the engineering cost does not match the benefit. Deferred.

## Revival conditions

- Another prompt-escape incident in the auditor (home scans, destructive
  ops), or permission-modes gaining path-pattern rules (then design the
  read-only allowlist profile together).
