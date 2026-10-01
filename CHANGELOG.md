# Changelog

## Unreleased

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
