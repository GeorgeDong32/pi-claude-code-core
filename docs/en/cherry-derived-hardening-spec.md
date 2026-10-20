# CherryStudio-Derived Hardening Backlog (Spec draft · for review)

Status: **DRAFT — not chartered, not implemented** · Source: three-way
read-only analysis of CherryDev `src/main/ai/runtime/pi/` (~9.2k lines +
pnpm patch ledger), 2026-10-20 · Items await per-item user ruling, then
follow the usual spec-review → implement → code-review pipeline

---

## 0. Shape contrast (why we adapt, not copy)

Cherry **embeds the SDK** (the host owns credentials/model catalog/approval
UI; pi is a trimmed engine). We are a **parasitic extension package**
(living in the seams pi itself provides). Every item below names its
"extension-shape equivalent" — where the same problem lands for us. The
codebase-design test runs throughout: a deep module = small interface +
deep implementation; each item passes the **deletion test** first (delete
it — does complexity concentrate back, or just relocate?).

---

## B1 · Length-truncation dual verdict + bounded recovery (Strong ★★★★★)

**Cherry**: `piLengthRecovery` (a pnpm patch, backport of
earendil-works/pi#7540) — `usage.output < maxTokens` ⇒ context clamp (one
compact-and-retry; the guard resets only on a successful response), `>=
maxTokens` ⇒ quota limit (error terminal with guidance copy); the retry
context drops the truncated tail while history keeps it.

**Our shallow face**: our `stopReason` consumers are scattered (modes gate
signals, observation projection, goal/review accounting) with zero
distinction for `length`. In the 653-duplicate incident the only wall was
pi's own `failToolCallsFromTruncatedMessage`; we have no "context pressure
vs quota problem" verdict and no "truncation never silently succeeds"
guard.

**Design (deep-module shape)**:

```
lib/truncation-verdict.ts                 ← new lib primitive (invariant 1: no extensions imports)
  interface: classifyLengthStop(stop: { stopReason, usage, model }):
              "context-clamp" | "output-limit" | "not-length"
  + boundedRecoveryPolicy(verdict): { retryOnce: boolean; terminalError?: string }
```

- Two functions + one closed return enum on the interface; the
  implementation carries the verdict math, maxTokens resolution
  (thinking-shares-the-cap semantics), and the guidance copy. **Deletion
  test**: remove it and every stopReason consumer re-writes the verdict —
  complexity disperses back. It earns its keep.
