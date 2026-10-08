/**
 * goal-lifecycle.ts — the pool/focus/drafting state owner (SPEC 2026-10-07
 * P2-2, decisions L1=A factory / L2=B full ownership / L3=B ports / L4=B
 * focused() getter / L5=B TransitionReport). The goal POOL, the FOCUS
 * pointer, the drafting intents, the per-turn flags, and the get_goal nudge
 * counters all live here.
 *
 * ENCAPSULATION CONTRACT (C5 follow-up, 2026-10-09):
 *  - Every value that ESCAPES the module (focused(), pool,
 *    confirmationIntent, TransitionReport.record) is a defensive copy —
 *    mutating a returned record/Map/intent never touches owned state.
 *  - Every record that ENTERS the pool (verb inputs, storage port results,
 *    restore/reconcile disk reads) is cloned at intake — callers and ports
 *    never keep a live alias into owned state.
 *  - The old silent primitives (adopt / replacePool / setFocusedSilently /
 *    removeFromPool) and the raw setGoal writer are MODULE-INTERNAL. The
 *    public surface is read projections + the closed event entry + business
 *    verbs, one per production path. There is no arbitrary patch entry.
 *
 * Verb effect table (pinned by goal-lifecycle.test.ts recording ports —
 * migrated line-for-line from the goal.ts implementations):
 *
 *  setGoal(next, {persist})   [internal] stop-loop(cond) · stop-clock(cond) ·
 *                             nudge reset(cond prev/next) · forget carry(gone
 *                             or completed) · release stale tweak gate(cond) ·
 *                             focus entry(cond reason+changed) · persist or
 *                             tool-sync · UI sync
 *  focus(goalId, reason)      stop-loop+clock on change · nudge reset(prev
 *                             + next) · release stale tweak gate(cond) ·
 *                             focus entry(always) · ledger focused/unfocused
 *                             · tool-sync · UI sync
 *  create(config)             setGoal(created, focusReason "created") ·
 *                             begin-clock · nudge reset · draft-applied(goal)
 *                             · ledger goal_created
 *  pause(ctx,{note})          user pause (/goal-pause, Esc, aborted turns):
 *                             merge → stamp paused/user + user note →
 *                             setGoal → ledger goal_paused · nudge reset
 *  pauseByAgent(ctx,{…})      the pause_goal TOOL path (never emitted the
 *                             pause ledger): merge → buildPausedByAgentGoal →
 *                             setGoal → nudge reset → turn-stopped
 *  resume(ctx)                /goal-resume: merge → stamp active → setGoal →
 *                             begin-clock · nudge reset · ledger goal_resumed
 *  activate(ctx)              the session-resume confirmation path: stamp
 *                             active → setGoal (no merge, no ledger — the
 *                             historical shape of that prompt's assignment)
 *  setUserNote(ctx,note?)     /goal-note: stamp userNote → setGoal
 *  applyUsage({tokens,cost,seconds})
 *                             the accounting result adoption (cloneGoal +
 *                             delta + updatedAt, the old accountProgress tail)
 *  recordAuditAttempt(ctx,n)  stamp auditAttempts + persist (the up-front
 *                             attempt count that must survive a rejected
 *                             audit and restarts)
 *  applyTweak(ctx,objective)  apply_goal_tweak's authoritative write: build →
 *                             writeActiveGoalFile (NOT persist — persist would
 *                             re-read the stale disk objective and clobber
 *                             the new one) → adopt canonical · state entry ·
 *                             draft-applied(tweak) · nudge reset ·
 *                             turn-stopped · tool-sync · UI
 *  complete(goal)             adopt the audited target (the audit-time
 *                             canonical record) → merge-from-disk → stamp
 *                             complete/agent → setGoal effects (halt · pause ·
 *                             forget carry · persist=archive · UI) → nudge
 *                             reset → pool removal → focus entry(null,
 *                             completed) · tool-sync · UI sync · ledger
 *                             goal_completed
 *  terminate(kind,{by,note})  archive(disk, stopReason=by) · ledger
 *                             goal_aborted(user kind note / agent reason) ·
 *                             nudge reset · setGoal(null) effects · persist ·
 *                             UI sync
 *  retireForReplacement(ctx)  the /goals|/sisyphus replace branch (never
 *                             emitted goal_aborted): merge → stamp paused/user
 *                             → archive (result discarded) → setGoal(null,
 *                             focusReason "cleared", persist)
 *  restore(ctx,{…})           loadState core: clear turn flags → pool from
 *                             disk (empty for child sessions) → resolve
 *                             session focus (legacy adoption) → migrated/
 *                             selected focus entry → drop completed records →
 *                             halt + pause · tool-sync · UI
 *  reconcileFromDisk(ctx)     pool re-read · focus repair · stale-gate
 *                             cleanup (child-session env guard stays with the
 *                             adapter)
 *  syncObjectiveFromDisk      the disk objective sync (readCtx fast path vs
 *                             fresh merge; value-compare so the clone
 *                             boundary cannot fake a change)
 *  persistRecord(ctx,readCtx) the old adapter persist(): stamp updatedAt →
 *                             sync objective → write/archive via the storage
 *                             ports → adopt the canonical result → state
 *                             entry · tool-sync · UI
 *  refreshDisplayFromDisk     the turn-end display refresh: sync objective →
 *                             (if changed) stamp + state entry · tool-sync ·
 *                             UI
 *
 * Event entry (each tag's production source + interface test):
 *  turn-start     pi turn_start — resets both per-turn flags.
 *  turn-stopped   the four REAL stop executes (pause_goal / abort_goal /
 *                 update_goal=complete / apply_goal_tweak, D3=A) — sets
 *                 turnStoppedFor.
 *  tool-call      pi tool_call — returns the post-stop block verdict,
 *                 counts get_goal nudges, credits meaningful progress
 *                 (clears the goal's nudge counter, raises the work flag).
 *  usage-accounted turn_end / tool_execution_end / tool_result /
 *                 session_before_compact accounting legs — no owned-state
 *                 writes (the accounting module owns its state); the tag
 *                 pins that routing these may not corrupt owned state.
 *  draft-start    /goals|/sisyphus drafting (goal) or /goal-tweak (tweak).
 *  draft-cancel   drafting cancel (/goal-clear|/goal-abort branch, both),
 *                 a failed draft/tweak send (kind-specific, CORE-05), and
 *                 the reconcile vanish path (tweak).
 *  draft-applied  goal committed (propose confirm / direct set / replace)
 *                 or apply_goal_tweak executed (tweak).
 *  nudge-reset    the adapter-side resets (user-turn leg of
 *                 before_agent_start; create/resume/pause legs live inside
 *                 their verbs).
 *  agent-settled  pi agent_settled — no owned-state writes (the audit hold
 *                 lives in the audit domain module); routing pin only.
 *  dispose        session_shutdown — clears all owned turn/draft state.
 *  (The old "restore" tag moved into the restore verb — loadState is its
 *  only production source.)
 */
