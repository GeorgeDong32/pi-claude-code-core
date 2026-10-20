# Batch-2 Implementation Spec: B5 effort write-time clamping + B6 willRetry contract pin + B8 path-matching audit & posture

Status: draft for adversarial review (flash, 1 round) · Parent plan:
docs/{en,zh}/cherry-derived-hardening-spec.md §B5/B6/B8 · 2026-10-20 ·
recon corrections merged (see §0)

---

## 0. Recon corrections (three deltas vs the parent draft; this spec wins)

1. **B5 gap narrowed**: the effort command paths (/effort and the --effort
   flag, index.ts:76-86/247-258) ALREADY validate the supported set — but
   **reject-style** (error notice + no write); the goal asks for
   **clamp-style** (nearest supported + status-line notice). The **profile
   path has zero validation** (profile-apply.ts:146 `setFromProfile`
   writes directly; PROFILE_EFFORT_LEVELS only checks syntax).
2. **B6 premise fixed**: devDeps pi-coding-agent 1.2.0's **AgentEndEvent
   has no willRetry field** (types.d.ts:748-751 — messages only);
   willRetry lives on the **three compaction events**
   (session_before_compact/session_compact/session_compact_failed;
   semantics = "overflow recovery will retry the aborted turn"). The
   agent_end.willRetry Cherry consumes is their own driver-layer synthesis
   or a version delta — we pin against 1.2.0 facts.
3. **B8 premise fixed** (R1 P1-2: the blanket "lexical = conservative"
   claim was WRONG for two named consumers): the modes main boundary
   `isOutsideCwd` (path-safety.ts:28-60) **already has** per-segment
   realpath symlink escape probing. The parent draft's "scopeMatches
   upgrade" lands on `lib/rule-text.ts isInsideDir` (pure lexical) and
   `memdir scopeMatches` (pure glob) — whose consumers split by DIRECTION:
   - `guard.ts:63-64` layer checks: inside → MORE checks — lexical IS
     conservative here ✓ (keep lexical).
   - `protected-paths.ts:95` (G1-C4): inside → BLOCK — an alias symlink
     BYPASSES the block (miss = allowance). realpath would only TIGHTEN.
   - `paths.ts:126 isMemoryWritePath` → modes carve-out (index.ts:389):
     inside → SKIP the approval dialog — a symlink alias physically
     pointing outside is an ESCAPE in the fail-open direction (R1 P1-2's
     headline). This is the one consumer where the realpath upgrade
     genuinely closes a hole.
   - `memdir scopeMatches`: recall scoping, miss → hide — convenience ✓.
   B8 therefore: per-consumer audit table (directions stated honestly) +
   ONE realpath tightening at the write-root carve-out + conservatism
   pins where lexical is genuinely conservative + posture copy.

---

## B5 · Effort write-time clamping (profile path gains validation; command paths move reject→clamp)

### Pure function (effort.ts — one clamping semantic shared by both paths)

```ts
export function clampToSupported(
  level: EffortLevel, model: EffortModel | null | undefined,
): { level: EffortLevel; clamped: boolean };
```

- `off` is always legal (existing finding); `level ∈
  getAvailableThinkingLevels(model)` → unchanged; otherwise clamp to the
  **nearest legal level in ladder order** (off/minimal/low/medium/high/
  xhigh/max; equidistant → the LOWER side — lower tiers spend fewer tokens
  and fail smaller, the conservative direction). An unresolvable model
  (null/undefined) → return **undefined** (NOT a passthrough): callers
  keep the status-quo reject — today `/effort high` with a null model is
  refused, and clamp-style must not widen that (R1 P2-1). There is no
  nearest tier to compute without a model; deferring to "first model
  resolves" would be a silent behavior change.
- **Deletion test**: remove it and both paths re-implement "nearest level"
  — passes.

### Wiring

| Path | Status quo | Becomes |
|---|---|---|
| profile-apply `applyForMode` | `setFromProfile(effort)` direct write | clamp then write + info notice "profile X's effort Y is not supported by <model>, clamped to Z" (info level — profile switches are routine, not error-worthy) |
| /effort command (index.ts:76) | reject-style error | clamp-style when the model resolves (write the clamped value + notice "Y unsupported, set to Z; available: …"); null model keeps the reject |
| --effort flag (index.ts:249) | reject-style warning | same (startup flag, same semantics) |

