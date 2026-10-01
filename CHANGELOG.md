# Changelog

## Unreleased

### Fixed (goal-hijack, spec 2026-10-01-goal-hijack-fix)
- **Subagent spawns no longer fail while a goal is active**: the goal module used to adopt the project's on-disk active goal in subagent child sessions (same cwd) and arm its continuation — the `<pi_goal_continuation>` checkpoint occupied the child's agent loop before the dispatched task prompt could be delivered, so every subagent dispatch in the project failed with "Agent is already processing a prompt". Child sessions (`PI_SUBAGENT_CHILD=1`) now skip disk-goal adoption entirely and never arm continuations (belt and braces); parent-session behavior is unchanged (red-green pinned).
- Test harness: `FakeHost.makeCtx` gained `idle` / `hasPendingMessages` options (the missing `hasPendingMessages` made the goal continuation path silently no-op in fakes — pre-existing fidelity gap).


### Fixed (memory recall, spec 2026-10-01-memory-recall-fix v3.1)
- **Per-turn pin & re-project**: memory recall now selects once per user turn and re-projects the byte-identical block for every provider request in the turn — previously it re-selected per request (selection drifted on tool output) and re-billed the session budget every request until recall went permanently silent at the 60KB cap.
- **Two-domain matching**: a memory qualifies via title+description overlap (≥2 tokens) or the tiered fallback (≥1 primary + ≥2 body hits); body-only overlap no longer turns every large file into a universal match (the "npm-publishing recalled during goal-dialog work" noise class).
- **Billing-only dedup**: each file is charged to the session budget once per session; surfaced files stay re-projectable across turns. Read files remain excluded until compaction.
- **Cache discipline (MR-09)**: injections are tail-appended only (never mid-history, never in the system prompt) and byte-stable within a turn; the system-prompt memory index is byte-stable while the memory dir is unchanged.
- Test hermeticity: `mode-inherit` "ignores invalid modes" now clears ambient `PERMISSION_MODES_INHERITED_MODE` (pre-existing leak when running the suite inside a pi session).


### Fixed (goal dialog height management, SPEC 2026-10-01)
- **goal**: the questionnaire / draft-confirmation dialog now manages its own height instead of overflowing the terminal — pinned header (separator, tab bar, question), scrollable context body (`ctrl+u`/`ctrl+d` half page, `PageUp`/`PageDown` full page, offset clamped), pinned footer with a ≤7-row option window and `(+N more)` hint. Works in both fullscreen and non-fullscreen tui modes, so options are always visible on long goal drafts. The selected option row gets a `selectedBg` highlight (❯ marker); short dialogs render byte-identical to before apart from that highlight. Layout math lives in `extensions/goal/questionnaire-layout.ts` (pure, table-tested).

## 0.2.0 (2026-09-30)

### Added (SoL-Pi conservative pair absorbed, SPEC 2026-09-29)
- **observation-pack module** (ported from NVlabs/SoL-Pi, MIT): pure-text tool results over 10KiB are sent in full twice, then the provider projection replaces them with a 1KiB complete-line placeholder; originals live in `<sessionDir>/observation-pack/<sessionId>/` and page back via `obs_recall` (paging header in the model-visible text). Per-message fail-open; request-level sentinel warns when the projection stops taking effect; cumulative `ObservationPatch` on the capability bus.
- **action-fusion module**: `write`/`edit` gain an optional `then_run.command` — the built-in bash runs it inside the same result (marker semantics kept exactly; the mutation-failure and nonzero-exit shapes both route to `[then_run:failed]`/`skipped`), serialized by the ported per-file queue (the official `withFileMutationQueue` cannot be the outer layer — it re-enters against the built-in tools' own queue and deadlocks, sandbox-proven). Dual-channel guidance; renderers pass through; `FusionPatch` on the bus.
- **`lib/pi-compat.ts`**: version gate + capability probes (tool factories, mutation queue, VERSION); degradation never blocks the session.
- **`lib/core-economy.ts`**: `~/.pi/agent/core-economy.json` switches (`actionFusion`, `observationPack`, both default true; malformed file degrades to defaults).
- **Host-semantics contract suite** (`test/contracts/pi-host-semantics.test.ts`) pinning the pi behaviours the economy modules lean on — the first red light on a pi upgrade.

### Added (pi 0.99 adaptation, SPEC 2026-09-30)
- **modes**: plan mode denies `codemode` and `mcp__*`-shaped tools (read-only holds once tool_search can declare MCP tools); `tool_search` passes as retrieval-only in plan and joins auto's read tier; six-cell verdict matrix pinned by tests.
- **effort**: adopts external thinking changes (`thinking_level_select`, e.g. pi's thinking-cycle keybinding) as session-level explicit, guarded by the owner's `lastApplied` echo guard (recorded before the pi write — the synchronous echo would otherwise re-adopt the owner's own change).
- devDeps: pi toolchain 0.87.1 → 0.99.1 (all four packages + typebox); runtime stays dual-compatible with 0.87.1+.

## 0.1.0 (2026-09-22)

- Initial merged core: permission-modes + effort + goal + review + rules + memory v2 + mcp-gov + web-gov on one assembly line with the capability bus.
