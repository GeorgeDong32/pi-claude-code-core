# memory — Project Memory (single layer)

> English. 中文版: [../zh/memory.md](../zh/memory.md)

**Directory**: `extensions/memory/` — new module (P3, V1 shape + V2 expansion;
single layer since the 2026-11-24 policy revision)

## What it does

A single-layer (project) memory system: injects a capped index + policy block
into the system prompt (rebuilt only at session start / compaction), recalls
memory files as **persisted blocks on the first user messages of a task**
(boundary recall, prompt-path only), guards memory-write paths, consolidates
on manual request, and imports from Claude / Hermes formats. Zero runtime
dependencies, one LLM lane.

The cross-project USER layer (`~/.pi/agent/memory/`) is **retired**: it is no
longer injected, recalled, written or consolidated. Remaining files there are
read-only (pinned files still inject until their migration to the user's own
notes completes); the guard rejects any write into that directory and the
importers land everything in the project layer.

## Key surfaces

**Wiring — 2 tools + 4 commands + hooks** (from `index.ts` header):

| Hook | Behavior |
|---|---|
| `session_start` | Reconcile the project layer + settings load + static yield probe; `sessionStartedAtMs` captured (recall echo filter baseline); injection cache dropped; **queue drain** (spec 2026-10-03) fires after settings settle — background, per-project, never awaited on the startup path; automation's own `session_start` resets every per-session closure state (A1 — the host reuses handler closures across in-process `/new`,`/resume`,`/fork`); **AR1005-RC**: also defensively disposes the recall machine (reload/resume drivers — complements, never replaces, `session_shutdown`). The retired user dir is intentionally NOT created/reindexed |
| `before_agent_start` | Policy + capped index from the injection cache (session-stable); **task-boundary recall on the prompt path** — a real user message selects only while `userTurns < RECALL_BOUNDARY_TURNS` (2) counting messages since the last `compactionSummary`; a selection waits at most `recallWaitMs` (default 5000, clamped 1s–15s) and a timeout **aborts and DISCARDS** — nothing injects into the run after the prompt path gave up. Custom-message runs (`sendMessage` `triggerTurn:true` — goal continuations, consolidation directives) keep the injection but never select |
| `agent_end` | Background review extraction (completed-run snapshot, ≥10 turns / ≥15 tool calls thresholds, warmup ≥3 user turns, suffix-60 window cap, empty-window guard — no mid-run extraction, at most one LLM pass per run); the model-wrote-memory mutex suppresses the LLM pass while still advancing the cursor |
| `session_shutdown` | **AR1005-RC-04**: dispose the recall machine on ANY shutdown reason — synchronous, never waits on the model. A late selector completion is dropped by generation invalidation: no history read, no delivery, no unhandled rejection (contract AR1005-RC-HOST pins this against the real `ExtensionRunner` + `invalidate()`) |
| `tool_call` | `guardMemoryToolCall` (G1 verdicts; BH-R2: the secret probe is memory-layer-scoped and scans only the incoming text — write's `content`, edit's `edits[].newText`); any write into the retired user dir is blocked outright; read suppression is history-derived (RV-07) |
| `tool_result` | Stale-read staleness note |
| `agent_settled` | Consolidation directive-turn flag cleared (automation accounting reopens) |
| `registerTool` | `session_recall` (deferred), `memory_lookup` (deferred), `knowledge_search` (deferred), `memory_consolidate` |
| `registerCommand` | `/memory` (incl. recall status + retired-layer notice), `/memory-consolidate` (manual-only, project layer), `/memory-import-claude`, `/memory-import-hermes` |

**No `message_end` / `turn_end` recall or consolidation** — recall is
prompt-path only (a mid-run steer is not a task boundary), and consolidation
never auto-fires: over-budget stores surface in `/memory` diagnostics and the
`/memory-consolidate` command sends the directive.

**No `context` hook** — request-level projection was the root cause of the
30× cache-miss cost (RC-1/RC-2).

**Session-stable injection**: the policy block is rebuilt only when the
compaction count changes (or writability flips). A mid-session memory write
never flips the system prompt — the KV cache survives the session.

**Task-boundary recall details**:
- candidate pool: project layer only, newest-first, **excluding files whose
  mtime ≥ `sessionStartedAtMs`** (a file written this session never re-enters
  the pool — no echo loops);
- budget: ≤3 files / 16KB per session (`lib/context-budget.ts`);
- the selector query carries the previous real user message (≤1000 chars);
- the block persists as a `pi-memory-recall` custom message (`RecallDetailsV1`
  frozen, contract P0-CT-08; `delivery` is always `"immediate"` — the deferred
  era is gone, `stats.late` counts discarded timeouts).

