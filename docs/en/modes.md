# modes — Permission Modes

> English. 中文版: [../zh/modes.md](../zh/modes.md)

**Directory**: `extensions/modes/` (~40 files, the largest module)
**Origin**: migrated from `@georgedong32/permission-modes` 2.8.0 (P1)

## What it does

Claude-Code-style permission modes for pi, cycled with Shift+Tab:

| Mode | Behavior |
|---|---|
| `ask` | Manual approval for edits, outside-cwd access, mutating bash |
| `plan` | Read-only; only `plan.md` may be written |
| `auto` | Tiered auto-approve + optional built-in classifier + risk blacklist |
| `bypass` | Full auto-approve (old auto semantics); sparse security reminders |

**codemode (pi 1.0)**: `plan` mode denies the `codemode` tool itself — it executes other tools. A codemode script's nested tool calls run through the full agent tool pipeline (`tool_call` gates, permission checks), so the mode rules above apply to them per tool; codemode is not a permission bypass.

### Plan-mode adjudication order (SPEC 2026-10-07 P0-1)

| Step | Check | Result |
|---|---|---|
| 1 | `evaluateToolPermission` → deny | block (`Denied by permission rule [...]`) |
| 2 | **plan hard limits** (`plan-gate.ts`) — unaffected by allow/ask rules | block, never prompts |
| 3 | verdict = ask (rule ask, or family first-seen) | prompt / subagent forward, **result honored** |
| 4 | verdict = allow (rule allow / session grant) | allow (only plan-legal calls remain) |
| 5 | passthrough | read tools, `tool_search`, plan file edits, read-only bash, unknown non-MCP tools: unchanged |

Consequences of the fixed order: an `allow` rule can no longer unlock
writes/mutating commands in plan (D2a); an `ask` verdict on a read tool
prompts and its Block is honored instead of being silently overridden (D1);
family-governed MCP calls stay usable in plan when their family adjudicates
allow (rule / session grant / first-seen approval — D2b), while MCP-shaped
calls with no family stay denied (D2c fail-closed). The hard limits live in
`plan-gate.ts#planHardBlock` (pure; the adapter collects path/family/env
facts).

Scan boundary: built-in `edit/write/bash/powershell/codemode` names
are never exempted; only calls that are BOTH MCP-shaped (lib/mcp-shape
authority) AND family-claimed skip the generic embedded-command scan — their
`command/run/cmd/then_run` are remote schema params, not local shell.

### Family first-seen without a UI (SPEC 2026-10-07 P3-1 S3, D6=B)

Headless sessions (and subagent children) still fail closed on an
unauthorized family first-seen call, but the block reason now carries the
family's own suggested allow rule verbatim plus a retry hint — e.g. for
`mcp__exa__search`: pre-approve by adding the rule ``mcp_exa_*`` to your
permission rules in a parent/interactive session, then retry. No grant is
written, no dialog is raised, and family first-seen never enters the
parent-forwarding protocol (D6 keeps forwarding limited to the regular ask
prompt path).

## Key surfaces

- **Commands**: `/mode`, `/permissions`, `/permissions-clear-grants`,
  `/plan-execute`, `/model-profile`, `/outside-writes`, `/undo-outside-writes`
  plus one command per mode name.
- **Status**: `modes` footer slot + `plan-todos` widget; publishes the
  `modes` channel (and `display.footer`) on the bus, plus the legacy
  `__piPermissionModes` / `__pmWorkingStats` keys.
- **Session entries**: `modes` type (contract-pinned, P0-CT-08).

## Internal map

