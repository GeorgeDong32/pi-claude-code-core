# effort — Thinking-Level Control

> English. 中文版: [../zh/effort.md](../zh/effort.md)

**Directory**: `extensions/effort/`
**Origin**: migrated from `@georgedong32/pi-effort` 0.1.2 (P1)

## What it does

Owns pi's thinking level end-to-end through a single ownership chain
(`lib/effort-owner.ts`):

```
① PI_CORE_EFFORT env pin   — hard pin, read once at startup; explicit writes refused while set
② explicit session choice  — /effort command, picker, alt+t shortcut
③ mode profile :effort     — set by modes when a profile applies
④ model default            — owner never writes; pi keeps its default
```

The effective value is pushed down via `pi.setThinkingLevel` — **this module
chain is the only place in core allowed to call it** (P1-EF-07 source scan).

## Key surfaces

- **Commands**: `/effort` (set/cycle thinking level), `/fast` (toggle fast
  mode for fast-model ids like `gpt-5*`).
- **Shortcuts**: alt+t cycles thinking levels (including `off`; registered by the
  modes module, routed through the effort owner as an explicit choice);
  ctrl+shift+e cycles effort from within the effort module itself (env-pin
  aware — refuses with a notice while `PI_CORE_EFFORT` is set).
- **Bus**: `effort` channel — `{ level, source: "env" | "session" | "profile" | "model-default" }`.
- **Status slots**: `pi-effort-thinking`, `pi-effort-fast` (contract P0-CT-07).

## Internal map

| File | Notes |
|---|---|
| `effort.ts` | Pure logic: levels, aliases, `cycleLevel`, `resolveEffortLevel`, fast-mode helpers. Resolving an unset effort returns `undefined` — no silent medium default. |
| `effort-picker.ts` | Overlay picker built on `lib/overlay.ts` |
| `ui/index.ts` | Per-module interaction wrapper (select overlay) — presentation stays out of business flow |
| `index.ts` | Wiring: commands, keybinding, owner adoption, bus publication, status slot refresh via owner.changed() |

## Invariants & gotchas

- Semantic aliases and user-facing levels differ per model — always resolve
  through `effort.ts`, never hardcode level lists.
- Fast mode only applies to fast-model ids (`gpt-5*` prefix check).
- When modes applies a profile with `:effort`, it calls the owner
  (`setFromProfile`), not pi directly.

## Tests

`extensions/effort/tests/` — node:test via tsx (framework kept from origin):
`effort.test.ts`, `effort-picker.test.ts`, `integration.test.ts`,
`owner-adopt.test.ts`, `ui.test.ts`. Owner logic additionally covered in
`test/lib/` via `effort-owner.test.ts` context.