**Configuration** (`~/.pi/agent/settings.json`, `memory` key):
- `model` (string, `"provider/id"`): ops side-channel model (review /
  correction / queue drain — compact and shutdown only STAGE queue records,
  zero LLM). Fallback chain (spec 2026-10-03): `model` → `recallModel` →
  session model — an unresolvable ref falls through to the next candidate,
  never straight back to the slow session model. Deliberate asymmetry vs D3:
  recall treats `recallModel` as a REQUIRED quality gate (unset = recall
  off), ops treat it as a cheap-lane preference.
- `recallModel` (string, `"provider/id"`): the selector model. **Required for
  recall — unset or unresolvable means NO recall** (D3, no lexical fallback).
- `recallWaitMs` (number, default **5000**, clamped 1s–15s): per-message
  selector wait budget on the prompt path. On timeout the selection is
  aborted and discarded (never delivered late — nothing injects after the
  prompt path returned).

Known costs (accepted): a positive `recallWaitMs` delays the main model
request by up to that budget, but only on the first two user messages of a
task; subagent child sessions load core too — their dispatch prompts run one
selector call within the same boundary budget.

**Bus**: `memory` channel — `{ yielded, dir }`; index budget published via
`contextBudget.memoryIndexMax` (25K, `lib/context-budget.ts`).

## Internal map

| File | Notes |
|---|---|
| `index.ts` | Assembly; hook bodies try/catch-wrapped at the boundary. Event routing only — every recall decision lives in `recall.ts`. Owns the injection cache, the echo-filter baseline and the consolidation directive-turn flag |
| `memdir.ts` | Directory scan/reconcile; `scanMemoryDirCached` fingerprint cache + a 1s fresh-window TTL (every internal write path invalidates explicitly); `eligibleMemories(projectDir)` = the single-layer recall candidate set (newest-first, absolute paths); `memoryKey` = the canonical `memory/<file>` key (old `user-memory/` keys in replayed transcripts simply never match again) |
| `writer.ts` | Document write engine (SPEC 2026-10-07 P2-3): write/remove/reindex — the ONLY mutators of memory documents and MEMORY.md; one-way dep store/consolidate/importers → writer → memdir |
| `recall.ts` | **The RV deep module** (entries: `onUserMessage` / `abort` / `dispose`; AR1005-RC-01). All session state derives from the projection history on every call (D9): boundary check = real user messages since the last `compactionSummary` (RECALL_BOUNDARY_TURNS), hard dedup (RV-06), read suppression (RV-07), byte budget (RV-08), recentTools (RV-13). Skill-wrapper stripping + length hygiene (RV-02); latest-wins supersede (RV-05); render with byte-safe truncation + path note; `RecallDetailsV1` (frozen, contract-pinned). **AR1005-RC**: every request owns a generation + AbortController + wait timer — a newer message, `abort`, `dispose` or timeout invalidates it immediately; a LATE completion reads no history, delivers nothing, mutates nothing. `onUserMessage` has total-promise semantics (RC-02) |
| `selector.ts` | `llmSelector` over the shared llm.ts lane: manifest = `[type] key (age): description` newest-first capped at 200; precision-first prompt (empty list is a good answer); `previousUserMessage` context line; `resolveRecallModel` = exact provider/id → unique bare id → OFF (no session-model fallback, D3) |
| `policy.ts` | Single-layer policy block (`policyCompact`) + `buildPolicyInjection` (pinned section from the retired dir + project index, lane-clamped) |
| `guard.ts` | Write guard: G1 verdicts + the secret probe + the retired-layer block (any write into the user dir is rejected with a migration pointer) |
| `yield.ts` | `InjectionGate` — static + dynamic yield probes (fail-open: injection failures never block a turn, P3-ME-09) |
| `consolidate.ts` | Manual-only consolidation: `sendConsolidationDirective` (command) + `memory_consolidate` tool (batch must reduce bytes or file count) + `needsConsolidation` (diagnostics) |
| `automation.ts` | P3 automation state + settings (reads via `lib/settings` readJson, invariant 10); per-session state reset on `session_start` (A1); `isDirectiveTurn` seam keeps consolidation runs out of extraction accounting; queue drain runs records in PARALLEL (`Promise.allSettled`, ≤5) |
| `queue.ts` | Pending-extraction queue (spec 2026-10-07 P0-3 single-rename ownership protocol): shutdown stages the unextracted tail as ONE atomic JSON record under `~/.pi/agent/memory-queue/`; the next same-project `session_start` drains it in the background. BH-E2: expiry precedes routing skips; the shutdown handler runs ZERO LLM |
| `importers.ts` | Claude / Hermes import; everything lands in the project layer (user-typed sections become `reference`); never overwrites local edits |
| `store.ts`, `llm.ts`, `paths.ts` | V2 storage (atomic write primitive invalidates the scan cache), the single LLM lane, path resolution (`memoryWriteRoots` = project dir only — the retired user dir has no approval carve-out). `MemoryLayer` stays on the frozen MemoryOp shape; user-layer ops are skipped with an explicit reason |
| `lookup.ts` | On-demand half of the context diet: `memory_lookup(name)` (full text of one memory; name passes the write-side file-name whitelist) and `knowledge_search(query, scope)` — case-insensitive substring search over the memory dir, the `memory.searchRoots` setting and/or past sessions (via `session-recall.ts`); ≤2000 files scanned, ≤20 hits, hit lines only — never file bodies |
| `stats-entry.ts` | `cc-core-memory-stats`: one display-only entry per agent run with the context-diet counters (index bytes/rows, over-long descriptions, memory reads, lookup/search calls, recall injections, rewritten descriptions) — the data for the index A/B |
| `session-recall.ts` | Cross-session recall (`session_recall` tool): async bounded scan — ≤200 files, ≤1MB bounded partial reads, ≤8MB total, transparency footer |