| Area | Files | Notes |
|---|---|---|
| Permission engine | `permissions.ts`, `permission-rule-parser.ts`, `permissions-loader.ts`, `bash-permission-match.ts`, `path-permission-match.ts`, `shell-rule-matching.ts`, `dangerous-permissions.ts` | Rule parsing/loading/matching (Claude-Code-style `tool(content)` rules); loader merges user + project rule files |
| Rule families (seam) | `rule-families.ts` | `registerRuleFamily` — the extension point web-gov/mcp-gov use; session grants, adjudication cache, bypass state |
| Auto classifier | `classifier-client.ts`, `classifier-prompt.ts`, `classifier-prompts/`, `classifier-transcript.ts`, `classifier-tool*.ts`, `classifier-redact.ts`, `classifier-messages.ts` | Optional LLM classifier for auto mode; reads AGENTS.md context, redacts secrets, caches verdicts |
| Subagent integration | `permission-forwarding.ts`, `mode-inherit.ts` | Approval forwarding via `~/.pi/agent/sessions/permission-modes-forwarding/sessions/<id>/{requests,responses}` (P0-CT-05); `PERMISSION_MODES_INHERITED_MODE` inheritance (P0-CT-04) |
| Profiles | `profiles.ts` | Model profiles (`provider/model[:effort]` via `lib/model-id.ts`); `applyProfileModelForMode` returns undefined when unset — no silent medium default |
| Plan mode | `session-branch.ts`, `branch-stats.ts`, `fusion-tools.ts`, `injection-probe.ts`, `denial-tracking.ts`, `config.ts`, `config-cache.ts`, `plan.ts`, `plan-gate.ts` | Plan phase tracking, session branching, working stats; `plan-gate.ts` = the pure plan hard-limit block (P0-1) |
| Working stats | `working-stats.ts` | **AR1005-ST (2026-10-05)**: the streaming-stats cache — cheap key = sessionManager instance (WeakMap id) + sessionId + leafId (the LEGAL empty-branch null is cacheable; a missing/throwing getter is uncacheable, never "empty"). Key hit on message_update = ZERO getBranch/getContextUsage calls (measured: 0 across 200 updates at 1K/10K/50K branches; baseline made 200 getBranch calls — the reproduced 2M parent-map reads at 10K). Invalidation: reset on session_start/session_tree/session_shutdown; invalidate on session_compact; markDirty on message_end (fires before the host append — belt-and-suspenders with the leafId key, contract AR1005-ST-HOST pins the real-SessionManager leaf move); onModelChange on model_select; force on turn_start/turn_end (committed-final), forceUsage on before_provider_request (no unconditional branch re-sum). Old hosts without the cheap key keep the uncached read path (peer floor unchanged); failed reads are never cached as successful empty snapshots |
| Bash risk analysis | `bash-analysis.ts` | Tiered safe/destructive/auto-fallback/auto-approvable adjudication (carved from the old `utils.ts`, arch review C3) |
| Path safety & project identity | `path-safety.ts` | Outside-cwd/sensitive-path detection; project root/id/tmp-dir (carved from `utils.ts`) |
| Outside-write snapshots | `outside-writes.ts` | `<ts>__<hash>.json` track/list/restore/pop engine (carved from `utils.ts`; command layer in `index.ts`) |
| Mode prompt surgery | `mode-prompt.ts` | Anchored mode-reminder injection + skill-block filtering (carved from `utils.ts`) |
| Auto risk | `auto-risk.ts` | Bash category patterns + outside-cwd write risk for auto mode (carved from `utils.ts`) |
| UI | `ui/footer.ts`, `ui/meta.ts`, `ui/confirm.ts`, `ui/plan-widget.ts`, `ui/plan-approval-dialog.ts` | `MODE_META` single-sources icon/label/role (bus `meta` channel) |

## Invariants & gotchas

- Session grants / adjudication live in `rule-families.ts` — families must go
  through it, not keep their own grant state.
- The effort side-effect of mode profiles goes through `lib/effort-owner.ts`
  (never `pi.setThinkingLevel` directly).
- `PERMISSION_MODES_INHERITED_MODE` is consumed here, produced by
  pi-subagents — do not write it from core.
- Legacy key writes (`writeLegacyAliases`) happen in the same synchronous
  batch as the bus publish.

## Tests

Colocated vitest suites (`*.test.ts`, ~5 000 lines) — the only module with
colocated tests; `bun run test` picks the directory up directly.
