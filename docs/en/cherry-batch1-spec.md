# Batch-1 Implementation Spec: B1 truncation dual verdict + B2 live-JSONL reads + B3 anchor contract pin

Status: draft for adversarial review (flash, 1 round) · Parent plan:
docs/{en,zh}/cherry-derived-hardening-spec.md §B1/B2/B3 · 2026-10-20 ·
recon corrections merged (see §0)

---

## 0. Recon corrections (three deltas vs the parent draft; this spec wins)

1. **B1 consumers**: the core extension layer currently consumes turn_end's
   `message.stopReason` **nowhere** (grep-verified completion-level consumers:
   memory/llm.ts (error), classifier-client (aborted/error), goal.ts
   (aborted/toolUse at agent_end) — none consume length, none inside
   turn_end). B1's wiring point is therefore a **new stopReason
   consumption in the modes turn_end handler** — "truncation is never a
   silent success" takes the extension-layer form of a bus notification on
   a length terminal, not an accounting rework.
2. **B2 consumer scope shrinks**: two of the draft's three assumed
   consumers do not hold — memory-queue writes are tmp+rename atomic
   (queue.ts:224-225; no read-side tear window — NOT wired); observation-
   pack objects are content-addressed and immutable after write (NOT
   wired). **Real consumer**: goal-ledger.ts:122 (append-only JSONL live read; a
   genuine cross-process tear window when multiple pi processes share a
   project). review-run reads were re-audited: no `.jsonl` anywhere in
   extensions/review — :309 reads untracked source files (any format),
   :445 is a utf-8 whole-read, review-report readManifest is a single
   JSON.parse — none fit a per-line JSON adapter, none wired.
3. **B3 premise changed**: pi-ai 0.99+ already carries the anchor
   timestamp criterion (estimate.js:54-70 `latestPrefixTimestamp` — the
   upstream 8973ae2 fix Cherry backported is already in our dependency).
   B3 becomes "**pin the status quo against regression**".

---

## B1 · lib/truncation-verdict.ts + turn_end wiring

### Primitive (invariant 1: no extensions imports)

```ts
export type LengthStopVerdict = "context-clamp" | "output-limit" | "not-length";

export function classifyLengthStop(input: {
  stopReason: string | undefined;
  usage?: { output?: number } | undefined;
  modelMaxOutputTokens?: number | undefined;
}): LengthStopVerdict;

export function boundedRecoveryPolicy(v: LengthStopVerdict): {
  userNotice: string | null;   // bus notice copy; not-length → null
  isQuota: boolean;            // output-limit: true (suggest config change)
};
```

- Verdict (same source as the Cherry patch): `stopReason !== "length"` →
  not-length; `modelMaxOutputTokens` known and `usage.output >=
  modelMaxOutputTokens` → output-limit (quota/config); else →
  context-clamp.
- When `modelMaxOutputTokens` is unknown (extension layer cannot resolve
  the model object), conservatively return context-clamp — "a notice" beats
  "no notice"; the worst mis-verdict is slightly wrong copy.
- Interface: exactly two functions + a closed enum. Deletion test: remove
  it and every stopReason consumer re-writes verdict + copy — complexity
  disperses back. Passes.

### Wiring (modes/index.ts turn_end)

- After the stats segment, the turn_end handler adds:
  `classifyLengthStop({ stopReason: event.message.stopReason, usage:
  event.message.usage, modelMaxOutputTokens: ctx.model?.maxTokens (direct seam; narrow with
  isAssistant(event.message) first — TurnEndEvent.message is a union) })`.
- On a verdict ≠ not-length, publish a one-shot notice through the shared
  bus notification queue: context-clamp → "response truncated by context
  pressure — consider /compact or smaller task granularity (if replies
  are oddly short, check maxTokens first)";
  output-limit → "response hit the output limit — consider raising
  maxTokens or continuing the turn".
- **Per-turn dedupe**: at most one notice per turn_end (natural); every
  consecutive length turn notifies (the user should see each truncation;
  no cooldown — the queue's cap 20 is the bound).

### Contract test (next to test/contracts/, B1-C)

- **Behavior pin** (not an export probe — the symbol is unexported bundle
  internals): drive a real SessionManager with a truncated-message
  sequence (pi-host-semantics spawn pattern) and assert the truncated
  message's toolCalls all fail (failToolCallsFromTruncatedMessage in
  effect); plus the extension side produces no success-shaped terminal
  (the notice fires).
- Register the contract in the test/contracts/README.md table FIRST
  (invariant 6: contract → spec ID → consumer → removal condition), then
  write the test. If the behavior pin against the real package proves
  infeasible, take `test.todo` with the target Phase per P0-CT-13 —
  never a fake export probe.

---

## B2 · lib/live-jsonl.ts + goal-ledger / review-run wiring

### Primitive

```ts
export interface CommittedLines {
  lines: unknown[];          // complete lines, JSON.parse re-validated
  committedBytes: number;    // bytes before the last complete newline
  tornTailBytes: number;     // dropped half-line bytes (counted, not thrown)
}
export type LiveReadError =
  | { kind: "vanished" } | { kind: "symlink" }
  | { kind: "shrunk" } | { kind: "oversized" }
  | { kind: "unstable" };

export function readCommittedLines(path: string, opts?: { maxBytes?: number }): CommittedLines;  // throws LiveReadError
```

