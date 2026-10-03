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
| Plan mode | `session-branch.ts`, `branch-stats.ts`, `fusion-tools.ts`, `injection-probe.ts`, `denial-tracking.ts`, `config.ts`, `config-cache.ts`, `plan.ts` | Plan phase tracking, session branching, working stats |
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
