# AGENTS.md — Agent Working Guide

> Working instructions for AI agents (and humans) contributing to this repository.
> 中文版: [AGENTS.zh.md](AGENTS.zh.md) · Architecture docs: [docs/](docs/README.md)

## What this repo is

`@georgedong32/pi-claude-code-core` — the unified core extension package for the
[pi coding agent](https://github.com/earendil-works/pi-coding-agent). One npm
package that assembles **twelve modules** behind a single extension entry
(`extensions/index.ts`): permission modes, effort, goal, review, rules, memory,
mcp-gov, web-gov, action-fusion, observation-pack, the capability bus, and the
UI adapter layer.

pi loads exactly one factory per manifest entry (see the `pi` field in
`package.json`): the default export of `extensions/index.ts` invokes each
module factory in a fixed order with the same `ExtensionAPI` instance.

## Commands

| Command | What it does |
|---|---|
| `bun install` | Install dependencies (bun is the package manager) |
| `bun run check` | Unified tsc gate — two passes: main project (`tsconfig.json`) + contract suite (`tsconfig.contracts.json`). Must be exit 0. |
| `bun run test` | Unit tests, **per-framework**: vitest for `test/lib/` + `extensions/modes/` (colocated), node:test via tsx for `extensions/{effort,goal,review,action-fusion,observation-pack}/tests/` |
| `bun run contracts` | Cross-package contract suite (`test/contracts/`, own vitest config). Pins globalThis keys, env vars, status slots, session entry types, disk layout. |

All three must be green before a change is considered done. Tests are run via
the script entries (`scripts/run-tests.mjs`, `scripts/check.mjs`), not by
invoking vitest/tsc directly.

## Repository layout

```
extensions/
  index.ts           # assembly entry — ordered module factory line
  bus.ts             # capability bus (globalThis.__piClaudeCodeCore)
  modes/             # permission modes: ask/plan/auto/bypass (P1)
  effort/            # thinking-level control: /effort /fast, alt+t (P1)
  goal/              # goal lifecycle + sisyphus loop (P2, fork of capyup/pi-goal)
  review/            # fan-out code review: /review (P2)
  rules/             # rules injection: /rules (P3)
  memory/            # two-layer memory + recall (P3)
  web-gov/           # webfetch(domain:host) rule family (P4)
  mcp-gov/           # MCP rule family + broker mirror + /core panel (P4)
  action-fusion/     # write/edit + then_run fusion (economy, ported from SoL-Pi)
  observation-pack/  # large tool-result projection + obs_recall (economy)
  ui/                # presentation adapters: cctui primary + core fallback
lib/                 # shared primitives — must NOT import from extensions/
test/lib/            # vitest suites for lib/ and cross-module wiring
test/contracts/      # contract suite (see test/contracts/README.md table)
test/spikes/         # throwaway spikes
types/               # published `./types` subpath (type-only: hand-maintained .d.mts; runtime reader withdrawn D4=B)
scripts/             # check.mjs (tsc gate), run-tests.mjs (per-framework test entry)
docs/                # architecture documentation (en/ + zh/)
```

Per-module docs live in [docs/en/](docs/en) / [docs/zh/](docs/zh) — start with
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
8. **Fail-open boundaries**: memory injection and observation-pack projection
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
- **Header comments are documentation**: every module file opens with a block
  comment stating its spec IDs and design decisions. When you change behavior,
  update the header and the matching doc in `docs/`.
- **English code comments**; project log docs (`PROGRESS.md`, `DEVIATIONS.md`,
  `OPEN-QUESTIONS.md`) are Chinese. Architecture docs are bilingual, split by
  language under `docs/en/` and `docs/zh/` — keep both sides in sync when
  editing either.
- **Deviation ledger**: any deviation from the specs (`../specs/` in the parent
  workspace) must be recorded in `DEVIATIONS.md` — it is the single ledger.
  Implementation status per module lives in `PROGRESS.md`.
- **Changelog**: user-visible changes get a `CHANGELOG.md` entry under the
  unreleased/next version heading.

## Key environment variables (consumed by core)

| Variable | Module | Effect |
|---|---|---|
| `PI_CORE_EFFORT` | effort | Hard pin on thinking level; explicit writes are refused while set |
| `PI_CORE_MCP_DIRECT_SERVERS` | mcp-gov | Server ids allowed to claim bare tool names (e.g. `exa`) |
| `PERMISSION_MODES_INHERITED_MODE` | modes | Subagent mode inheritance (produced by pi-subagents, only consumed here) |
| `PERMISSION_MODES_CLASSIFIER_DEBUG` | modes | Debug logging for the auto-mode classifier |
| `PI_GOAL_AUTO_CONFIRM` | goal | Auto-confirm goal proposals |

`PI_SUBAGENT_*` variables are produced by pi-subagents; core only reads them.

## Where things land on disk

| Path | Owner |
|---|---|
| `~/.pi/agent/permission-modes.json` | modes permissions |
| `~/.pi/agent/core-economy.json` | economy switches (`actionFusion` / `observationPack`) |
| `~/.pi/agent/pi-core-web.json` | web-gov preapproved-domain override |
| `~/.pi/agent/memory-queue/` | memory pending-extraction queue (shutdown 写 / session_start drain) |
| `~/.pi/agent/sessions/permission-modes-forwarding/sessions/<id>/` | approval forwarding (pm ↔ pi-subagents) |
| `<cwd>/.pi/goals/` | goal state |
| `<cwd>/.pi/pi-review/` (+ `pi-review.json`, `runs/<runId>/`) | review |
| `<sessionDir>/observation-pack/<sessionId>/` | observation-pack originals |

These are pinned by the contract suite (P0-CT-09) — treat them as frozen.

## If blocked

Stop and ask the user. Do not silently invent workarounds, redefine scope, or
mark work complete that isn't.