- Read method (isomorphic to Cherry's readForkPrefix incl. the bytes
  double-read, Node form): `openSync(path, O_RDONLY | O_NOFOLLOW)` —
  errno **ELOOP** (macOS & Linux alike) maps to `{kind:"symlink"}` →
  fstat (isFile, size ≤ maxBytes, default 8MB) → read loop to EOF →
  **post-read fstat re-check** (dev/ino unchanged; growth past
  committedBytes is tolerated — the guarantee is "the complete committed
  prefix as of the read"; a shrink → shrunk) → **bytes double-read
  TOCTOU re-check**: a second full read of the first `committedBytes`
  must be byte-identical (same-inode truncate-and-rewrite-longer is
  otherwise invisible to fstat); on mismatch re-read once, still
  mismatched → throw `{kind:"unstable"}` → truncate at the last complete
  `\n` → per-line JSON.parse (bad lines **skipped and counted in
  badLines**, not thrown — the goal ledger may carry hand-edit residue;
  "what upstream tolerates, we count, never silently drop").
- Torn tail dropped and counted (fail-open, per the goal constraint);
  symlink → symlink error (fail-closed — path-injection surface).

### Wiring

| Consumer | Wiring | Why |
|---|---|---|
| `goal-ledger.ts` read path (:122) | readFileSync+parse → readCommittedLines | multiple pi processes on one project = a real cross-process tear window. The status quo already parses per-line with a `malformed` count (no whole-read failure exists) — the REAL increments are the torn-tail accounting and the shrunk/oversized/symlink/unstable guards |
| memory-queue / observation objects | **NOT wired** (tmp+rename atomic / immutable) | no window; wiring them would be a false action |

- The ledger's mtime-cache semantics are unchanged (invalidation already
  exists); the adapter swaps only the read kernel — cache/append paths
  untouched. **Error mapping pinned at the consumer**: every LiveReadError
  → empty result + `ledgerReadCache.delete(path)` (the ledger never
  throws on read — fail-open preserved).

### Tests (test/lib/live-jsonl.test.ts)

Synthetic files pinning: normal read / torn tail (half-line dropped,
counted) / concurrent append (growth tolerated, old prefix complete) /
shrunk (throw) / symlink (throw) / over-cap (throw) / bad lines skipped
and counted / O_NOFOLLOW in effect. Plus one goal-ledger concurrent
write-read e2e (a fake append race yields a complete prefix).

---

## B3 · estimate anchor contract pin + ledger rule

- **Contract** (new pi-host-semantics case, registered in the
  test/contracts/README.md table per invariant 6): directly import
  `@earendil-works/pi-ai`'s `estimateContextTokens`. Note the criterion
  direction: `latestPrefixTimestamp` is the running max over messages
  BEFORE index i — an anchor is invalidated when a NEWER-timestamped
  message precedes the usage assistant in ARRAY ORDER (the compaction
  case). Use real ms values and COMPLETE Usage objects (usage is required
  on AssistantMessage; a missing usage crashes the estimator):
  ① `[user summary(ts=2000), assistant(usage.full=9500, ts=1000)]` →
  assert `lastUsageIndex === null` (the synthetic prefix invalidated the
  older anchor);
  ② append `assistant(usage.full, ts=3000)` → assert `lastUsageIndex`
  points at it (the anchor is back).
  Pins the `latestPrefixTimestamp` criterion's status quo — upstream
  semantic drift turns red (upgrade signal).
- **Rule**: DEVIATIONS records "any NEW core usage-derived path (cost
  accounting / OBS-09 savings counters / classifier context signals) must
  declare its anchor-invalidation semantics in an implementation comment
  (synthetic prefixes invalidate older usage)" — preventive; no runtime
  code added.

---

## Test matrix summary

| # | Case | Assert |
|---|---|---|
| B1-1 | classifyLengthStop table-driven (length+over / at-cap exact-equal / under / unknown cap / non-length) | five branches of the closed enum (>= semantics pinned at the boundary) |
| B1-2 | boundedRecoveryPolicy | not-length → userNotice null; both length branches carry guidance copy |
| B1-3 | FakePi turn_end stopReason=length | exactly one bus notice, copy per verdict |
| B1-4 | turn_end stopReason=normal | zero notices |
| B1-C | contract (or degraded unit + existence pin) | truncation never silently succeeds |
| B2-1..9 | live-jsonl: normal / torn tail / concurrent append / shrunk / symlink (ELOOP mapping) / oversized / bad lines / **vanished (ENOENT → LiveReadError thrown; the consumer maps to empty)** / unstable (double-read mismatch) | see §B2 tests |
| B2-9 | goal-ledger live-read cases (torn tail / bad lines / vanished / symlink; the true concurrent window is cross-process — same honesty note as B2-4/B2-9b) | empty-or-prefix, never a throw |
| B3-C | estimate anchor two states | lastUsageIndex invalidated / restored |

## Gates & process

Three gates exit 0 (contracts baseline 46+3todo → grows with the new
registration); DEVIATIONS/CHANGELOG in Chinese; bilingual docs in sync;
commit + push (SSH); both deployment copies synced
(scripts/sync-deploy-copies.sh). Review caps: spec ≤1, code ≤2.
