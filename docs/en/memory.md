# memory — Two-Layer Memory

> English. 中文版: [../zh/memory.md](../zh/memory.md)

**Directory**: `extensions/memory/` — new module (P3, V1 shape + V2 expansion)

## What it does

A two-layer (user + project) memory system: injects a capped index into the
system prompt, recalls memory files as **persisted once-per-user-message
blocks chosen by an LLM manifest selector** (RV, spec 2026-10-02-memory-recall-v2),
guards memory-write paths, runs auto-consolidation, and imports from Claude /
Hermes formats. Zero runtime dependencies, one LLM lane.

## Key surfaces

**Wiring — 2 tools + 4 commands + 8 hooks** (from `index.ts` header):

| Hook | Behavior |
|---|---|
| `session_start` | Reconcile both layers + settings load + static yield probe; **queue drain** (spec 2026-10-03) fires after settings settle — background, per-project, never awaited on the startup path; automation's own `session_start` resets every per-session closure state (A1 — the host reuses handler closures across in-process `/new`,`/resume`,`/fork`; without the reset a dead AbortController silently killed all automation after the first switch) |
| `before_agent_start` | Dynamic yield probe → policy + two-layer capped index; **RV prompt path** — one selection per user message bounded by `recallWaitMs`, the block persists as a custom message right after the user message |
| `message_end` | **RV steer path** — mid-run user messages select with wait 0; custom blocks never trigger (RV-01). Spec v1.2: a parked selection DELIVERS THE MOMENT it completes via `sendMessage(triggerTurn:false)` — pi queues it as a pending custom message and flushes at the next turn_end (the first assistant message's end at the earliest): request #2 sees it within the run, the next turn's request #1 otherwise. Nothing is discarded; `display:false` keeps it invisible in both TUIs |
| `turn_end` | **RV deferred delivery** (first continues=true turn_end, `sendMessage` `triggerTurn:false` — pi flushes pending custom messages right after handler dispatch) + auto-consolidation trigger (V2-C) + P3 automation |
| `agent_end` | **RV run boundary** — abort in-flight selection, drop the held block, clear run dedup |
| `tool_call` | `guardMemoryWrites` secret interceptor (both layers); read suppression is history-derived now (RV-07) |
| `tool_result` | `memory_consolidate` settle + stale-read staleness note |
| `agent_settled` | Consolidation in-flight clear |
| `registerTool` | `session_recall`, `memory_consolidate` |
| `registerCommand` | `/memory` (incl. recall status), `/memory-consolidate`, `/memory-import-claude`, `/memory-import-hermes` |

**No `context` hook anymore** — request-level projection was the root cause
of the 30× cache-miss cost and the frozen-selection re-injection (RC-1/RC-2).

**Configuration** (`~/.pi/agent/settings.json`, `memory` key):
- `model` (string, `"provider/id"`): ops side-channel model (review /
  correction / queue drain — compact and shutdown only STAGE queue records,
  zero LLM). Fallback chain (spec
  2026-10-03): `model` → `recallModel` → session model — an unresolvable
  ref falls through to the next candidate, never straight back to the slow
  session model. Deliberate asymmetry vs D3: recall treats `recallModel`
  as a REQUIRED quality gate (unset = recall off), ops treat it as a
  cheap-lane preference (unresolvable → session model, not a failure);
  ops quality thus rides whatever `recallModel` was configured for.
- `recallModel` (string, `"provider/id"`): the selector model. **Required for
  recall — unset or unresolvable means NO recall** (D3, no lexical fallback).
- `recallWaitMs` (number, default **0** since spec v1.2, clamped to 0–15000): per-message
  selector wait budget on the prompt path. 0 = never block the screen on the
  selector — the block arrives via the completion-driven pending-message
  flush instead. A positive value trades screen delay for request-#1 recall.

Known costs (accepted, spec D4 + handoff traps): the `before_agent_start`
handler chain is serially awaited, so a positive `recallWaitMs`
(only when a selector model is configured) delays later extensions' handlers
and the main model request by up to that budget — the v1.2 default of 0
removes this cost entirely; and subagent child sessions load core too — every
child's dispatch prompt runs one selector call (token cost + ≤waitMs
first-token latency). That is expected behavior, not a bug to special-case.

**Bus**: `memory` channel — `{ yielded, dir }`; index budget published via
`contextBudget.memoryIndexMax` (25K, `lib/context-budget.ts`).

## Internal map

