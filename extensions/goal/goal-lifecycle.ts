/**
 * goal-lifecycle.ts — the pool/focus/drafting state owner (SPEC 2026-10-07
 * P2-2, decisions L1=A factory / L2=B full ownership / L3=B ports / L4=B
 * focused() getter / L5=B TransitionReport). Step 1 of 4: the goal POOL and
 * the FOCUS pointer live here; the two writer verbs with their FULL effect
 * sets (setGoal / setFocusedGoalId) migrated verbatim from goal.ts. The
 * adapter in goal.ts keeps transitional aliases (spec §4.3 allows them in
 * step 1; step 4 removes them). Step 2 adds the terminal verbs: complete
 * (the update_goal=approved inline block) and terminate(kind) (the
 * /goal-clear + /goal-abort common core, plus the agent abort_goal tool
 * variant via by:"agent").
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
 * The silent primitives (replacePool / setFocusedSilently / removeFromPool /
 * adopt) are reconciliation/loadState internals — they move data WITHOUT the
 * verb effect sets, exactly like the old direct assignments did.
 */
import type { GoalRecord } from "./goal-record.ts";
import { buildAbortedByAgentGoal } from "./goal-policy.ts";

/** Narrow structural context — the lifecycle module never imports pi. */
export interface LifecycleCtx {
	cwd: string;
}

export type GoalFocusReason = import("./goal-record.ts").GoalFocusReason;
export type StopReason = import("./goal-record.ts").StopReason;

export interface GoalLifecyclePorts {
	/** Halt the continuation loop (goal-continuation.halt). */
	haltContinuation(): void;
	/** Drop the active accounting segment, keeping per-goal carries. */
	pauseClock(): void;
	/** Release a completed/gone goal's sub-second carry (clock.forget). */
	forgetCarry(goalId: string): void;
	/** Reset the get_goal nudge counter for a goal id. */
	resetNudge(goalId: string | null | undefined): void;
	/**
	 * Release a stale tweak-drafting gate that no longer matches the focused
	 * goal (drafting intents migrate into this module in Step 3; until then
	 * the adapter injects this closure over its own state).
	 */
	releaseStaleTweakGate(focusedId: string | null | undefined): void;
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
	 * branches stay with the adapter (Step 3 migrates the intents).
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

export function createGoalLifecycle(ports: GoalLifecyclePorts): GoalLifecycle {
	const goalsById = new Map<string, GoalRecord>();
	let focusedGoalId: string | null = null;

	function focused(): GoalRecord | null {
		if (!focusedGoalId) return null;
		return goalsById.get(focusedGoalId) ?? null;
	}

	return {
		focused,
		get focusedId() {
			return focusedGoalId;
		},
		get pool() {
			return goalsById;
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
				ports.resetNudge(previousGoalId);
				ports.resetNudge(focusedGoalId);
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
				ports.releaseStaleTweakGate(nowFocused?.id);
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
				ports.resetNudge(previousGoalId);
				ports.resetNudge(focusedGoalId);
				ports.releaseStaleTweakGate(focusedGoalId);
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
			ports.resetNudge(terminal.id);
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
				ports.resetNudge(current.id);
				effects.push(`nudge-reset:${current.id}`);
			}
			const setReport = this.setGoal(null, ctx, { focusReason: kind === "clear" ? "cleared" : "aborted" });
			return { kind: "terminate", previousGoalId: current?.id ?? null, nextGoalId: null, record: archived ?? undefined, effects: [...effects, ...setReport.effects] };
		},
	};
}