- Consumption (extension-shape equivalent): modes / observation /
  accounting call `classifyLengthStop` at their convergence points;
  `context-clamp` becomes an early-compaction signal (pairs with the
  user's GLM-500K preference), `output-limit` guarantees an error
  terminal.
- **Test surface**: Cherry-style streamFn injection, as a synthetic
  contract next to pi-host-semantics in `test/contracts/` — inject a
  length-truncation sequence into a real pi session and pin "truncation
  is never a silent success". The interface is the test surface.

**Upstream facts depended on**: stopReason=length has two causes; pi's
failToolCallsFromTruncatedMessage fails all of the truncated message's
toolCalls.

---

## B2 · Committed-prefix reads of live JSONL (Strong ★★★★★)

**Cherry**: `piFork.readForkPrefix` — O_NOFOLLOW + ≤512MB cap + read-until
full + post-read inode/dev re-check (not a symlink, size not shrunk) +
keep only the last complete newline + **per-line JSON.parse re-validation**
("the SDK tolerates malformed trailing lines; the host does not silently
omit history") + bytes double-read TOCTOU re-check.

**Our shallow face**: memory-queue drain (shutdown may still be writing
while session_start drains), observation-pack originals reads, review run
file reads — all have the "torn by a concurrent append" window, each with
its own hand-rolled readFileSync and no shared primitive.

**Design**:

```
lib/live-jsonl.ts
  interface: readCommittedLines(path, opts?: { maxBytes? }):
             { lines: unknown[]; committedBytes: number }
  // throws LiveReadError (closed enum: vanished / symlink / shrunk /
  //                        oversized); a torn tail half-line is DROPPED and
  //                        counted, not thrown — fail-open boundary.
```

- One authority + adapters per consumer (three consumers = the
  "two-or-more adapters" test for a real seam).
- **Deletion test**: remove it and all three sites re-implement tear
  protection — passes.
- Test surface: synthetic files under concurrent append, pinning the
  inode re-check / half-line drop / cap behaviors.

---

## B3 · Usage-anchor "synthetic-prefix invalidation" rule (Worth exploring ★★★★☆)

**Cherry**: `piCompactionBudget` (pi-ai patch) — `estimateContextTokens`
prefers the last valid assistant's `usage.totalTokens` as anchor, but
**any message inserted after it (a compaction summary, typically)
invalidates the anchor** (`timestamp >= latestPrefixTimestamp`). Before
the fix, a stale post-compaction usage clamped maxTokens to 1 → "looks
done, actually empty response" (#19447/#19457).

**Our shallow face**: `lib/context-budget.ts` is fixed character budgets
(no usage math), but every usage-derived path (cost accounting, OBS-09
token-savings counters, classifier context signals) lacks the rule. Our
per-request rules/memory injections ARE synthetic-prefix producers.

**Design**: no new module yet (YAGNI — no live incident). Two moves:
1. **Pin the criterion in contracts**: a pi-host-semantics case pinning
   pi-ai's estimate anchor semantics (red on upstream change — an upgrade
   signal, zero production code).
2. **Accounting-path audit note**: DEVIATIONS records "any NEW
   usage-derived path must declare its anchor-invalidation semantics" —
   preventive rule, not implementation.

---

## B4 · MCP input-side progressive disclosure (Worth exploring ★★★★☆ · large)

**Cherry**: `piCodeMode.ts` four-tool face — `tool_search` (BM25
k1=1.2/b=0.75, camelCase tokenization, returns **TypeScript declarations**
not JSON schemas) / `tool_describe` / `tool_call` / `tool_exec`
(worker_threads, not QuickJS; 60s cap). Schemas stay out of context until
retrieved.

**Our shallow face**: observation-pack covers the **output** side; the
**input** side (tool declarations eating context) has no economics layer
— mcp-gov governs URL/shape, not volume. pi's own `codemode` deferred
exposure (MCP default = callable-but-not-declared) shows upstream moving
the same way.

**Direction (interfaces deferred — needs a data recon first)**: measure
per-server declaration token cost at MCP attach → if material (≥1K
tokens/server), add "declaration diet" to mcp-gov: description
compression + on-demand disclosure toggles reusing pi's five exposure
tiers (no new mechanism invented). **Prerequisite**: one real-machine
declaration-volume survey before deciding.

**Diff vs Cherry**: they built their own retrieval (no pi codemode
trust); we can ride pi's native exposure tiers — the extension-shape
answer is cheaper.

---

## B5 · Effort write-time ladder validation (Worth exploring ★★★★☆)

**Cherry**: `modelInjection` projects model efforts into an 8-slot
`thinkingLevelMap` (undeclared slots `null`; toggle-only models get no
all-null ladder; `off`↔`none` mapping) — preventing pi blindly sending
`medium` to a strict endpoint (Kimi K3 #20029).

**Our equivalent**: we cannot touch registerProvider (extension shape),
but the effort owner chain (`lib/effort-owner.ts`, the single
`setThinkingLevel` authority) can do the same thing **at write time**:
read the actual efforts set from the model registry, clamp unwritable
levels to the nearest supported one + a status-line note; `off` stays
always-legal (existing finding). **Seam position**: inside effort-owner —
the interface does not change (still the single write authority), depth
increases.

---

## B6–B8 · Preparatory investments (Speculative ★★★☆☆ · recorded, not built)

| # | Item | Cherry mechanism | Our landing (if built) | Deferred because |
|---|---|---|---|---|
| B6 | willRetry sanitization + single-terminal convergence | auto-retry's intermediate agent_end clears stopReason/error, holds the turn open | goal/review agent_end accounting gains a "clear-before-settle on willRetry" guard | pi 1.3.0 does not send us willRetry yet — first pin the event's existence in pi-host-semantics; upgrade when it appears |
| B7 | Undelivered-steer requeue | turn-end splice + clearQueue + `steer-undelivered` re-queue | dynamic steer injection contract gains "the host owns requeue" | our steers ride sendMessage, not the steering queue — different shape; confirm the loss window exists first |
| B8 | realpath normalization + "convenience, not containment" posture | realpath against symlink escape; `file://` ambiguity fails closed | modes auto/bypass allowlist `scopeMatches` upgrade | audit whether scopeMatches is purely lexical first; the posture copy (never claim a sandbox) can land in docs now |

---

## Appendix A · Upstream fact sheet (Cherry code archaeology)

| Fact | Source | Meaning for us |
|---|---|---|
| `streamSimple` is synchronous; async credentials need the `lazyStream` factory bridge | piTransportStream | required recipe if we ever wrap the provider layer |
| pi's steering queue does not drain at turn end | PiRuntimeConnection | steer semantics boundary |
| pi `exports` has only an `import` condition (CJS consumers break) | piSdk.ts | stay ESM-only; never ship a CJS outlet |
| session filenames `{timestamp}_{token}.jsonl`; `_` is legal IN the token — split on the FIRST `_` | piSessionFile | parsing discipline for sessions-dir scans (same family as our `--X--` double-dash quirk) |
| "id valid but file not flushed = initializable" | resolveSessionManager | lazy-flush tolerance semantics |
| pi-ai is reused by dsh as a cross-runtime wire-protocol library | compositionBuilder | pi-ai's blast radius exceeds pi itself — upgrades take care |
| `onPayload` composition order: pi first, respect overrides, adapter last | piTransportStream | chaining discipline for payload rewrites (CPA forceAdaptiveThinking class) |

## Appendix B · Reverse confirmations (what we already do right — don't touch)

- Single authorities (effort-owner / mcp-shape / canonicalize) + a pure
  data-snapshot bus, vs Cherry's service location + three parallel
  drivers (two hand-written modelInjections) — we avoided that shape debt.
- Contract suites run against real published packages continuously, vs
  their one-shot Phase 0 bundling spike.
- DEVIATIONS as the single ledger, vs their "patches carry PR numbers,
  delete when upstream merges" — same spirit; cross-referenceable.
- Their `noExtensions: true` trust stance is the premise that makes core
  legitimate — the no-timers / no-polling / pure-data-snapshot
  discipline is the moat; no batch may break it.

---

*Underlying analysis: three subagent reports at
`~/.pi/agent/sessions/…/subagent-artifacts/{93bea373,abd73e15,8334570c}*_output.md`*
