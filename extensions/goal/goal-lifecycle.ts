/**
 * goal-lifecycle.ts — the pool/focus/drafting state owner (SPEC 2026-10-07
 * P2-2, decisions L1=A factory / L2=B full ownership / L3=B ports / L4=B
 * focused() getter / L5=B TransitionReport). Step 1: the goal POOL and the
 * FOCUS pointer live here; the writer verbs with their FULL effect sets
 * (setGoal / setFocusedGoalId) migrated verbatim from goal.ts. Step 2 added
 * the terminal verbs complete / terminate(kind). Step 3 moved the drafting
 * intents (confirmationIntent / tweakDraftingFor), the per-turn flags
 * (goalWorkToolCalledThisTurn / turnStoppedFor), and the get_goal nudge
 * counters behind the CLOSED EVENT ENTRY `handle(event)` — callers route
 * production events through the union; no arbitrary setters exist, and the
 * releaseStaleTweakGate / resetNudge write-back ports are gone (internal
 * now).
 *
 * Verb effect table (pinned by goal-lifecycle.test.ts recording ports —
 * migrated line-for-line from the goal.ts implementations):
 *
 *  setGoal(next, {persist})   stop-loop(cond) · stop-clock(cond) · nudge
 *                             reset(cond prev/next) · forget carry(gone or
 *                             completed) · release stale tweak gate(cond) ·
 *                             focus entry(cond reason+changed) · persist or
 *                             tool-sync · UI sync
 *  focus(goalId, reason)      stop-loop+clock on change · nudge reset(prev
 *                             + next) · release stale tweak gate(cond) ·
 *                             focus entry(always) · ledger focused/unfocused
 *                             · tool-sync · UI sync
 *  complete(goal)             merge-from-disk → stamp complete/agent →
 *                             setGoal effects (halt · pause · forget carry ·
 *                             persist=archive · UI) → nudge reset → pool
 *                             removal → focus entry(null, completed) ·
 *                             tool-sync · UI sync · ledger goal_completed
 *  terminate(kind,{by,note})  archive(disk, stopReason=by) · ledger
 *                             goal_aborted(user kind note / agent reason) ·
 *                             nudge reset · setGoal(null) effects ·
 *                             persist · UI sync
 *
 * Event entry (each tag's production source + interface test):
 *  restore        session_start / session_tree → loadState. Clears the two
 *                 per-turn flags (equivalent to the old behavior: no
 *                 tool_call/turn_end can read them before the next
 *                 turn_start reset). Drafting intents and nudge counters
 *                 intentionally SURVIVE a restore, exactly like today.
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
 *  agent-settled  pi agent_settled — no owned-state writes (the audit hold
 *                 lives in the audit domain module); routing pin only.
 *  dispose        session_shutdown — clears all owned turn/draft state.
 *
 * The silent primitives (replacePool / setFocusedSilently / removeFromPool /
 * adopt) are reconciliation/loadState internals — they move data WITHOUT the
 * verb effect sets, exactly like the old direct assignments did.
 */
import { asRecord, type DraftingFocus, type GoalRecord } from "./goal-record.ts";
import { buildAbortedByAgentGoal } from "./goal-policy.ts";
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
	| { tag: "restore" }
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
	/** persist() in the adapter (disk write + prompt merge). */
	persist(ctx: LifecycleCtx): void;
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
}

export interface TransitionReport {
	kind: "setGoal" | "focus" | "complete" | "terminate";
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
	/** Read-only focused record (L4: replaces the old `state` proxy's getter). */
	focused(): GoalRecord | null;
	/** Current focus id. */
	readonly focusedId: string | null;
	/** The live pool (read paths; writes go through the verbs/primitives). */
	readonly pool: ReadonlyMap<string, GoalRecord>;

	// ---- read-only projections over the event-owned state (Step 3) ----
	/** The active /goals|/sisyphus confirmation intent, if drafting. */
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

	/** The closed event entry for turn/draft/nudge state (Step 3). */
	handle(event: GoalLifecycleEvent): ToolCallVerdict | void;

	setGoal(next: GoalRecord | null, ctx: LifecycleCtx, opts?: { persist?: boolean; focusReason?: GoalFocusReason }): TransitionReport;
	focus(goalId: string | null, ctx: LifecycleCtx, reason: GoalFocusReason): TransitionReport;
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

	/** Reconciliation primitives (no verb effects — data movement only). */
	replacePool(fresh: ReadonlyMap<string, GoalRecord>): void;
	setFocusedSilently(goalId: string | null): void;
	removeFromPool(goalId: string): void;
	/** The old `state.goal = next` setter semantics (pool put/delete + focus). */
	adopt(next: GoalRecord | null): void;
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
	// ---- Step 3: event-owned state (no external write path exists) ----
	let confirmationIntent: GoalConfirmationIntent | null = null;
	let tweakDraftingFor: string | null = null;
	let goalWorkToolCalledThisTurn = false;
	let turnStoppedFor: string | null = null;
	const activeGetGoalTurnsByGoalId = new Map<string, number>();

	function focused(): GoalRecord | null {
		if (!focusedGoalId) return null;
		return goalsById.get(focusedGoalId) ?? null;
	}

