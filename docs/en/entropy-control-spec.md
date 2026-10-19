# Pi Extension Entropy-Control Plan (2026-10-19 · revised · includes implementer review)

> Status: confirmed, the execution spec for three goals. Strictly sequential G1 → G2 → G3 (all touch guard/index.ts).
> This is the English mirror of the authoritative Chinese spec: [entropy-control-spec.md](../zh/entropy-control-spec.md)

## Summary

Forensics located the entropy in three places: memory writes and consolidation (no version history, wrong layer, silent invalidation), the agent's ability to modify its own permissions and rules, and the auditor's boundary relying on prompt self-discipline. The goal flow itself is healthy: of 20 goals, 4 passed after one rejection; none spiraled in audit loops.

## Two corrections to earlier assumptions

1. **Consolidation runs on the main model, not a small one.** It is a directive injected into the live session; the main model reads all files then calls memory_consolidate. The small model is only the recall selector. The risk is cost/context pollution of dozens of file reads with no diff-level verification.
2. **Audit's missing deterministic evidence is less severe than assumed.** The auditor re-runs tests itself; the real failure mode is enumerating deliverables incompletely.

## Verified findings (implementer, 12 checks)

- **Holds**: auditor session `extensions: []` (goal-auditor.ts:183) — permission-modes rules do not apply there; memory has no git, age is pure mtime (memdir.ts:255), consolidation rewrites reset age; the guard only checks memory_consolidate, direct write/edit bypasses it (guard.ts:43 already dispatches write/edit but only probes secrets); the 10-03 wrong-directory mechanism persists; `PI_SUBAGENT_CHILD` is consumed nowhere in memory; waitMs=0 parked (memory/index.ts:15).
- **Corrected**: the rule model has no Write/Edit path patterns (rule-families has only mcp-gov/web-gov) — "add ask rules" means a new rule family; go through the guard channel instead.
- **Unproven**: consolidation reason printed twice (grep finds one consumer); revisit on repro.

## Implementer review (Preflight results, 2026-10-19)

### Goal 1 Preflight

- **P1 ✅ (better than assumed)**: the guard already intercepts write/edit — `extensions/memory/index.ts:355-368` tool_call handler returns `{block, reason}`; `extensions/memory/guard.ts:43` dispatches by toolName. Edit's post-application content is simulated in-guard (read original + apply each `edits[].oldText→newText`).
- **P2 ✅**: `memdir.ts:60 splitFrontmatter` (null on failure) is the index's source of truth (memdir.ts:112); reuse is cycle-free. Skip set per `isMemoryFile` (memdir.ts:45-51).
- **P3 ✅**: `memoryDir(ctx)` / `userMemoryDir(ctx)` / `gitCanonicalRoot(cwd)` (paths.ts:50, memoized).
- **P4 ✅**: `process.env.PI_SUBAGENT_CHILD`.
- **P5 ✅**: ObservationPack `THRESHOLD_BYTES = 10*1024` (observation-pack/observation.ts:15, exported); then_run recognition — action-fusion/index.ts schema self-check :128-135; executor line recorded during implementation.

### Goal 2 Preflight

- **P1 ✅**: schema `{writes, deletes, reason?}` (consolidate.ts:88-89); guard chain = runConsolidation fail() sequence (:97-106).
- **P2 ✅ (natural isolation)**: `listMemoryFiles` is non-recursive — a sidecar outside the memory dir can never be scanned.
- **P3 ✅**: age's single source = recall.ts:144-147.
- **P4 ✅**: memory already hooks session_start (index.ts:226) and agent_end.
- **P5 ✅ (pinned by test during implementation)**: splitFrontmatter parses a fixed field set, lenient on unknown fields; G2's first test = "a file with created is indexed by eligibleMemories".

### Goal 3 Preflight

- **P1 ⚠️ half**: auditAttempts counting = goal.ts:1470-1471; the exact "300-char truncation" site is recorded during implementation.
- **P2 ✅**: [Cn] is a new convention, added to the goal prompt + parser; "no numbered criteria → no reminder" is the fallback.
- **P3 ✅ non-blocking**: details v1 carries delivery/elapsedMs; the aggregation script self-reports sample size.

### Adjustments folded in

