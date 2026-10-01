# memory — Two-Layer Memory

> English. 中文版: [../zh/memory.md](../zh/memory.md)

**Directory**: `extensions/memory/` — new module (P3, V1 shape + V2 expansion)

## What it does

A two-layer (user + project) memory system: scans memory directories, injects
a capped lexical index into context, guards memory-write paths, runs
auto-consolidation, and imports from Claude / Hermes formats. Zero runtime
dependencies, one LLM lane.

## Key surfaces

**Wiring — 2 tools + 4 commands + 9 hooks** (from `index.ts` header):

| Hook | Behavior |
|---|---|
| `session_start` | Reconcile both layers + budget reset + static yield probe |
| `session_compact` | Per-turn budget reset |
| `before_agent_start` | Dynamic yield probe → policy + two-layer capped index |
| `context` | Lexical `selectForTurn` injection (both layers pooled) |
| `tool_call` | `guardMemoryWrites` secret interceptor (both layers) |
| `turn_end` | Auto-consolidation trigger (V2-C) + P3 automation |
| `tool_result` | `memory_consolidate` settle |
| `agent_settled` | Consolidation in-flight clear |
| `registerTool` | `session_recall`, `memory_consolidate` |
| `registerCommand` | `/memory`, `/memory-consolidate`, `/memory-import-claude`, `/memory-import-hermes` |

**Bus**: `memory` channel — `{ yielded, dir }`; index budget published via
`contextBudget.memoryIndexMax` (25K, `lib/context-budget.ts`).

## Internal map

| File | Notes |
|---|---|
| `index.ts` | Assembly; injection hook bodies are try/catch-wrapped at the boundary. Context hook = **per-turn pin & re-project** (MR-01, spec 2026-10-01): select once on the turn's first request, re-project the byte-identical block for every remaining request; `surfacedKeys` = billing-only dedup; tail-append-only + systemPrompt byte-stability (MR-09 cache discipline) |
| `memdir.ts` | Directory scan/reconcile; `scanMemoryDirCached` fingerprint cache + git-root memo (a cached turn does zero content reads) |
| `selection.ts` | `selectForTurn` two-domain qualification (MR-04): primary = title+description ≥2 hits, OR secondary = ≥1 primary + ≥2 body hits; body-only never qualifies, body hits act as same-score tiebreaker; `isPrePaid` predicate keeps paid files from re-consuming budget (MR-05). CJK bigram tokenization; byte-based sizing everywhere (`byteLength`) |
| `policy.ts` | Policy injection block (`POLICY_COMPACT`) |
| `guard.ts` | Secret interceptor on memory-write paths (secret regexes incl. unquoted values / base64 padding) |
| `yield.ts` | `InjectionGate` — static + dynamic yield probes (fail-open: injection failures never block a turn, P3-ME-09) |
| `consolidate.ts` | Consolidation trigger/tool/command; writes via `memory_consolidate` (batch must reduce bytes or file count) |
| `automation.ts` | P3 automation state + settings |
| `importers.ts` | Claude / Hermes import; never overwrites local edits |
| `store.ts`, `llm.ts`, `session-recall.ts`, `paths.ts` | V2 storage, the single LLM lane, cross-session recall (`session_recall` tool), path resolution |

## Invariants & gotchas

- **Fail-open**: any injection failure is swallowed at the boundary — a turn
  must never die because memory hiccuped.
- CJK text needs the bigram path — don't "simplify" tokenization back to
  whitespace.
- The importer treats local files as authoritative: imports never clobber
  local edits.
- Budget constants come from `lib/context-budget.ts`.

## Tests

`test/lib/memory*.test.ts` (vitest: core, V2 storage/automation/consolidate/
migration, carveout) — memory kept its suites in `test/lib` rather than a
colocated directory.