| File | Notes |
|---|---|
| `index.ts` | Assembly; hook bodies try/catch-wrapped at the boundary. Event routing only — every recall decision lives in `recall.ts` |
| `memdir.ts` | Directory scan/reconcile; `scanMemoryDirCached` fingerprint cache + git-root memo; `eligibleMemories` = the recall candidate set (both layers, newest-first, absolute paths); `memoryKey` = the canonical `user-memory/<file>` / `memory/<file>` key |
| `recall.ts` | **The RV deep module** (three entries: `onUserMessage` / `onTurnEnd` / `abort`). All session state derives from the projection history on every call (D9): hard dedup since the last `compactionSummary` (RV-06), read suppression from read toolCalls resolved against cwd (RV-07), byte budget from past `details.bytes` (RV-08), recentTools = succeeded-never-failed since the last user message (RV-13). Skill-wrapper stripping + length hygiene (RV-02); latest-wins supersede (RV-05); render with byte-safe truncation + path note; `RecallDetailsV1` (frozen, contract-pinned) |
| `selector.ts` | `llmSelector` over the shared llm.ts lane: manifest = `[layer][type] key (age): description` newest-first capped at 200; precision-first prompt (empty list is a good answer); recentTools anti-noise rule; `resolveRecallModel` = exact provider/id → unique bare id → OFF (no session-model fallback, D3) |
| `policy.ts` | Policy injection block (`POLICY_COMPACT`) |
| `guard.ts` | Secret interceptor on memory-write paths (secret regexes incl. unquoted values / base64 padding) |
| `yield.ts` | `InjectionGate` — static + dynamic yield probes (fail-open: injection failures never block a turn, P3-ME-09) |
| `consolidate.ts` | Consolidation trigger/tool/command; writes via `memory_consolidate` (batch must reduce bytes or file count) |
| `automation.ts` | P3 automation state + settings; per-session state reset on `session_start` (A1) | 
| `queue.ts` | Pending-extraction queue (spec 2026-10-03): the shutdown path stages the unextracted tail (cursor-relative suffix-60) as ONE atomic JSON record under `~/.pi/agent/memory-queue/`; the next same-project `session_start` drains it in the background (≤5 records, ≤3 attempts, exact `projectsDir` routing, age/size GC). The shutdown handler itself runs ZERO LLM — the host awaits shutdown handlers serially with no timeout, and the old awaited 10s flush measurably stalled every long-session exit. Records are a plaintext second copy of the session tail (≤7 days, ≤2MB total), disclosed here |
| `importers.ts` | Claude / Hermes import; never overwrites local edits |
| `store.ts`, `llm.ts`, `session-recall.ts`, `paths.ts` | V2 storage, the single LLM lane, cross-session recall (`session_recall` tool), path resolution |

## Invariants & gotchas

- **Fail-open**: any injection failure is swallowed at the boundary — a turn
  must never die because memory hiccuped.
- **Zero-LLM shutdown (spec 2026-10-03)**: `session_shutdown` only stages a
  queue record (synchronous atomic write, ≤120KB); extraction happens later
  on the drain lane. Never reintroduce an awaited LLM call in a
  `session_shutdown` handler.
- **Persisted-once delivery (D1)**: a recall block enters the transcript as a
  `pi-memory-recall` custom message at most once per real user message —
  custom blocks themselves never trigger recall (RV-01), and history-derived
  hard dedup means one file surfaces at most once per compaction window
  (RV-06).
- **No model, no recall (D3)**: `memory.recallModel` unset/unresolvable →
  recall is entirely off. Never add a lexical or session-model fallback.
- **State from history only (D9)**: no closure state in the wiring — dedup /
  read / budget / recentTools all re-derive from
  `buildSessionProjection().messages` (details survival is contract-pinned).
- The importer treats local files as authoritative: imports never clobber
  local edits.
- Budget constants come from `lib/context-budget.ts` (`RECALL_*` are
  deliberately NOT on the published `CONTEXT_BUDGET` object — no consumer).

## Tests

`test/lib/memory*.test.ts` + `recall.test.ts` + `memory-llm-selector.test.ts`
(vitest: core wiring, RV machine, RV selector, V2 storage/automation/
consolidate/migration, carveout) — memory kept its suites in `test/lib`
rather than a colocated directory. The `pi-memory-recall` customType +
details-v1 field set are pinned in the contract suite (P0-CT-08), and the
real-package `buildSessionProjection` details-survival is pinned in
`pi-host-semantics.test.ts` ⑥.