1. **C1 same-source judgment**: guard calls `splitFrontmatter + isMemoryFile` directly; test asserts "guard passes ⇒ eligibleMemories indexes".
2. **C11 deletes union type**: `string | {file, reason}` — old shape keeps working.
3. **C7 doc landing**: AGENTS.md commands table + docs/en+zh section.
4. **C20 reminder channel**: `sendMessage({deliverAs:"followUp", triggerTurn:false})`; audit starts regardless.

### Record-during-implementation items

- G3-P1: exact file:line of the 300-char truncation.
- G1-P5: action-fusion then_run executor file:line.

### Constraints the plan missed

1. **Guard ⊥ permission mode**: bypass does not exempt the guard (event-interceptor semantics); document it.
2. **Child-session hooks**: whether subagents trigger session_start/agent_end is untested — snapshots/post-checks are idempotent; C6 relies only on env.
3. **Snapshot startup cost**: ~100KB sync copy + hash < 5ms; fail-open is mandatory.
4. **C5/C14 read files directly** — never through the memdir cache (mtime granularity misses content-level changes).
5. **Automation-ops write paths** (not via write/edit tools) are outside G1; the store guarantees them itself.

---

## Goal 1: memory write guards & self-modification protection

**Objective**: within the existing tool_call guard channel, deterministically intercept the three known memory-write incident classes and agent self-modification of its own permission/rule/settings files, with actionable messages; plus child-session write ban and an upgrade canary. No new rule family; consolidation untouched.

### Success criteria

1. **[C1] Frontmatter validation**: a write/edit inside a memory dir whose result the index's own judgment (splitFrontmatter + isMemoryFile, same source) deems unindexable (no frontmatter / missing required / invalid value) is blocked with the specific problem named; files the index already skips are out of scope. Tests: one block each for the three cases + legal pass + skipped-file pass + guard-pass ⇒ eligibleMemories indexes it.
2. **[C2] Wrong directory**: a path outside both memory dirs matching `**/memory/*.md` whose content carries memory frontmatter (name+description) is blocked; the message lists both correct absolute dirs. Tests: the 10-03 repro (repo-root memory/x.md) blocked; an ordinary doc at the same path passes.
3. **[C3] USER-layer misfiling**: writing the USER layer whose content contains the current git root absolute path (incl. `~/` form) without `paths:` in frontmatter is blocked; short repo names only warn once. Tests: three cases.
4. **[C4] Self-modification protection**: write/edit targets on protected paths (permission-modes.json, global & project rules dirs, settings; the list hard-coded in a standalone file separate from the memory guard) are blocked; the message says to edit manually. Tests: one block per path + plugin-source-repo writes pass. Bypass does not exempt (documented).
5. **[C5] Bypass detection**: session_start records a sha256 baseline of protected files (direct reads, not the memdir cache); agent_end recomputes; a mismatch notifies once via UI (no block). Tests: direct fs write → notice; untouched → silent.
6. **[C6] Child-session write ban**: with `PI_SUBAGENT_CHILD=1`, writes into either memory dir are blocked with a "relay to the parent agent" hint. Tests: set/unset.
7. **[C7] Upgrade canary**: a tool result over THRESHOLD_BYTES (imported constant) asserts the placeholder appears; a then_run call asserts recognition; failure messages name the degraded mechanism. AGENTS.md commands table + docs/en+zh say to run it before upgrading Pi.
8. **[C8] Three gates green.**

**Out of scope**: new rule family or permission-modes rule-semantics changes; bash command parsing; touching consolidation, snapshots, auditor, goal flow; recall algorithm or child-session recall behavior; reason wording changes.

## Goal 2: memory snapshots & consolidation provenance/age

**Objective**: path-independent rollback points for both memory layers, traceable consolidation deletions, and merge results that no longer reset fact age. No git.

### Success criteria

