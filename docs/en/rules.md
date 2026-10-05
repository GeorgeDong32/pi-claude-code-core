# rules — Rules Injection

> English. 中文版: [../zh/rules.md](../zh/rules.md)

**Directory**: `extensions/rules/` — new module (P3)

## What it does

Collects rule files from repo + user scopes, renders them under a character
budget, and appends them to the system prompt. v1 is read-only (`/rules`
command); lifecycle objects (setEnabled/lint/subscribe) are deliberately
deferred (P3-RU-12) so the factory shell can accept future commands without
breaking the interface.

## Key surfaces

- **Command**: `/rules` (list + render preview).
- **System prompt**: `before_agent_start` does an **append-only** concat of
  `renderRules` output — never touches `contextFiles`, never mutates existing
  content (P3-RU-06). Emits `contextBudget` on the bus once (P3-RU-10).
- **Steering**: `tool_call` captures edit/write/read target paths; a first
  hit on a `globs` rule steers the full rule text once per session
  (P3-RU-07). **AR1005-RU (2026-10-05)**: the activations of ONE turn now
  cumulatively share `DYNAMIC_STEER_MAX` (8 000 chars, JS string length) —
  a turn spans `turn_start` → the next `turn_start`, and every tool call in
  between draws from the same epoch (previously each message was checked
  against the budget alone: three 6 K rules on one read sent ~18 K). The
  delivery ladder per first-hit rule: full text → the existing "Read on
  demand" pointer → a short pointer (complete path, minimal note) → nothing
  this turn (unmarked, retried on the next matching tool call — no
  background queue). A sent pointer counts as session-activated (the
  historical oversized-single semantics). Rule bodies are never truncated.

## Cheapness promise (P3-RU-08, DEVIATIONS #42)

A file-level fingerprint (`mtimeMs`+`size` per rule file) gates rescans: an
unchanged turn costs **one readdir + N stats per dir and zero file-content
reads**.

## Internal map

| File | Notes |
|---|---|
| `index.ts` | Factory `createRulesExtension(options)` — the only export (DESIGN-RULES D3). Wires `turn_start` (budget epoch) and the sync send adapter into the activation module |
| `activation.ts` | **The activation budget module (AR1005-RU)**: session activation set + per-turn character budget; the reserve-send-rollback ladder runs in one synchronous pass (re-entrant adapters cannot double-spend; a throwing send rolls back and leaves the rule eligible) |
| `render.ts` | `collectRules` / `renderRules` / `globToRegExp`; rule dir scanning |
| `scan.ts` | Target-path extraction from tool calls |
| `paths.ts` | Rule directory resolution (project + user scopes, optional `extraDirs`) |
| `defaults.ts` | Built-in rule texts |
| `lib/context-budget.ts` | `RULES_MAX` 40K clamp; steering budget shared with memory |

## Rules file shape

Rule files live in rule directories under project/user scopes (see
`paths.ts`); a rule can carry an optional `globs:` matcher that gates it to
matching paths. `/rules` shows what is active and rendered.

## Invariants & gotchas

- Injection is append-only and budget-clamped — never reorder or rewrite the
  existing system prompt.
- lib (`context-budget`) is the clamp authority; don't add a second budget
  constant here.

## Tests

`test/lib/rules-render.test.ts`, `rules-wiring.test.ts` (vitest).