import { asRecord, cloneGoal, createGoal, type DraftingFocus, type GoalCreationConfig, type GoalFocusEntry, type GoalRecord } from "./goal-record.ts";
import { buildAbortedByAgentGoal, buildPausedByAgentGoal } from "./goal-policy.ts";
import { mergeFocusedGoalWithDisk, resolveSessionFocus } from "./goal-pool.ts";
import { GOAL_PROGRESS_TOOL_NAMES, POST_STOP_ALLOWED_TOOLS } from "./goal-tool-names.ts";

/** Narrow structural context — the lifecycle module never imports pi. */
export interface LifecycleCtx {
	cwd: string;
}

export type GoalFocusReason = import("./goal-record.ts").GoalFocusReason;
export type StopReason = import("./goal-record.ts").StopReason;

/**
 * Thin session-local confirmation intent for /goals and /sisyphus.
 * It protects mode consistency and user confirmation without turning drafting
 * into a separate long-running runtime state machine.
 */
export interface GoalConfirmationIntent {
	focus: DraftingFocus;
	originalTopic: string;
	startedAt: number;
}

/** The closed event union — the only door into the turn/draft/nudge state. */
export type GoalLifecycleEvent =
	| { tag: "turn-start" }
	| { tag: "turn-stopped"; goalId: string | null }
	| { tag: "tool-call"; toolName: string; input: unknown }
	| { tag: "usage-accounted" }
	| { tag: "draft-start"; kind: "goal"; focus: DraftingFocus; topic: string; startedAt: number }
	| { tag: "draft-start"; kind: "tweak"; goalId: string }
	| { tag: "draft-cancel"; kind?: "goal" | "tweak" }
	| { tag: "draft-applied"; kind: "goal" | "tweak" }
	| { tag: "nudge-reset"; goalId: string | null | undefined }
	| { tag: "agent-settled" }
	| { tag: "dispose" };

/** tool-call verdict: the post-stop block decision (read-only result). */
export interface ToolCallVerdict {
	blocked: boolean;
	reason?: string;
}

export interface GoalLifecyclePorts {
	/** Halt the continuation loop (goal-continuation.halt). */
	haltContinuation(): void;
	/** Drop the active accounting segment, keeping per-goal carries. */
	pauseClock(): void;
	/** Release a completed/gone goal's sub-second carry (clock.forget). */
	forgetCarry(goalId: string): void;
	/** Append a session focus entry (pi.appendEntry in the adapter). */
	appendFocusEntry(goalId: string | null, reason: GoalFocusReason): void;
	/** Best-effort ledger append; must not throw into the verb. */
	appendLedger(ctx: LifecycleCtx, event: Record<string, unknown>): void;
	/** syncGoalTools() in the adapter. */
	syncTools(): void;
	/** updateUI(ctx) in the adapter. */
	updateUI(ctx: LifecycleCtx): void;
	/** ISO timestamp source (nowIso in the adapter). */
	nowIso(): string;
	/** storage: merge the disk prompt into a record (goal-files). */
	mergeGoalPromptFromDisk(ctx: LifecycleCtx, goal: GoalRecord): GoalRecord;
	/** storage: archive a record to the archive area (goal-files). */
	archiveGoal(ctx: LifecycleCtx, goal: GoalRecord): GoalRecord;
	/** storage: write an active record to disk (goal-files). */
	writeActiveGoalFile(ctx: LifecycleCtx, goal: GoalRecord): GoalRecord;
	/** storage: read the on-disk active pool (goal-files). */
	readActiveGoalPool(ctx: LifecycleCtx): ReadonlyMap<string, GoalRecord>;
	/** Append a pi-goal-state session entry (pi.appendEntry in the adapter). */
	appendStateEntry(goal: GoalRecord | null): void;
	/** accounting: begin a segment for the focused active goal (goal-accounting via the adapter's beginAccounting). */
	beginClock(): void;
}

export interface TransitionReport {
	kind: "setGoal" | "focus" | "complete" | "terminate" | "create" | "pause" | "resume" | "activate" | "note" | "tweak" | "retire";
	previousGoalId: string | null;
	nextGoalId: string | null;
	/**
	 * The terminal record (post-archive) for complete/terminate — read-only
	 * display material (archivedPath, final usage), never a to-do list.
	 */
	record?: GoalRecord;
	/** Read-only description of the effects the verb executed. */
	effects: string[];
}

export interface GoalLifecycle {
	// ---- read projections (defensive copies — mutation never reaches owned state) ----
	/** Copy of the focused record (L4: replaces the old `state` proxy's getter). */
	focused(): GoalRecord | null;
	/** Current focus id. */
	readonly focusedId: string | null;
	/** Copy of the pool (read paths; writes go through the verbs/events). */
	readonly pool: ReadonlyMap<string, GoalRecord>;

