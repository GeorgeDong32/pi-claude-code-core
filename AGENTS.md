# AGENTS.md — Agent Working Guide

> Working instructions for AI agents (and humans) contributing to this repository.
> 中文版: [AGENTS.zh.md](AGENTS.zh.md) · Architecture docs: [docs/](docs/README.md)

## What this repo is

`@georgedong32/pi-claude-code-core` — the unified core extension package for the
[pi coding agent](https://github.com/earendil-works/pi-coding-agent). One npm
package that assembles **fifteen modules** behind a single extension entry
(`extensions/index.ts`): permission modes, effort, goal, review, rules,
notes-index (index injection of the notes directory — the memory module is
gone), session-recall, mcp-gov, web-gov, action-fusion, observation-pack,
bg-shell, the capability bus, the compaction controller, and the UI adapter
layer.

pi loads exactly one factory per manifest entry (see the `pi` field in
`package.json`): the default export of `extensions/index.ts` invokes each
module factory in a fixed order with the same `ExtensionAPI` instance.

## Commands

- `pnpm install` — dependencies (pnpm is the package manager).
- `pnpm run check` — lint plus two tsc passes (main project and the contract suite).
- `pnpm run test` — unit tests, per framework: vitest for `test/lib/` and `extensions/modes/` (colocated), node:test via tsx for `extensions/{effort,goal,review,action-fusion,observation-pack,bg-shell,compaction}/tests/`.
- `pnpm run contracts` — the cross-package contract suite (`test/contracts/`).

**All three gates must be exit 0 before a change is considered done.** Run tests
through the script entries (`scripts/run-tests.mjs`, `scripts/check.mjs`), never
by invoking vitest/tsc directly. Before upgrading pi, run the upgrade canary:
`pnpm exec vitest run test/lib/upgrade-canary.test.ts --config vitest.config.ts`.

## Layout

One directory per module under `extensions/`, assembled in the order given by
`extensions/index.ts`. Shared primitives live in `lib/`, vitest suites in
`test/lib/`, the contract suite in `test/contracts/` (its `README.md` is the
contract table), published types in `types/`, architecture docs per module in
`docs/en/` and `docs/zh/`. Start with
[docs/en/architecture.md](docs/en/architecture.md).

## Hard invariants (do not break)

1. **Dependency direction**: `lib/` never imports from `extensions/`. Shared
   helpers that need extension types use structural typing instead
   (`lib/rule-text.ts` is deliberately self-contained).
2. **Thinking-level ownership**: `lib/effort-owner.ts` is the ONLY place in
   core allowed to call `pi.setThinkingLevel`. Priority chain: env pin
   (`PI_CORE_EFFORT`) > explicit session choice > mode profile > model default.
   A source scan (P1-EF-07) enforces this for `extensions/`.
3. **Capability bus discipline** (`extensions/bus.ts`):
   - `globalThis.__piClaudeCodeCore` is a **frozen pure-data snapshot** — no
     functions (except the v2 data-carried `onChange` field).
   - Publish only inside pi event handlers, with no `await` gaps; whole-
     snapshot replace + monotonic revision; legacy keys (`__piPermissionModes`,
     `__pmWorkingStats`) are derived in the same synchronous batch.
   - No timers, no polling. Subscriptions are data (version-gated), never an
     event system.
4. **Rule family seam**: additional governance families register via
   `modes/rule-families.ts` (`registerRuleFamily`). web-gov is assembled
   BEFORE mcp-gov so URL-carrying calls hit domain rules first.
   `mcp-gov/family.ts#canonicalizeMcpTool` is the single authority on
   "is this an MCP-shaped tool" — reuse it, don't reimplement. Its pure
   shape core lives in `lib/mcp-shape.ts` and is shared with the modes
   plan gate (arch B1); consume the authority or the lib core, never
   write a second shape test.
5. **Context budget** (`lib/context-budget.ts`): rules 40K / memory index 25K /
   dynamic steer 8K characters. Producers must clamp to these.
6. **Contract suite protocol**: every cross-package surface change must be
   registered in the `test/contracts/README.md` table (contract → spec ID →
   consumer → removal condition) BEFORE the test is written. A test that can't
   run gets `test.todo` with the target Phase number — never silently dropped.
7. **Frozen surfaces**: session entry types and disk layout (P0-CT-08/09) are
   frozen — never break existing user data silently.
8. **Fail-open boundaries**: notes-index injection and observation-pack projection
   failures must never block a turn (try/catch-wrapped hook bodies, per-message
   fail-open). Economy modules gate themselves through `lib/pi-compat.ts`
   probes and degrade with a warning instead of blocking the session.
9. **observation-pack never edits history** — it rewrites only the `context`
   projection layer; transcript, TUI rendering, compaction and resume are
   untouched.
10. **JSON settings** go through `lib/settings.ts`: read returns fallback for
    missing/malformed input (never throws, except the `onInvalid` callback);
    write is atomic (tmp + rename in the same directory).

## Conventions

- **Test framework follows origin**: each module keeps the framework it
  migrated with. New lib-level or cross-module suites go in `test/lib/`
  (vitest). Don't mix frameworks inside one suite directory.
- **Tabs for indentation** (matches the existing codebase; `.editorconfig`-less
  repo, follow surrounding style).
- **No file headers, no narration**: a source file starts with its code.
  Invariants and design decisions live in `docs/` (bilingual, kept in sync)
  and in the contract suite, not in comments. A comment survives only when it
  states a license or provenance, an external constraint the code cannot
  express (name the external thing: pi host, platform, protocol), or a public
  API contract. `scripts/lint-comments.mjs` (part of `pnpm run check`) rejects
  banners, dates, sermon markers, suppressions, commented-out code and long
  file headers. When you change behavior, update the matching doc in `docs/`.
- **English code comments**; project log docs (`PROGRESS.md`, `DEVIATIONS.md`,
  `OPEN-QUESTIONS.md`) are Chinese. Architecture docs are bilingual, split by
  language under `docs/en/` and `docs/zh/` — keep both sides in sync when
  editing either.
- **Deviation ledger**: any deviation from the specs (`../specs/` in the parent
  workspace) must be recorded in `DEVIATIONS.md` — it is the single ledger.
  Implementation status per module lives in `PROGRESS.md`.
- **Changelog**: user-visible changes get a `CHANGELOG.md` entry under the
  unreleased/next version heading.

## Reference

The environment variables core consumes and the files it writes are documented
per module in `docs/en/` (each module doc lists its own; the disk layout is
pinned by the contract suite, P0-CT-09 — treat those paths as frozen). One rule
that is easy to miss: `PERMISSION_MODES_INHERITED_MODE` is honored only together
with `PI_SUBAGENT_CHILD=1`. `PI_SUBAGENT_*` variables are produced by
pi-subagents; core only reads them.

## If blocked

Stop and ask the user. Do not silently invent workarounds, redefine scope, or
mark work complete that isn't.
