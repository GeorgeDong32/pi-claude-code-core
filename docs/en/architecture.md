# Architecture

> English overview. 中文版: [../zh/architecture.md](../zh/architecture.md)

## One package, one assembly line

pi loads a single factory per manifest entry. `extensions/index.ts` default-
exports the assembly function and runs the module factories in a fixed order
against one shared `ExtensionAPI` instance:

```
bus → modes → effort → goal → review → rules → memory → web-gov → mcp-gov → economy(action-fusion, observation-pack)
```

Order matters in two places:

- **web-gov before mcp-gov** — for URL-carrying tool calls the domain rule
  family (`webfetch(domain:host)`) must evaluate before the MCP family falls
  through to `mcp_*`-prefix rules.
- **economy modules last** — observation-pack must own the final `context`
  projection slot (after modes/memory handlers); action-fusion's registration
  order is position-independent but fixed for determinism.

## The two layers

```
lib/                  extensions/
shared primitives     modules, one directory each
(no reverse deps)     (may import lib/, never the reverse)
```

- `lib/` holds cross-module primitives: settings JSON, overlay picker,
  model-id parser, rule-text helpers, effort owner, context budget, economy
  switches, pi compatibility probes. Self-contained by rule — helpers that
  need extension-shaped data use structural typing.
- `extensions/` holds the twelve modules. Modules talk to each other through
  two sanctioned seams: **direct imports** (e.g. effort/modes import
  `lib/effort-owner.ts`; web-gov reuses `mcp-gov/family.ts`) and the
  **capability bus** (read-only state).

## The capability bus

`extensions/bus.ts` publishes `globalThis.__piClaudeCodeCore`: a frozen,
pure-data snapshot with a monotonic revision, whole-snapshot replaced inside
pi event handlers only. Legacy keys (`__piPermissionModes`, `__pmWorkingStats`)
are derived in the same synchronous batch so old consumers can never disagree
with the new snapshot. Consumers: CCTUI ≥1.5.0, pi-agent-panel, and core's own
UI adapters. The published shape lives in `types/` (JS + hand-maintained
declaration twin, shape-guarded by `test/lib/bus-types.test.ts`).

Details: [bus.md](bus.md).

## Module map

| Module | Origin | One-liner |
|---|---|---|
| `modes` | @georgedong32/permission-modes 2.8.0 | ask/plan/auto/bypass permission engine, classifier, approval forwarding |
| `effort` | @georgedong32/pi-effort 0.1.2 | thinking-level ownership chain, /effort /fast, alt+t |
| `goal` | capyup/pi-goal 0.6.0 fork | goal lifecycle tools/commands, sisyphus loop, completion auditor |
| `review` | @georgedong32/pi-review 0.8.6 | /review fan-out pipeline, pi_review_report tool |
| `rules` | new (P3) | repo rule files → system prompt injection, /rules |
| `memory` | new (P3) | two-layer memory, injection, guard, consolidation, importers |
| `web-gov` | new (P4) | webfetch(domain:host) family + preapproved domains |
| `mcp-gov` | new (P4) | MCP rule family, broker mirror, /core panel |
| `action-fusion` | NVlabs/SoL-Pi port | write/edit + `then_run` in one turn |
| `observation-pack` | NVlabs/SoL-Pi port | large tool results → placeholder + obs_recall paging |
| `bus` | new (P1) | capability snapshot |
| `ui` | new (DC5) | presentation adapters: cctui primary, core fallback |

## Cross-cutting invariants

1. `lib/` never imports `extensions/`.
2. `lib/effort-owner.ts` is the only `pi.setThinkingLevel` call site.
3. Bus publishes are synchronous, frozen, whole-snapshot, monotonic.
4. Rule families register through `modes/rule-families.ts`; keep web-gov
   assembled before mcp-gov; `canonicalizeMcpTool` is the single MCP-shape
   authority.
5. Context budget split: rules 40K / memory index 25K / dynamic steer 8K
   (`lib/context-budget.ts`).
6. Fail-open at injection/projection boundaries; economy modules degrade via
   `lib/pi-compat.ts` probes instead of blocking the session.
7. Contract-pinned surfaces (globalThis keys, env vars, status slots, session
   entry types, disk layout) change only through the contract-table protocol
   in `test/contracts/README.md`.

## Evolution model

The package was built phase-by-phase from four predecessor packages
(pm / pi-effort / pi-goal fork / pi-review), each migration pinned by the
contract suite with assertions unchanged. Specs live in the parent workspace
`../specs/` (P0 scaffold → P1 modes/effort/bus → P2 goal/review → P3
rules/memory → P4 mcp-gov/web-gov, plus the 0.2.0 SoL-Pi economy absorption
SPEC 2026-09-29). Deviations from specs are recorded in `DEVIATIONS.md`;
per-module implementation status in `PROGRESS.md`.

## Testing model

- **vitest**: `test/lib/` (lib units + cross-module wiring) and
  `extensions/modes/` (colocated `*.test.ts`).
- **node:test via tsx**: `extensions/{effort,goal,review,action-fusion,
  observation-pack}/tests/` — each migrated package kept its framework.
- **contracts** (`bun run contracts`): `test/contracts/` pins cross-package
  surfaces; includes a host-semantics suite (`pi-host-semantics.test.ts`)
  that is the first red light when a pi upgrade breaks an assumed behavior.
- **tsc gate** (`bun run check`): two projects, main + contracts.

Run everything through the script entries (`bun run check|test|contracts`);
never invoke vitest/tsc directly.