	/** Copy of the active /goals|/sisyphus confirmation intent, if drafting. */
	readonly confirmationIntent: GoalConfirmationIntent | null;
	/** The goal id whose /goal-tweak drafting gate is open, if any. */
	readonly tweakDraftingFor: string | null;
	/** Either drafting intent active? */
	readonly isDrafting: boolean;
	/** Post-stop turn lock (D3=A: only the four real stop tools set it). */
	readonly turnStoppedFor: string | null;
	/** Did this turn call a meaningful progress tool? */
	readonly goalWorkToolCalledThisTurn: boolean;
	/** Consecutive get_goal calls counted for a goal (nudge source). */
	getGoalNudgeCount(goalId: string): number;

	/** The closed event entry for turn/draft/nudge state. */
	handle(event: GoalLifecycleEvent): ToolCallVerdict | void;

	// ---- transition verbs (one per production path; no arbitrary record writes) ----
	/** replaceGoal core: create + focus + clock + fresh nudge + intent clear + ledger goal_created. */
	create(config: GoalCreationConfig, ctx: LifecycleCtx): TransitionReport;
	focus(goalId: string | null, ctx: LifecycleCtx, reason: GoalFocusReason): TransitionReport;
	/** Named form of focus(null): drop the focus pointer with full effects. */
	unfocus(ctx: LifecycleCtx, reason: GoalFocusReason): TransitionReport;
	/** USER pause (/goal-pause, Esc, aborted turns): stamp paused/user + note → setGoal → ledger goal_paused → nudge reset. */
	pause(ctx: LifecycleCtx, opts?: { note?: string }): TransitionReport;
	/** AGENT pause (the pause_goal tool): merge → buildPausedByAgentGoal → setGoal → nudge reset → turn-stopped. No ledger (historical parity). */
	pauseByAgent(ctx: LifecycleCtx, opts: { reason: string; suggestedAction?: string }): TransitionReport;
	/** /goal-resume core: merge → stamp active → setGoal → clock → nudge → ledger goal_resumed. */
	resume(ctx: LifecycleCtx): TransitionReport;
	/**
	 * The session-resume confirmation path: stamp active + clear pause fields
	 * → setGoal. No merge, no ledger, no clock — the exact effect set of the
	 * old inline `{ ...state.goal, status: "active" }` assignment.
	 */
	activate(ctx: LifecycleCtx): TransitionReport;
	/** /goal-note: stamp the standing user note (undefined clears) → setGoal. */
	setUserNote(ctx: LifecycleCtx, note: string | undefined): TransitionReport;
	/** The accounting result adoption: clone + delta + updatedAt (the old accountProgress tail). */
	applyUsage(delta: { tokens: number; cost: number; seconds: number }): void;
	/** Stamp auditAttempts and persist up front (survives a rejected audit and restarts). */
	recordAuditAttempt(ctx: LifecycleCtx, attempt: number): void;
	/**
	 * apply_goal_tweak's authoritative write. Deliberately NOT the persist
	 * sequence: persist re-reads the stale disk objective and would clobber
	 * the new one — the tweak write is upstream of the disk, not downstream.
	 */
	applyTweak(ctx: LifecycleCtx, newObjective: string): TransitionReport;
	/** The disk objective sync (get_goal / status / tweak-drafting paths). Returns whether the objective changed. */
	syncObjectiveFromDisk(ctx: LifecycleCtx, readCtx?: { goal: GoalRecord | null }): boolean;
	/** The persist sequence: stamp → sync objective → write/archive → adopt canonical → state entry → tool-sync → UI. */
	persistRecord(ctx?: LifecycleCtx, readCtx?: { goal: GoalRecord | null }): void;
	/** The turn-end display refresh: sync objective → (if changed) stamp + state entry → tool-sync → UI. */
	refreshDisplayFromDisk(ctx: LifecycleCtx): void;
	/**
	 * The loadState core: pool re-read (empty for child sessions), session
	 * focus resolution with legacy adoption, migrated/selected focus entry,
	 * completed-record cleanup, halted runtime. The adapter scans the session
	 * entries and sanitizes the legacy record first.
	 */
	restore(ctx: LifecycleCtx, input: { childSession: boolean; focusEntry: GoalFocusEntry | null; legacyGoal: GoalRecord | null }): string | null;
	/**
	 * The /goals|/sisyphus replace branch: archive the target (result
	 * discarded, as the old adapter code did) + clear focus with persist.
	 * Never emitted goal_aborted — historical parity, recorded in #119⑤.
	 */
	retireForReplacement(ctx: LifecycleCtx): TransitionReport;
	/**
	 * reconcileFromDisk: the reconcileFocusedGoalFromDisk core (pool re-read,
	 * focus repair, silent writes, stale-gate cleanup). The child-session
	 * guard stays with the adapter (env concern).
	 */
	reconcileFromDisk(ctx: LifecycleCtx, opts?: {
		preserveMemoryUsage?: boolean;
		captureDiskGoal?: { goal: GoalRecord | null };
	}): boolean;
	/**
	 * complete(goal): archive the audited goal as complete (the update_goal
	 * approved-verdict inline block). `goal` is the audited target — the
	 * verdict's original goal, never a post-await refocus.
	 */
	complete(goal: GoalRecord, ctx: LifecycleCtx): TransitionReport;
	/**
	 * terminate(kind): the /goal-clear + /goal-abort common core (by:"user")
	 * and the agent abort_goal tool variant (by:"agent"). Drafting-cancel
	 * branches route through handle({tag:"draft-cancel"}) instead.
	 */
	terminate(
		kind: "clear" | "abort",
		ctx: LifecycleCtx,
		opts?: { by?: "user" | "agent"; note?: string; reason?: string },
	): TransitionReport;
}

