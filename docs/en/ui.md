# ui — Presentation Adapters

> English. 中文版: [../zh/ui.md](../zh/ui.md)

**Directory**: `extensions/ui/` (plus per-module wrappers like
`extensions/modes/ui/`, `extensions/effort/ui/`)

## What it does

The decoupling layer between business modules and presentation (DECOUPLE-PLAN
§4.2, frozen at DC2). Business modules never touch `ctx.ui` for
*presentation* — they publish state, and an adapter renders it.

## The adapter interface (`ui/base.ts`)

The single presentation interface both adapters satisfy:

- `startup()` / `shutdown()` — adapter lifecycle (mount/unmount widgets).
- `onSnapshot(snapshot)` — push of the frozen bus snapshot. Two duties:
  render persistent state, and diff `notifications` (bounded tail queue, §4.1)
  by `lastSeenId`. Rendering must be idempotent.

The interface shape is deliberately frozen: every method is a fact callers
must learn — do not grow it casually. Interaction surfaces
(select / editor / onTerminalInput) are NOT here — they stay behind
per-module ui wrappers (e.g. `effort/ui`) so logic flows can await them
against a fake.

## Adapters

| Adapter | File | Notes |
|---|---|---|
| cctui (primary) | external (pi-claude-code-tui) | Renders when present; detected via presence keys on globalThis |
| core fallback | `ui/fallback.ts` | Thin default for "core without cctui": owns the working message line and the notification tail display; yields to a live CC-TUI by reading the presence key before any write (poll point self-heals — stale keys are re-read on every snapshot) |
| notify | `ui/notify.ts` | Shared notification entry for modules (feeds the tail queue) |
| footer-lines | `ui/footer-lines.ts` | Multi-source `display.footer` publisher (XPKG-07, 2026-10-07 P1-1): one `Map<source, line>` per bus instance (WeakMap — reset/reload drops old lines), publishes the whole source-sorted array in one patch; removing the last line publishes an explicit empty array |

## Invariants & gotchas

- Module code publishes; adapters render. If you find a module calling
  `ctx.ui` to draw persistent state, move it behind the adapter.
- Presence detection must be re-checked at every snapshot (no caching) —
  that is the self-heal property.
- Notification ids are monotonic; consumers diff by `lastSeenId`.

## Tests

`test/lib/fallback-adapter.test.ts`, `notify.test.ts` (vitest); effort's
adapter interaction is covered in `extensions/effort/tests/ui.test.ts`.