	function resetNudge(goalId: string | null | undefined): void {
		if (goalId) activeGetGoalTurnsByGoalId.delete(goalId);
	}

	/** Clear a tweak gate that no longer matches the focused goal. */
	function releaseStaleTweakGate(focusedId: string | null | undefined): void {
		if (tweakDraftingFor !== null && tweakDraftingFor !== focusedId) tweakDraftingFor = null;
	}

	return {
		focused,
		get focusedId() {
			return focusedGoalId;
		},
		get pool() {
			return goalsById;
		},
		get confirmationIntent() {
			return confirmationIntent;
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

		handle(event) {
			switch (event.tag) {
				case "restore":
					// No tool_call/turn_end can read the flags before the
					// next turn_start reset — clearing here is equivalent to
					// the old behavior (loadState touched neither flag).
					goalWorkToolCalledThisTurn = false;
					turnStoppedFor = null;
					return;
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
					const current = focused();
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
		},

		setGoal(next, ctx, opts = {}) {
			const shouldPersist = opts.persist !== false;
			const previousGoalId = focused()?.id ?? null;
			// The old state setter: put+focus or delete+unfocus.
			if (next) {
				goalsById.set(next.id, next);
				focusedGoalId = next.id;
			} else {
				if (focusedGoalId) goalsById.delete(focusedGoalId);
				focusedGoalId = null;
			}
			const effects: string[] = [];
			const nowFocused = focused();
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
			if (shouldPersist) ports.persist(ctx);
			else ports.syncTools();
			ports.updateUI(ctx);
			effects.push(shouldPersist ? "persist" : "sync-tools", "update-ui");
			return { kind: "setGoal", previousGoalId, nextGoalId: focusedGoalId, effects };
		},

		focus(goalId, ctx, reason) {
			const previousGoalId = focusedGoalId;
			focusedGoalId = goalId && goalsById.has(goalId) ? goalId : null;
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

		replacePool(fresh) {
			goalsById.clear();
			for (const [id, g] of fresh) goalsById.set(id, g);
		},
		setFocusedSilently(goalId) {
			focusedGoalId = goalId && goalsById.has(goalId) ? goalId : null;
		},
		removeFromPool(goalId) {
			goalsById.delete(goalId);
			if (focusedGoalId === goalId) focusedGoalId = null;
		},
		adopt(next) {
			if (next) {
				goalsById.set(next.id, next);
				focusedGoalId = next.id;
				return;
			}
			if (focusedGoalId) goalsById.delete(focusedGoalId);
			focusedGoalId = null;
		},
		complete(goal, ctx) {
			// The old inline block routed through stopActiveGoal: merge the
			// disk prompt into the audited target, stamp complete, then the
			// setGoal verb carries halt/pause/forget/persist(=archive).
			const merged = ports.mergeGoalPromptFromDisk(ctx, goal);
			const completed = { ...merged, status: "complete" as const, stopReason: "agent" as StopReason, updatedAt: ports.nowIso() };
			const effects: string[] = [];
			const setReport = this.setGoal(completed, ctx);
			// persist (inside setGoal) archived the record and adopted it
			// back — focused() is the post-archive terminal record.
			const terminal = focused() ?? completed;
			resetNudge(terminal.id);
			effects.push(`nudge-reset:${terminal.id}`);
			this.removeFromPool(terminal.id);
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
			return { kind: "complete", previousGoalId: setReport.previousGoalId, nextGoalId: null, record: terminal, effects: [...setReport.effects, ...effects] };
		},
		terminate(kind, ctx, opts = {}) {
			const by = opts.by ?? "user";
			const effects: string[] = [];
			const current = focused();
			let archived: GoalRecord | null = null;
			if (current) {
				// archiveCurrentGoal: merge, map the archival status, stamp the
				// stop reason; the agent variant first builds the aborted
				// record (pauseReason carries the raw reason).
				const merged = ports.mergeGoalPromptFromDisk(ctx, current);
				const stamped = by === "agent" && kind === "abort"
					? buildAbortedByAgentGoal(merged, { reason: opts.reason ?? "", updatedAt: ports.nowIso() })
					: { ...merged, stopReason: by as StopReason };
				const forArchive = {
					...stamped,
					status: stamped.status === "complete" ? ("complete" as const) : ("paused" as const),
					stopReason: by as StopReason,
				};
				archived = ports.archiveGoal(ctx, forArchive);
				effects.push("archive");
			}
			// appendUserTerminationEvent (user) / the tool's ledger append
			// (agent) — both best-effort goal_aborted events.
			try {
				ports.appendLedger(ctx, {
					type: "goal_aborted",
					goalId: archived?.id ?? current?.id ?? "unknown",
					reason: by === "agent" ? (opts.reason ?? "").trim() : opts.note?.trim() ? `user ${kind}: ${opts.note.trim()}` : `user ${kind}`,
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
			const setReport = this.setGoal(null, ctx, { focusReason: kind === "clear" ? "cleared" : "aborted" });
			return { kind: "terminate", previousGoalId: current?.id ?? null, nextGoalId: null, record: archived ?? undefined, effects: [...effects, ...setReport.effects] };
		},
	};
}