1. **[C9] Snapshots**: session_start full-snapshots both layers to a sidecar outside the dirs (fail-open); skip when identical to the newest; keep 10 (named constant). Tests: first start 1 / unchanged 1 / changed 2 / 11th evicts oldest.
2. **[C10] Snapshot isolation**: files inside snapshots never appear in the index or recall. Pinned by test.
3. **[C11] Provenance validation**: every deleted file in memory_consolidate must appear in some write's `merged_from` or carry a per-file reason (`deletes: string | {file, reason}` union; old shape migrates free), else the whole call is rejected listing the orphan names. Tests: three cases.
4. **[C12] created preserved**: consolidation output carries `created` (oldest of merged_from sources' created or mtime; else the overwritten same-name file's; else omit) + `consolidated_at` (ISO). Test: merging 60-day-old + 10-day-old → created is 60 days ago.
5. **[C13] Unified age**: created wins when present and mtime ≤ consolidated_at (+seconds tolerance), else mtime; legacy files fall back to mtime; manifest display and staleness hint (recall.ts:144 rewiring) share one function; sort stays mtime. Tests: three branches + legacy regression.
6. **[C14] Post-check**: at agent_end, vs this session's start snapshot — ≥3 files deleted or ≥30% bytes dropped without a memory_consolidate call notifies once (no block, no rollback). Tests: fs-delete-3 → notice; normal consolidation → silent.
7. **[C15] Rollback docs**: bilingual docs with concrete restore commands.
8. **[C16] Gates green**; must-shrink / frontmatter / secret invariants unchanged.

**Out of scope**: git; consolidation trigger thresholds or directive wording; recall; sort order; auto-rollback; backfilling created for legacy files.

## Goal 3: audit light improvements & recall data aggregation

**Objective**: more reliable audit report re-injection, a non-blocking completeness reminder, documented auditor permission status, and offline recall latency data from existing transcripts. No audit verdict-logic changes; waitMs default unchanged.

### Success criteria

1. **[C17] Permission status documented**: auditor session `extensions: []` (goal-auditor.ts:183) → permission-modes rules do not apply; residual risk = unruly bash in the auditor; why the read-only profile is deferred (tests need tmp writes). With file:line.
2. **[C18] BLOCKERS format**: the audit prompt requires a fixed-format block at the end (`- [Bn] one line` ≤120 chars; `- (none)` when clean). Parser tested for conformant/empty/missing.
3. **[C19] Re-injection uses the list**: persistent re-injection prefers parsed BLOCKERS, each item whole, per-item truncation marked "k more"; parse failure falls back to the old prefix truncation (300-char site recorded during implementation). Three tests.
4. **[C20] Missing-item reminder (non-blocking)**: when a completion request lacks a `[Cn]` line for some numbered criterion, one followUp (triggerTurn:false) reminder lists the missing numbers; audit starts anyway; no reminder when the objective has no numbered criteria. Tests: missing C3 → reminder contains C3 and audit starts; full coverage → none.
5. **[C21] Third-attempt notice**: at auditAttempts = 3 (named constant) a one-time UI notice; no blocking. Pinned by test.
6. **[C22] Recall aggregation**: an offline script reads session jsonl and emits a Markdown report (delivery distribution, elapsedMs p50/p90, delivered-turn-count distribution, sample size — stated when insufficient) + a data-backed recommendation on waitMs. Default untouched.
7. **[C23] Gates green.**

**Out of scope**: blocking audit on missing evidence; read-only profile / OS sandbox; waitMs default or recall logic changes; audit verdict/retry changes; reason-printing changes.

## Deferred: evaluation set

Live A/B ≈ $150+ per round and depends on G2 snapshots to freeze memory fixtures. Skip for now: C22 answers recall latency for free; placeholder/obs_recall rates are also offline-computable. Decide after the data.

## Hard constraints

① Run each batch's Preflight first; stop and report on any failure. ② Stay within success criteria/boundaries; report before expanding. ③ Completion summary per `[Cn]` with file:line + test name + output excerpt. ④ Unmet items get `[DEVIATION Cn]` with reasons — no silent downgrades. ⑤ Final full test suite + type check pasted. ⑥ Thresholds (10 snapshots / ≥3 files / ≥30% bytes / 3rd attempt) are named constants. ⑦ Defaults inherited: protected paths block (not ask) until friction says otherwise; child sessions ban writes only. ⑧ G1 → G2 → G3 strictly sequential.

On a blocker (preflight failure, unsolvable spec/code conflict, unrelated new-red baseline): stop and ask the user.