## Invariants & gotchas

- **Fail-open**: any injection failure is swallowed at the boundary — a turn
  must never die because memory hiccuped.
- **Single layer**: the project dir is the only injected/recalled/written
  store. Do not reintroduce a user layer, a routing table or a layer-choice
  prompt — cross-project knowledge belongs in the user's own notes, and the
  guard now blocks user-dir writes outright.
- **Manual-only consolidation**: nothing ever sends a consolidation directive
  on a timer or a hook. The throttle/2-per-session/inFlight trigger state
  machine was deleted; `agent_settled` only clears the directive-turn flag.
- **Boundary recall**: selection runs only while fewer than
  `RECALL_BOUNDARY_TURNS` (2) real user messages exist since the last
  compaction; message_end/steer paths never select; a timeout is an abort +
  discard — never reinstate late delivery.
- **Session-stable injection**: never rebuild the policy block on a memory
  write; the rebuild keys are session start and the compaction count only.
- **Compact index, on-demand detail (context diet v3)**: index rows are
  `- slug — description` (the slug is the file stem, not repeated as a link).
  Descriptions are single-line noun phrases of at most `DESCRIPTION_MAX`
  (80) characters: `store.ts` rejects longer or multi-line ones on the LLM
  write paths and `consolidate.ts` on manual consolidation writes;
  `completeMemoryOpsCapped` (review, correction and queue drain) runs one
  bounded rewrite first so a batch's other facts survive. Imported and
  hand-written files bypass both gates: the index marks them `⚠`, `/memory`
  reports the count and session_start lists them once. `memory_lookup` and
  `knowledge_search` carry `exposure: "deferred"` — nothing in the tool list
  until `tool_search` activates them (codemode can call them regardless).
  `memory.searchRoots` (settings.json, absolute dirs, default `[]`) is the
  only way to point `knowledge_search` at a notes vault; core never assumes a
  vault path. The `cc-core-memory-stats` entry is the probe: compare
  memory-read + lookup + search counts per session before/after the diet.
- **Zero-LLM shutdown (spec 2026-10-03)**: `session_shutdown` only stages a
  queue record; extraction happens later on the drain lane.
- **Queue ownership protocol (spec 2026-10-07 P0-3)**: one staged record is
  held by at most one live worker — single same-directory atomic renames;
  re-read after claim; TTL + dead-owner probe for recovery. This is a
  retrying best-effort queue, NOT exactly-once. Mixed old/new core versions
  draining concurrently are NOT safe — upgrade by stopping the old processes
  first.
- **Persisted-once delivery (D1)**: a recall block enters the transcript at
  most once per real user message; hard dedup means one file surfaces at most
  once per compaction window (RV-06).
- **No model, no recall (D3)**: `memory.recallModel` unset/unresolvable →
  recall is entirely off. Never add a lexical or session-model fallback.
- **State from history only (D9)**: no closure state in the recall decisions —
  dedup / read / budget / boundary all re-derive from
  `buildSessionProjection().messages`.
- The importer treats local files as authoritative: imports never clobber
  local edits.
- Budget constants come from `lib/context-budget.ts` (`RECALL_*` are
  deliberately NOT on the published `CONTEXT_BUDGET` object — no consumer).

## Tests

`test/lib/memory*.test.ts` + `recall.test.ts` + `memory-llm-selector.test.ts`
(vitest: core wiring, RV machine + boundary + timeout-discard, RV selector,
V2 storage/automation/consolidate/migration) and `extensions/memory/tests/`
(node:test: B8 write-root, BH-R2 probe scope, BH-E2 queue, C9 snapshots).
The `pi-memory-recall` customType + details-v1 field set are pinned in the
contract suite (P0-CT-08); the real-package teardown behavior in
`pi-host-semantics.test.ts` ⑦.