const GOAL_PROGRESS_TOOL_SET = new Set<string>(GOAL_PROGRESS_TOOL_NAMES);
const POST_STOP_ALLOWED_TOOL_SET = new Set<string>(POST_STOP_ALLOWED_TOOLS);

function isMeaningfulProgressToolCall(toolName: string, args: unknown): boolean {
	if (!GOAL_PROGRESS_TOOL_SET.has(toolName)) return false;
	if (toolName === "read") {
		const path = asRecord(args)?.path;
		if (typeof path === "string" && (path === ".pi/goals" || path.startsWith(".pi/goals/"))) return false;
	}
	if (toolName === "bash") {
		const command = asRecord(args)?.command;
		if (typeof command === "string" && /^\s*echo\b/.test(command)) return false;
	}
	return true;
}

export function createGoalLifecycle(ports: GoalLifecyclePorts): GoalLifecycle {
	const goalsById = new Map<string, GoalRecord>();
	let focusedGoalId: string | null = null;
	// ---- event-owned state (no external write path exists) ----
	let confirmationIntent: GoalConfirmationIntent | null = null;
	let tweakDraftingFor: string | null = null;
	let goalWorkToolCalledThisTurn = false;
	let turnStoppedFor: string | null = null;
	const activeGetGoalTurnsByGoalId = new Map<string, number>();

	// ---- internal accessors (never escaped) ----
	function focusedRecord(): GoalRecord | null {
		if (!focusedGoalId) return null;
		return goalsById.get(focusedGoalId) ?? null;
	}

	/** Clone at every escape boundary — callers can never mutate owned state. */
	function cloneOut(goal: GoalRecord): GoalRecord {
		return cloneGoal(goal);
	}

	/** Clone at every intake boundary — callers/ports never keep a live alias.
	 * Same semantics as the old public adopt: pool put + focus (or unfocus). */
	function adoptInternal(next: GoalRecord | null): void {
		if (next) {
			goalsById.set(next.id, cloneGoal(next));
			focusedGoalId = next.id;
			return;
		}
		if (focusedGoalId) goalsById.delete(focusedGoalId);
		focusedGoalId = null;
	}

	function replacePoolInternal(fresh: ReadonlyMap<string, GoalRecord>): void {
		goalsById.clear();
		for (const [id, g] of fresh) goalsById.set(id, cloneGoal(g));
	}

	function setFocusedInternal(goalId: string | null): void {
		focusedGoalId = goalId && goalsById.has(goalId) ? goalId : null;
	}

	function removeFromPoolInternal(goalId: string): void {
		goalsById.delete(goalId);
		if (focusedGoalId === goalId) focusedGoalId = null;
	}

	function resetNudge(goalId: string | null | undefined): void {
		if (goalId) activeGetGoalTurnsByGoalId.delete(goalId);
	}

	/** Clear a tweak gate that no longer matches the focused goal. */
	function releaseStaleTweakGate(focusedId: string | null | undefined): void {
		if (tweakDraftingFor !== null && tweakDraftingFor !== focusedId) tweakDraftingFor = null;
	}

	// ---- the internal writer verb (the old setGoal, module-private now) ----
	function setGoalInternal(next: GoalRecord | null, ctx: LifecycleCtx, opts: { persist?: boolean; focusReason?: GoalFocusReason } = {}): TransitionReport {
		const shouldPersist = opts.persist !== false;
		const previousGoalId = focusedRecord()?.id ?? null;
		// The old state setter: put+focus or delete+unfocus.
		adoptInternal(next);
		const effects: string[] = [];
		const nowFocused = focusedRecord();
		const focusChanged = previousGoalId !== focusedGoalId;
		if (focusChanged) {
			ports.haltContinuation();
			ports.pauseClock();
			resetNudge(previousGoalId);
			resetNudge(focusedGoalId);
			effects.push("halt-continuation", "pause-clock", `nudge-reset:${previousGoalId ?? "-"}`, `nudge-reset:${focusedGoalId ?? "-"}`);
		}
		if (opts.focusReason && focusChanged) {
			ports.appendFocusEntry(focusedGoalId, opts.focusReason);
			effects.push(`focus-entry:${focusedGoalId ?? "-"}:${opts.focusReason}`);
		}
		if (!nowFocused || nowFocused.status !== "active" || !nowFocused.autoContinue) {
			ports.haltContinuation();
			effects.push("halt-continuation(inactive)");
		}
		if (!nowFocused || nowFocused.status === "paused" || nowFocused.status === "complete") {
			ports.pauseClock();
			effects.push("pause-clock(paused/complete/gone)");
		}
		// GO-A: a goal that is gone (cleared/aborted) or completed can
		// never consume its sub-second carry again — release it. Paused
		// goals KEEP theirs (resume continues accumulating fragments).
		if (previousGoalId && (!nowFocused || nowFocused.status === "complete")) {
			ports.forgetCarry(previousGoalId);
			effects.push(`forget-carry:${previousGoalId}`);
		}
		if (!nowFocused || nowFocused.id !== previousGoalId) {
			// Drop any stale tweak-edit-gate that didn't belong to this goal.
			releaseStaleTweakGate(nowFocused?.id);
			effects.push("release-stale-tweak-gate");
		}
		if (shouldPersist) runPersistInternal(ctx);
		else ports.syncTools();
		ports.updateUI(ctx);
		effects.push(shouldPersist ? "persist" : "sync-tools", "update-ui");
		return { kind: "setGoal", previousGoalId, nextGoalId: focusedGoalId, effects };
	}

	/** The old adapter persist() — disk write + prompt merge + observability. */
	function runPersistInternal(ctx?: LifecycleCtx, readCtx?: { goal: GoalRecord | null }): void {
		const current = focusedRecord();
		if (current) {
			adoptInternal({ ...current, updatedAt: ports.nowIso() });
			if (ctx) {
				syncObjectiveInternal(ctx, readCtx);
				const next = focusedRecord();
				if (next) adoptInternal(next.status === "complete" ? ports.archiveGoal(ctx, cloneOut(next)) : ports.writeActiveGoalFile(ctx, cloneOut(next)));
			}
		}
		ports.appendStateEntry(focusedRecord() ? cloneOut(focusedRecord()!) : null);
		ports.syncTools();
		if (ctx) ports.updateUI(ctx);
	}

	/** The old adapter syncGoalPromptFromDisk() — objective sync only. */
	function syncObjectiveInternal(ctx: LifecycleCtx, readCtx?: { goal: GoalRecord | null }): boolean {
		const current = focusedRecord();
		if (!current || current.status === "complete") return false;
		const previousObjective = current.objective;
		// AR1005-GO-B: within one accounting event's synchronous segment the
		// objective comes from the ALREADY-PARSED pool read — no re-read.
		if (readCtx) {
			if (readCtx.goal) adoptInternal({ ...current, objective: readCtx.goal.objective });
		} else {
			const merged = ports.mergeGoalPromptFromDisk(ctx, cloneOut(current));
			// goal-files contract: merge returns the SAME ref when there is
			// nothing to merge and swaps only `objective` otherwise — a value
			// compare survives the clone boundary (identity always differs).
			if (merged.objective !== current.objective) adoptInternal(merged);
		}
		return (focusedRecord()?.objective ?? previousObjective) !== previousObjective;
	}

	function handleEvent(event: GoalLifecycleEvent): ToolCallVerdict | void {
		switch (event.tag) {
			case "turn-start":
				goalWorkToolCalledThisTurn = false;
				turnStoppedFor = null;
				return;
			case "turn-stopped":
				turnStoppedFor = event.goalId;
				return;
			case "tool-call": {
				if (turnStoppedFor !== null && !POST_STOP_ALLOWED_TOOL_SET.has(event.toolName)) {
					return {
						blocked: true,
						reason: `The goal was already stopped earlier in this turn (goalId=${turnStoppedFor}). ` +
							`Do not call more tools; end the turn with a brief summary and yield to the user.`,
					};
				}
				const current = focusedRecord();
				if (confirmationIntent === null && tweakDraftingFor === null && current?.status === "active") {
					if (event.toolName === "get_goal") {
						// Nudge only: do not hard-block, but warn in tool
						// response via get_goal execute.
						activeGetGoalTurnsByGoalId.set(current.id, (activeGetGoalTurnsByGoalId.get(current.id) ?? 0) + 1);
					}
				}
				if (isMeaningfulProgressToolCall(event.toolName, event.input)) {
					if (current?.id) activeGetGoalTurnsByGoalId.delete(current.id);
					goalWorkToolCalledThisTurn = true;
				}
				return;
			}
			case "usage-accounted":
				// The accounting module owns its state; routing this event
				// must never touch the owned turn/draft/nudge state.
				return;
			case "draft-start":
				if (event.kind === "goal") {
					confirmationIntent = { focus: event.focus, originalTopic: event.topic, startedAt: event.startedAt };
				} else {
					tweakDraftingFor = event.goalId;
				}
				return;
			case "draft-cancel":
				if (!event.kind || event.kind === "goal") confirmationIntent = null;
				if (!event.kind || event.kind === "tweak") tweakDraftingFor = null;
				return;
			case "draft-applied":
				if (event.kind === "goal") confirmationIntent = null;
				else tweakDraftingFor = null;
				return;
			case "nudge-reset":
				resetNudge(event.goalId);
				return;
			case "agent-settled":
				// The audit hold lives in the audit domain module; pin
				// that this routing leaves owned state untouched.
				return;
			case "dispose":
				confirmationIntent = null;
				tweakDraftingFor = null;
				goalWorkToolCalledThisTurn = false;
				turnStoppedFor = null;
				activeGetGoalTurnsByGoalId.clear();
				return;
		}
	}

	return {
		focused: () => {
			const g = focusedRecord();
			return g ? cloneOut(g) : null;
		},
		get focusedId() {
			return focusedGoalId;
		},
		get pool() {
			const copy = new Map<string, GoalRecord>();
			for (const [id, g] of goalsById) copy.set(id, cloneOut(g));
			return copy;
		},
		get confirmationIntent() {
			return confirmationIntent ? { ...confirmationIntent } : null;
		},
		get tweakDraftingFor() {
			return tweakDraftingFor;
		},
		get isDrafting() {
			return confirmationIntent !== null || tweakDraftingFor !== null;
		},
		get turnStoppedFor() {
			return turnStoppedFor;
		},
		get goalWorkToolCalledThisTurn() {
			return goalWorkToolCalledThisTurn;
		},
		getGoalNudgeCount(goalId: string): number {
			return activeGetGoalTurnsByGoalId.get(goalId) ?? 0;
		},

		handle: handleEvent,

		create(config, ctx) {
			const created = createGoal(config);
			const effects: string[] = [];
			const report = setGoalInternal(created, ctx, { focusReason: "created" });
			ports.beginClock();
			effects.push("begin-clock");
			resetNudge(created.id);
			effects.push(`nudge-reset:${created.id}`);
			handleEvent({ tag: "draft-applied", kind: "goal" });
			effects.push("draft-applied:goal");
			try {
				ports.appendLedger(ctx, {
					type: "goal_created",
					goalId: created.id,
					objective: created.objective,
					sisyphus: created.sisyphus,
					autoContinue: created.autoContinue,
					at: created.createdAt,
				});
				effects.push("ledger:goal_created");
			} catch {
				// Ledger append failure should not crash creation
			}
			return { ...report, kind: "create", effects: [...report.effects, ...effects] };
		},

		focus(goalId, ctx, reason) {
			const previousGoalId = focusedGoalId;
			setFocusedInternal(goalId);
			const effects: string[] = [];
			if (previousGoalId !== focusedGoalId) {
				ports.haltContinuation();
				ports.pauseClock();
				resetNudge(previousGoalId);
				resetNudge(focusedGoalId);
				releaseStaleTweakGate(focusedGoalId);
				effects.push("halt-continuation", "pause-clock", `nudge-reset:${previousGoalId ?? "-"}`, `nudge-reset:${focusedGoalId ?? "-"}`, "release-stale-tweak-gate");
			}
			ports.appendFocusEntry(focusedGoalId, reason);
			effects.push(`focus-entry:${focusedGoalId ?? "-"}:${reason}`);
			// Ledger stays best-effort (the old verb wrapped the append in
			// try/catch and continued to the UI sync).
			try {
				if (focusedGoalId) {
					ports.appendLedger(ctx, { type: "goal_focused", goalId: focusedGoalId, reason, at: ports.nowIso() });
					effects.push("ledger:goal_focused");
				} else if (previousGoalId) {
					ports.appendLedger(ctx, { type: "goal_unfocused", reason, at: ports.nowIso() });
					effects.push("ledger:goal_unfocused");
				}
			} catch {
				// Ledger append failure should not crash focus change
			}
			ports.syncTools();
			ports.updateUI(ctx);
			effects.push("sync-tools", "update-ui");
			return { kind: "focus", previousGoalId, nextGoalId: focusedGoalId, effects };
		},

		unfocus(ctx, reason) {
			return this.focus(null, ctx, reason);
		},

		pause(ctx, opts = {}) {
			// pauseActiveGoal core (user path): merge the internal record,
			// stamp paused + the user-labeled note, setGoal, pause ledger,
			// then the nudge reset (the old adapter did the reset after the
			// verb call — same order, now owned here).
			const current = focusedRecord();
			if (!current || current.status !== "active") {
				return { kind: "pause", previousGoalId: focusedGoalId, nextGoalId: focusedGoalId, effects: [] };
			}
			const note = opts.note?.trim() || undefined;
			const merged = ports.mergeGoalPromptFromDisk(ctx, cloneOut(current));
			const next: GoalRecord = {
				...merged,
				status: "paused",
				autoContinue: false,
				pauseReason: note ? `user: ${note}` : undefined,
				pauseSuggestedAction: undefined,
			};
			const stamped = { ...next, stopReason: "user" as StopReason, updatedAt: ports.nowIso() };
			const effects: string[] = [];
			const report = setGoalInternal(stamped, ctx);
			try {
				ports.appendLedger(ctx, {
					type: "goal_paused",
					goalId: next.id,
					reason: "user",
					suggestedAction: next.pauseSuggestedAction,
					status: next.status,
					at: stamped.updatedAt,
				});
				effects.push("ledger:goal_paused");
			} catch {
				// Ledger append failure should not crash pause
			}
			resetNudge(next.id);
			effects.push(`nudge-reset:${next.id}`);
			return { ...report, kind: "pause", effects: [...report.effects, ...effects] };
		},

		pauseByAgent(ctx, opts) {
			// The pause_goal TOOL path: policy builder + setGoal + nudge reset
			// + turn-stopped. It never emitted the goal_paused ledger —
			// behavioral parity pinned by the statemachine suite.
			const current = focusedRecord();
			if (!current || current.status !== "active") {
				return { kind: "pause", previousGoalId: focusedGoalId, nextGoalId: focusedGoalId, effects: [] };
			}
			const merged = ports.mergeGoalPromptFromDisk(ctx, cloneOut(current));
			const next = buildPausedByAgentGoal(merged, { reason: opts.reason, suggestedAction: opts.suggestedAction, updatedAt: ports.nowIso() });
			const report = setGoalInternal(next, ctx);
			resetNudge(next.id);
			handleEvent({ tag: "turn-stopped", goalId: next.id });
			return {
				...report,
				kind: "pause",
				effects: [...report.effects, `nudge-reset:${next.id}`, `turn-stopped:${next.id}`],
			};
		},

		resume(ctx) {
			const current = focusedRecord();
			if (!current) {
				return { kind: "resume", previousGoalId: null, nextGoalId: null, effects: [] };
			}
			const merged = ports.mergeGoalPromptFromDisk(ctx, cloneOut(current));
			const next = {
				...merged,
				status: "active" as const,
				autoContinue: true,
				stopReason: undefined,
				pauseReason: undefined,
				pauseSuggestedAction: undefined,
			};
			const effects: string[] = [];
			const report = setGoalInternal(next, ctx);
			ports.beginClock();
			effects.push("begin-clock");
			resetNudge(next.id);
			effects.push(`nudge-reset:${next.id}`);
			try {
				ports.appendLedger(ctx, { type: "goal_resumed", goalId: next.id, reason: "user", at: ports.nowIso() });
				effects.push("ledger:goal_resumed");
			} catch {
				// Ledger append failure should not crash resume
			}
			return { ...report, kind: "resume", effects: [...report.effects, ...effects] };
		},

		activate(ctx) {
			// The session-resume confirmation path: the old inline
			// `{ ...state.goal, status: "active", ... }` assignment — no
			// merge, no ledger, no clock, no nudge reset.
			const current = focusedRecord();
			if (!current) {
				return { kind: "activate", previousGoalId: null, nextGoalId: null, effects: [] };
			}
			const next = {
				...current,
				status: "active" as const,
				autoContinue: true,
				stopReason: undefined,
				pauseReason: undefined,
				pauseSuggestedAction: undefined,
			};
			const report = setGoalInternal(next, ctx);
			return { ...report, kind: "activate" };
		},

		setUserNote(ctx, note) {
			const current = focusedRecord();
			if (!current) {
				return { kind: "note", previousGoalId: null, nextGoalId: null, effects: [] };
			}
			const report = setGoalInternal({ ...current, userNote: note }, ctx);
			return { ...report, kind: "note" };
		},

		applyUsage(delta) {
			const current = focusedRecord();
			if (!current) throw new Error("Goal disappeared during usage application.");
			adoptInternal({
				...current,
				usage: {
					tokensUsed: current.usage.tokensUsed + Math.max(0, Math.trunc(delta.tokens)),
					activeSeconds: current.usage.activeSeconds + Math.max(0, delta.seconds),
					costUsed: (current.usage.costUsed ?? 0) + Math.max(0, delta.cost),
				},
				updatedAt: ports.nowIso(),
			});
		},

		recordAuditAttempt(ctx, attempt) {
			const current = focusedRecord();
			if (!current) return;
			adoptInternal({ ...current, auditAttempts: attempt });
			runPersistInternal(ctx);
		},

		applyTweak(ctx, newObjective) {
			// IMPORTANT (migrated comment): do NOT route through
			// setGoal/persist here — persist re-reads the STALE objective
			// from the still-old goal file on disk and clobbers the new one.
			// apply_goal_tweak is the authoritative source for objective
			// changes — the disk is downstream, not upstream:
			//   1) write the new record to disk authoritatively
			//   2) adopt the canonical post-write record
			//   3) append the state entry
			//   4) clear the tweak drafting gate (apply_goal_tweak can't be re-used)
			//   5) fresh nudge chain + turn-stopped
			const current = focusedRecord();
			if (!current) {
				return { kind: "tweak", previousGoalId: null, nextGoalId: null, effects: [] };
			}
			const next: GoalRecord = {
				...current,
				objective: newObjective,
				updatedAt: ports.nowIso(),
				// Clear any prior agent pause reason — the user has redefined the work.
				pauseReason: undefined,
				pauseSuggestedAction: undefined,
			};
			const written = ports.writeActiveGoalFile(ctx, cloneOut(next));
			adoptInternal(written);
			const effects = [`write-active-file:${next.id}`];
			ports.appendStateEntry(cloneOut(focusedRecord()!));
			effects.push("state-entry");
			handleEvent({ tag: "draft-applied", kind: "tweak" });
			effects.push("draft-applied:tweak");
			const tweaked = focusedRecord()!;
			resetNudge(tweaked.id);
			effects.push(`nudge-reset:${tweaked.id}`);
			handleEvent({ tag: "turn-stopped", goalId: tweaked.id });
			effects.push(`turn-stopped:${tweaked.id}`);
			ports.syncTools();
			ports.updateUI(ctx);
			effects.push("sync-tools", "update-ui");
			return { kind: "tweak", previousGoalId: tweaked.id, nextGoalId: tweaked.id, effects };
		},

		syncObjectiveFromDisk(ctx, readCtx) {
			return syncObjectiveInternal(ctx, readCtx);
		},

		persistRecord(ctx, readCtx) {
			runPersistInternal(ctx, readCtx);
		},

		refreshDisplayFromDisk(ctx) {
			const current = focusedRecord();
			if (!current || current.status === "complete") return;
			if (syncObjectiveInternal(ctx)) {
				const g = focusedRecord();
				if (g) adoptInternal({ ...g, updatedAt: ports.nowIso() });
				const stamped = focusedRecord();
				ports.appendStateEntry(stamped ? cloneOut(stamped) : null);
			}
			ports.syncTools();
			ports.updateUI(ctx);
		},

		restore(ctx, input) {
			// loadState core. No tool_call/turn_end can read the flags before
			// the next turn_start reset — clearing here is equivalent to the
			// old behavior (loadState touched neither flag; the restore tag
			// did). Drafting intents and nudge counters SURVIVE a restore,
			// exactly like today.
			goalWorkToolCalledThisTurn = false;
			turnStoppedFor = null;
			// GH-02: children never adopt the project's disk goal pool — the
			// adapter computed the flag (env concern stays adapter-side).
			replacePoolInternal(input.childSession ? new Map<string, GoalRecord>() : ports.readActiveGoalPool(ctx));
			setFocusedInternal(null);
			const resolved = resolveSessionFocus({
				pool: goalsById,
				focusEntry: input.focusEntry,
				legacyGoal: input.legacyGoal,
				adoptLegacyGoal: (g) => adoptInternal(g),
			});
			setFocusedInternal(resolved);
			if (!input.focusEntry && focusedGoalId) {
				try {
					ports.appendFocusEntry(focusedGoalId, input.legacyGoal?.id === focusedGoalId ? "migrated" : "selected");
				} catch {
					// Focus-entry failure must not break restore
				}
			}
			for (const [id, current] of goalsById) {
				if (current.status === "complete") removeFromPoolInternal(id);
			}
			// clearStoppedRuntimeState(): halt continuation + drop the
			// active accounting segment (carries kept).
			ports.haltContinuation();
			ports.pauseClock();
			ports.syncTools();
			ports.updateUI(ctx);
			return focusedGoalId;
		},

		retireForReplacement(ctx) {
			// The /goals|/sisyphus replace branch: archiveCurrentGoal +
			// setGoal(null, persist, cleared). The archive result was
			// discarded by the old adapter code; no goal_aborted ledger was
			// ever emitted on this path (recorded boundary #119⑤).
			const current = focusedRecord();
			if (current) {
				const merged = ports.mergeGoalPromptFromDisk(ctx, cloneOut(current));
				const stamped = {
					...merged,
					status: merged.status === "complete" ? ("complete" as const) : ("paused" as const),
					stopReason: "user" as StopReason,
				};
				ports.archiveGoal(ctx, cloneOut(stamped));
			}
			const report = setGoalInternal(null, ctx, { persist: true, focusReason: "cleared" });
			return { ...report, kind: "retire" };
		},

		reconcileFromDisk(ctx, opts = {}) {
			const current = focusedRecord();
			const fresh = ports.readActiveGoalPool(ctx);
			if (!focusedGoalId) {
				replacePoolInternal(fresh);
				return true;
			}
			const diskGoal = fresh.get(focusedGoalId) ?? null;
			// AR1005-GO-B: hand the JUST-PARSED focused disk goal to the
			// caller's same synchronous segment (persist must not re-read it).
			if (opts.captureDiskGoal) opts.captureDiskGoal.goal = diskGoal;
			if (!diskGoal) {
				if (current && !current.activePath) {
					replacePoolInternal(fresh);
					adoptInternal(current);
					setFocusedInternal(current.id);
					return true;
				}
				replacePoolInternal(fresh);
				setFocusedInternal(null);
				ports.haltContinuation();
				ports.pauseClock();
				if (current) resetNudge(current.id);
				handleEvent({ tag: "draft-cancel", kind: "tweak" });
				ports.syncTools();
				ports.updateUI(ctx);
				return false;
			}
			const reconciled = current && opts.preserveMemoryUsage
				? mergeFocusedGoalWithDisk({ memoryGoal: current, diskGoal })
				: diskGoal;
			replacePoolInternal(fresh);
			adoptInternal(reconciled);
			setFocusedInternal(reconciled.id);
			if (reconciled.status !== "active" || !reconciled.autoContinue) ports.haltContinuation();
			if (reconciled.status !== "active") ports.pauseClock();
			return true;
		},

		complete(goal, ctx) {
			// The audit-time canonical record becomes the current record
			// first (the old adapter adopted auditTarget right before the
			// verb); then merge the disk prompt into the audited target,
			// stamp complete, and let setGoal carry halt/pause/forget/
			// persist(=archive). The audited target is explicit — a
			// post-await refocus never replaces the audit's subject.
			adoptInternal(goal);
			const merged = ports.mergeGoalPromptFromDisk(ctx, cloneOut(goal));
			const completed = { ...merged, status: "complete" as const, stopReason: "agent" as StopReason, updatedAt: ports.nowIso() };
			const effects: string[] = [];
			const setReport = setGoalInternal(completed, ctx);
			// persist (inside setGoal) archived the record and adopted it
			// back — focusedRecord() is the post-archive terminal record.
			const terminal = focusedRecord() ?? completed;
			resetNudge(terminal.id);
			effects.push(`nudge-reset:${terminal.id}`);
			removeFromPoolInternal(terminal.id);
			effects.push(`remove-from-pool:${terminal.id}`);
			ports.appendFocusEntry(null, "completed");
			effects.push("focus-entry:null:completed");
			ports.syncTools();
			ports.updateUI(ctx);
			effects.push("sync-tools", "update-ui");
			try {
				ports.appendLedger(ctx, {
					type: "goal_completed",
					goalId: terminal.id,
					archivePath: terminal.archivedPath,
					at: ports.nowIso(),
				});
				effects.push("ledger:goal_completed");
			} catch {
				// Ledger append failure should not crash completion
			}
			return { kind: "complete", previousGoalId: setReport.previousGoalId, nextGoalId: null, record: cloneOut(terminal), effects: [...setReport.effects, ...effects] };
		},

		terminate(kind, ctx, opts = {}) {
			const by = opts.by ?? "user";
			const effects: string[] = [];
			const current = focusedRecord();
			let archived: GoalRecord | null = null;
			if (current) {
				// archiveCurrentGoal: merge, map the archival status, stamp the
				// stop reason; the agent variant first builds the aborted
				// record (pauseReason carries the raw reason).
				const merged = ports.mergeGoalPromptFromDisk(ctx, cloneOut(current));
				const stamped = by === "agent" && kind === "abort"
					? buildAbortedByAgentGoal(merged, { reason: opts.reason ?? "", updatedAt: ports.nowIso() })
					: { ...merged, stopReason: by as StopReason };
				const forArchive = {
					...stamped,
					status: stamped.status === "complete" ? ("complete" as const) : ("paused" as const),
					stopReason: by as StopReason,
				};
				archived = ports.archiveGoal(ctx, cloneOut(forArchive));
				effects.push("archive");
			}
			// appendUserTerminationEvent (user) / the tool's ledger append
			// (agent) — both best-effort goal_aborted events.
			try {
				ports.appendLedger(ctx, {
					type: "goal_aborted",
					goalId: archived?.id ?? current?.id ?? "unknown",
					// Ledger wording keeps the OLD user-kind nouns ("cleared"/"aborted" —
					// the historical appendUserTerminationEvent text); the union's
					// kind discriminator ("clear"/"abort") must not leak into the
					// persistent ledger (review P2, 2026-10-08).
					reason: by === "agent"
						? (opts.reason ?? "").trim()
						: opts.note?.trim()
							? `user ${kind === "clear" ? "cleared" : "aborted"}: ${opts.note.trim()}`
							: `user ${kind === "clear" ? "cleared" : "aborted"}`,
					archivePath: archived?.archivedPath,
					at: ports.nowIso(),
				});
				effects.push("ledger:goal_aborted");
			} catch {
				// Ledger append failure should not crash termination
			}
			if (current) {
				resetNudge(current.id);
				effects.push(`nudge-reset:${current.id}`);
			}
			const setReport = setGoalInternal(null, ctx, { focusReason: kind === "clear" ? "cleared" : "aborted" });
			return { kind: "terminate", previousGoalId: current?.id ?? null, nextGoalId: null, record: archived ? cloneOut(archived) : undefined, effects: [...effects, ...setReport.effects] };
		},
	};
}
