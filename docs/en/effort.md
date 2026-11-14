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
  mode: OpenAI priority tier for `gpt-5*`-matching models on
  Responses/Codex APIs).
- **Shortcuts**: alt+t cycles thinking levels (including `off`) and
  ctrl+shift+e cycles effort — BOTH registered by the effort module (arch
  review C5: alt+t moved from modes; now model-aware via
  cycleLevel/cycleLevelWithOff instead of a hardcoded table, with a
  zero-write guard so single-level models can no longer pin a clamped value
  into the explicit slot); env-pin aware — refuses with a notice while
  `PI_CORE_EFFORT` is set.
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
- Fast mode injects `service_tier: "priority"` only for `gpt-5`/`gpt-6`
  matching ids (substring, so provider-prefixed ids match) whose API is
  `openai-responses` / `openai-codex-responses` — the only wire dialects
  where the field is real (pi-ai maps its own serviceTier option on exactly
  these two). On any other dialect (e.g. an anthropic-messages proxy) the
  field would be dropped or rejected in transit, so `/fast on` reports a
  no-op for the current model instead of injecting; the setting still
  persists globally for the next applicable model.
- When modes applies a profile with `:effort`, it calls the owner
  (`setFromProfile`), not pi directly.
- **BH-E5 (2026-11-14): the host resets thinking INSIDE model switches —
  do not adopt it.** `AgentSession.setModel` calls
  `setThinkingLevel(_getThinkingLevelForModelSwitch(model))` (per-model
  override → global default → current) and the `thinking_level_select`
  emission happens from inside the `setModel` call, so the listener runs
  while the host is switching models. The listener distinguishes this case
  via the owner's model-switch span (`beginModelSwitch`/`endModelSwitch`
  bracketing in `profile-apply.ts`): such events are recorded with
  `noteModelSwitchLevel` (echo bookkeeping + stale-profile-slot cleanup)
  and NEVER promoted to an explicit choice — previously the reset became
  `source: "session"`, silently beating the profile slot forever. External
  changes outside the span still adopt (EFF-01 unchanged).
- **FX-2 (2026-11-14): the boundary covers EVERY host model-switch path
  (manual `/model`, ctrl+p), not just the profile bracket.** The host assigns
  `agent.state.model` BEFORE `setThinkingLevel` emits, so the tls listener
  (now `(event, ctx)`) also classifies the reset as switch-caused when the
  live `ctx.model` differs from a baseline model key (provider+id)
  remembered at `session_start` / `model_select` / `agent_start` /
  `turn_start`. The `model_select` that confirms a non-bracketed switch then
  calls the owner's `afterHostModelSwitch()`: clear the stale profile slot
  (BH-E5 semantics) and re-apply ① env / ② explicit on the new model —
  still the only owner-owned `setThinkingLevel` write (P1-EF-07), the host
  clamps unsupported levels. Degradation: if an external extension registers
  its tls handler ahead of core's and stalls the dispatch, `model_select`
  arrives before the reset event; the baseline is already updated, so the
  reset is adopted as before the fix — pinned by `model-switch-adopt.test.ts`
  FX-2⑥ and considered acceptable (same behavior as pre-FX-2).

## Tests

`extensions/effort/tests/` — node:test via tsx (framework kept from origin):
`effort.test.ts`, `effort-picker.test.ts`, `integration.test.ts`,
`owner-adopt.test.ts`, `model-switch-adopt.test.ts`,
`host-model-switch.test.ts`, `ui.test.ts`. Owner
logic additionally covered in `test/lib/` via `effort-owner.test.ts` context.