- effort-owner (invariant 2's single write point) is **untouched** —
  supported-set validation is the CALLER's job; the owner keeps arbitrating
  only the priority chain. The env-pin path is not clamped (a pin IS an
  explicit user declaration, and pin-refuses-explicit-writes already
  exists).

### Tests (appended to the existing extensions/effort node:test suite)

| # | Case | Assert |
|---|---|---|
| B5-1 | clampToSupported table-driven (supported unchanged / off always / single-tier model / equidistant→lower / null unchanged) | six branches |
| B5-2 | profile: single-tier model + profile=medium | the clamped level is written + an info notice mentions the clamp |
| B5-3 | /effort command: unsupported tier | the clamped level is written + the notice lists candidates |
| B5-4 | supported tier command | direct write, zero notice (no status-quo regression) |

---

## B6 · willRetry contract pin + activation-review record (guards dropped per R1 P1-1/P2-3)

### Contract (appended to pi-host-semantics, registered as CB2-B6 first)

1. **Compile-time type pin**: `AgentEndEvent` currently has no willRetry —
   pinned as a COMPILE-TIME assertion (not a runtime `in` probe on a
   self-built sample, which could never see type-level additions):
   ```ts
   type AgentEndHasWillRetry = "willRetry" extends keyof AgentEndEvent ? true : false;
   const _pinAgentEndHasNoWillRetry: false = null as unknown as AgentEndHasWillRetry;
   ```
   The red light turns on in the `bun run check` contracts tsc pass
   (vitest/esbuild do not typecheck — the runtime suites stay green).
2. **Compaction-event presence pin**: the three compaction events carry
   willRetry with the overflow-retry semantics (runtime-checkable — import
   the event types and assert the field exists on the declared shape).

### Guard landing — DROPPED (R1 findings)

- The parent draft's "review side" landing point **does not exist**
  (extensions/review has no agent_end handler; the only review-adjacent
  consumer, memory/automation.ts:536, is naturally idempotent — its
  counters clear before the pass, a retried agent_end sees reviewDue
  already false). The full agent_end consumer list (5 sites):
  effort/index.ts:294 (UI sync), goal/goal.ts:2130 (accounting —
  DELIBERATELY settles aborted in-flight usage "not silently lost";
  skipping a willRetry event would UNDER-count real usage, the opposite
  failure), modes/index.ts:1468 (idle reset — a genuine activation-review
  question), memory/automation.ts:536 (idempotent), memory/index.ts:546.
- Therefore: **no inline guards ship in this batch**. The contract pins
  the field's absence; the red light (field arrives upstream) triggers
  the recorded ACTIVATION REVIEW — per consumer: does its terminal
  settlement fold in pre-retry fragments? (goal: prove before
  suppressing; modes idle-reset: does a retry-pending agent_end falsely
  re-enable UI?) — and guards land only where that review says yes.

## B8 · Path-matching audit: per-consumer directions + one realpath tightening + posture copy

### Audit conclusion (per consumer — directions stated honestly)

| Consumer | isInsideDir verdict → effect | Direction of a lexical miss | Disposition |
|---|---|---|---|
| `modes isOutsideCwd` (main boundary) | already realpath-probed per segment | — | untouched |
| `guard.ts:63-64` layer checks | inside → MORE checks | stricter branch ✓ conservative | keep lexical + conservatism pin |
| `paths.ts:126 isMemoryWritePath` → modes carve-out (index.ts:389) | inside → SKIP approval dialog | **escape in the fail-open direction** (a symlink alias physically outside gets the memory carve-out) | **realpath tightening HERE** — after the lexical pass, realpath-resolve the write path and require it to stay inside a write root; a miss falls back to the normal approval path (fail-closed) |
| `protected-paths.ts:95` (G1-C4 self-modification block) | inside → BLOCK | alias bypass = a missed block (allowance) — realpath would only tighten | keep lexical this batch + record the alias-bypass note (hardcoded constant list; bypass needs a user-built symlink into their own memory dir — weak surface; revisit with G1 evidence) |
| `memdir scopeMatches` | recall scoping, miss → hide | convenience ✓ | keep + comment |

### Posture copy ("convenience, not containment")

- Lands in `docs/{en,zh}/modes.md` permission section: allowlists and path
  matching are a **convenience layer, not a sandbox** — the main boundary
  carries symlink escape probing and the memory write-root carve-out is
  realpath-tightened (this batch), but memory scoping (the paths field)
  is a recall filter, not access control; no security decision may rest
  on paths scoping.
- Pins: guard.ts lexical-conservatism test; the realpath tightening gets
  its own tests (alias-inside → NOT carved out; real-inside → carved out;
  realpath-unresolvable → approval path).

## Test matrix summary

| # | Case | Assert |
|---|---|---|
| B5-1..4 | see §B5 | clamping semantics + both wirings |
| B6-C1 | compile-time type pin (keyof-extends) | red only in check's contracts tsc pass when the field arrives |
| B6-C2 | compaction events carry willRetry | field present on the three declared shapes |
| B8-1 | guard.ts layer check: symlink-shaped path | lexical outside → the stricter branch (covered by the existing G1-C2/C3 cases in test/lib/memory-guard-g1.test.ts — no new test; recorded) |
| B8-2 | isMemoryWritePath realpath tightening: alias-inside (symlink pointing outside a write root) | NOT carved out → approval path (fail-closed) |
| B8-3 | realpath tightening: real-inside / unresolvable | carved out / approval path |
| B8-4 | docs posture copy | keyword anchor ("not a sandbox" / 不是沙箱) present in BOTH language files |

## Gates & process

Three gates exit 0 (contracts: baseline 47 passed + 4 todo → 49 passed +
4 todo after BOTH CB2-B6 cases); DEVIATIONS in Chinese; CHANGELOG in the file's prevailing language (English); bilingual docs in sync;
push (SSH, https+proxy bypass when the fake-IP TUN intercepts — hit during
batch 1); both deployment copies synced. Review caps: spec ≤1, code ≤2.
