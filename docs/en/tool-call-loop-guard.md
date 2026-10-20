# Tool-call loop guard (D1 / D1b) + bash timeout copy (D2) — Spec

Status: draft for adversarial review (flash, 1 round) · Batch: provider-output
defense 2026-10-20 · Modules: `extensions/modes/loop-guard.ts` (new),
`extensions/modes/index.ts`, `extensions/bg-shell/index.ts`

## 1. Background

Incident (session `01a10ca2-dd4f`, 2026-10-05): a single assistant message
carried **755 parallel toolCalls**, **653 of them byte-identical**
(`bun run contracts 2>&1 | tail -30`). Downstream: 1,089
"response hit the output token limit" non-executions, 675 429
five-hour-limit aborts, a 14.2 MB session file, 67% of all tool failures
in the scanned corpus. Root cause: provider-side degenerate output near the
output-token ceiling (GLM/CPA repeats the same toolCall to fill budget).

Scope note (review R1 P2-1): pi already fails every toolCall of a
message whose `stopReason === "length"` (`failToolCallsFromTruncatedMessage`,
agent-loop.js:160-165) — in the cited incident the 1,089 non-executions
were that defense at work, and the 755 calls of the truncated message
would not have executed regardless. D1's real value is the
**within-budget degenerate batch**: a message that completes normally but
carries duplicated calls (the corpus also shows 8-message retry streaks
of identical commands across a turn, and providers may degenerate
without tripping the length limit).

Neither pi nor Claude Code has any cross-call duplicate defense (CC audit
2026-10-20: the only related guard is the Anthropic API's 400 on duplicate
tool_use **IDs**; identical-content duplicates with distinct IDs run
everywhere). A second exposure: a `codemode` script stuck in a loop can
re-issue byte-identical nested calls — those bypass any message-level
dedup by design.

## 2. Non-goals

- **Cross-turn repetition** is legal (polling, retries) — never blocked.
- **Per-response toolCall count cap** — agent-loop level, pi core; recorded
  as an upstream suggestion only.
- **codemode sandbox default timeout** (`timeout_ms` is unset by default,
  so a pure-JS `while(true){}` burns CPU forever with no tool_call events
  to gate) — upstream suggestion only, not implemented here.
- CC parity: no CC implementation exists to mirror; this is an original
  defense with no behavioral reference.

## 3. D1 — message-level duplicate suppression

**Fact base**: pi's agent loop finalizes the whole assistant message
(`message_end` carries the full message incl. every toolCall part and id)
*before* dispatching toolCalls one by one through the extension
`tool_call` gate (`agent-session.js`: `beforeToolCall` runs after the
message completes). Same-batch identity is therefore exactly knowable.

**Design**: new module `extensions/modes/loop-guard.ts`.

```ts
export interface BatchDupIndex {          // built on message_end(assistant ONLY)
  byId: Map<string, { key: string; isDupFollow: boolean }>;
}
// role === "assistant" messages only — message_end also fires for
// user/toolResult/custom messages; indexing those is harmless today
// (steer/custom/bash messages queue until the batch drains) but the
// filter is load-bearing and explicit.
export function indexBatchDupes(message: { role: string; content: readonly unknown[] }): BatchDupIndex | null;
export function checkBatchDup(index: BatchDupIndex | undefined, toolCallId: string): string | undefined;
// returns the block reason when toolCallId is a duplicate follower, else undefined
```

- `key = toolName + "\0" + stableStringify(input)`; JSON.stringify with
  sorted object keys (byte-identical inputs only — the incident showed
  exact repeats; near-duplicates are out of scope).
- **First occurrence passes, followers block** — "first" is fixed by
  message.content **parts order** (pi dispatches the gate serially in
  parts order on both the serial and parallel paths, agent-loop.js:
  366-420), regardless of whether the first is later blocked by another
  defense — a follower of a blocked first is still a duplicate and still
  blocked (the incident shape is provider noise, not intent).
- **Position: the very first step of the tool_call handler**, before
  `createPermissionAdjudicator().check()` — a defense, not a permission:
  **bypass mode does not exempt it** (same philosophy as the memory G1
  guard).
- **Fail-open**: `toolCallId` not found in the index (older pi versions
  with different event order, unexpected shapes) → allow. The guard can
  never be the reason a legitimate call is blocked.
- **Nested exemption is structural**: calls with `parentToolCallId`
  (codemode `executeTool`) never appear in message parts, so they simply
  miss the index → pass. No special-casing needed.
