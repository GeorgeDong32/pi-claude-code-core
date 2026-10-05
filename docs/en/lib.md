# lib/ — Shared Primitives

> English. 中文版: [../zh/lib.md](../zh/lib.md)

Eight small modules that every extension may use. **Rule: `lib/` never
imports from `extensions/`** — helpers that need extension-shaped data accept
it structurally.

| File | Purpose | Key facts |
|---|---|---|
| `settings.ts` | JSON settings primitive (P0-LB-01) | `readJson` returns fallback for missing/empty/malformed/non-object input, never throws (a throwing `onInvalid` callback is the one exception); writes are atomic tmp+rename in the same dir; concurrent writers resolve last-rename-wins. Replaced four per-package copies. |
| `overlay.ts` | Overlay picker skeleton (P0-LB-03) | Wraps `ctx.ui.custom` + `overlayOptions` into a vertical list with selected state; degrades to `ctx.ui.select` outside TUI, returns null headless. Consumers: effort picker, plan-approval dialog, goal dialog. |
| `model-id.ts` | `"provider/model[:effort]"` parser (P0-LB-02) | Byte-equivalent to pm 2.8.0's parser; trailing `:` = no effort; bad input → null, never throws. Used by modes profiles and review model resolution. |
| `rule-text.ts` | Permission rule text helpers | `ruleValueText` / `ruleMatchesId` — one deep point for ruleValue→text and wildcard matching (was 4 + 2 copies). Callers: modes/rule-families, mcp-gov, web-gov. Self-contained on purpose (structural `RuleLike`, no reverse dep). |
| `effort-owner.ts` | Thinking-level ownership chain (P1-EF-05) | Single owner: ① `PI_CORE_EFFORT` env pin > ② explicit session choice (/effort, picker, alt+t) > ③ mode profile `:effort` > ④ model default. **The only call site of `pi.setThinkingLevel` in core** (P1-EF-07 source-scan enforced). |
| `context-budget.ts` | Static injection budget split (P3-RU-10) | `RULES_MAX` 40 000 / `MEMORY_INDEX_MAX` 25 000 / `DYNAMIC_STEER_MAX` 8 000 chars; published read-only as bus `contextBudget`. Constants, not an allocator — enough while there are two producers. |
| `core-economy.ts` | Economy feature switches (SPEC DEC-02) | `~/.pi/agent/core-economy.json` → `{ version: 1, actionFusion, observationPack }`, both default true; malformed file degrades to defaults with one warning (deliberately unlike upstream SoL-Pi's fail-fast). |
| `json-lift.ts` | Model-text JSON extraction (arch C4; AR1005-JS) | `jsonCandidates` / `liftJson` / `repairJsonCandidate` / `balancedObjectSpans` — ONE string-aware implementation for modes classifier, memory ops, recall selector, review verdict. Canonical candidate order: fenced ```json blocks last-first → whole trimmed text → string-aware balanced spans → outermost slice. AR1005-JS-01: repair is a character-state scan (tracks strings/escapes), so a real trailing comma removes ONLY that comma — string bodies like `"literal ,} sequence"` pass byte-identical (the old regex rewrote them). AR1005-JS-02: candidates come from a private lazy generator shared by both exports; a stage-1/2 success ends generation, so the (potentially quadratic) span scan never runs for inputs whose fence/whole-text already parsed. Inputs that still NEED span fallback keep the disclosed quadratic worst case (AR1005-JS-03). |
| `pi-compat.ts` | pi host compatibility probes (SPEC CMP-01..06) | `MIN_PI_VERSION = "0.87.0"`; probes tool factories + `withFileMutationQueue`. Every pi dependency of the economy modules is an explicit probe, never an implicit assumption (the failure mode this prevents: a pi upgrade silently breaking a mechanism). Never imports pi runtime objects — everything injected, unit-testable. |

Tests: `test/lib/*.test.ts` (vitest) — one suite per primitive plus
cross-module wiring suites.

Gotchas for agents:

- When adding a lib helper that extensions will share, keep it dependency-free
  and structurally typed; if it duplicates logic already in an extension,
  converge into lib instead of keeping two copies (Standards #4,
  REVIEW-2026-09-22).
- `settings.ts` is the only sanctioned way to read/write `~/.pi/agent/*.json`
  config — don't hand-roll `readFileSync(JSON.parse)` in modules.