- Index lifecycle: REPLACE-ONLY — the handler keeps the last **assistant**
  batch index and only swaps it when a new assistant `message_end` arrives.
  Non-assistant message_ends (toolResult between sequential-dispatch gate
  calls; queued steer/custom/bash messages between parallel batches) never
  clear the held index — the sequential path emits a toolResult message_end
  between the batch's calls, so a naive "replace with null" would disarm D1
  for every sequential batch (review R1 P1-1). toolCallIds are unique per
  response; holding the last index cannot mis-block a fresh call.

**Block reason** (must guide self-healing, shown to the model):

```
This call is a byte-identical duplicate of call <firstId> in the same
response — the first copy has already been processed (executed or
blocked). Repeating it in one batch has no effect; if you need to run it
again, do so in your next turn with a fresh call.
```

## 4. D1b — parent-level circuit breaker

Codemode nested calls DO pass the gate individually (documented fact), so
the gate sees the per-parent call sequence.

```ts
export function createParentLoopBreaker(maxIdentical = 20, maxParents = 256, maxKeysPerParent = 64) {
  // Map<parentToolCallId, Map<key, count>>; parents over maxParents evict
  // oldest (FIFO); a parent over maxKeysPerParent stops admitting NEW keys
  // (they pass unrecorded — a stuck loop reuses few keys, detection intact).
  check(parentToolCallId: string, key: string): string | undefined;
}
```

- **maxIdentical 20** (the 21st identical call blocks; 20 pass): legal
  in-script retries are single-digit (network jitter — threshold
  adjustable, no corpus proof of the exact distribution); batch work
  varies arguments (identical args × 20 has no useful semantics — and
  for side-effect tools, blocking is a feature). The one known legitimate
  shape that could touch the cap — long same-arg polling inside a script
  — is already served by the repo convention "external waits go through
  bg-shell background tasks", not in-script loops.
- Block reason guides the script's author (the model): "the codemode
  script has issued N identical calls through this tool — vary the
  arguments or break the loop; further identical calls are blocked."
- Memory bound: `maxParents` 256 with FIFO eviction (insertion order);
  defense state is not precious — eviction is harmless.
- No cleanup on parent end: idle parents cost one Map entry until evicted.

## 5. D2 — bash schema timeout copy

`extensions/bg-shell/index.ts` bash tool schema, `timeout` parameter
description gains:

> Optional timeout in seconds. Omitted = the command auto-backgrounds
> after ${PROMOTE_MS / 1000} s and keeps running (you are notified on
> completion; commands starting with `sleep` are exempt). An explicit
> timeout hard-caps the run instead — use it only when a stale command
> is worse than a killed one.

(Copy-only change; no behavior.)

## 6. Test matrix (FakePi / node:test in `extensions/modes/`)

| # | Case | Assert |
|---|---|---|
| 1 | batch: 3 identical bash calls in one assistant message | #1 passes; #2 #3 blocked with the duplicate reason |
| 2 | batch: 2 identical + 1 different-args call | only the follower blocked |
| 3 | cross-turn: same tool+args next turn | passes (fresh index) |
| 4 | nested: 25 identical `executeTool` calls under one parent | first 20 pass; 21st+ blocked with the loop reason (maxIdentical = passes allowed) |
| 5 | nested: 20 identical | all pass; 21st would block (threshold boundary: maxIdentical = passes allowed) |
| 6 | nested: different args × 30 under one parent | all pass (key differs) |
| 7 | fail-open: unknown toolCallId | passes |
| 8 | bypass mode + batch duplicate | still blocked (defense ≠ permission) |
| 9 | two different parents each 10 identical | all pass (counters independent) |
| 10 | reason copy asserts substring "byte-identical duplicate" / "codemode script" | guide-to-heal wording present |
| 11 | stopReason="length" message with duplicated parts (interop) | pi's truncation defense fails them all; loop-guard stays quiet (no double reason), toolCall/toolResult pairing intact |
| 12 | first of a duplicate pair blocked by plan gate; follower arrives | follower still blocked with the duplicate reason ("already been processed") |

## 7. Upstream suggestions (recorded in DEVIATIONS, not implemented)

1. codemode sandbox: default `timeout_ms` (e.g. 300 s) unless the script
   opts out — closes the pure-JS infinite loop hole the gate cannot see.
2. Agent loop: per-response toolCall count cap (e.g. 50 + notice) —
   defense in depth at the layer that owns message shape.
