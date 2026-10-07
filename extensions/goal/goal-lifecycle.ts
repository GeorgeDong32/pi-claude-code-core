/**
 * goal-lifecycle.ts — the pool/focus/drafting state owner (SPEC 2026-10-07
 * P2-2, decisions L1=A factory / L2=B full ownership / L3=B ports / L4=B
 * focused() getter / L5=B TransitionReport). Step 1 of 4: the goal POOL and
 * the FOCUS pointer live here; the two writer verbs with their FULL effect
 * sets (setGoal / setFocusedGoalId) migrated verbatim from goal.ts. The
 * adapter in goal.ts keeps transitional aliases (spec §4.3 allows them in
 * step 1; step 4 removes them).
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
 *
 * The silent primitives (replacePool / setFocusedSilently / removeFromPool /
 * adopt) are reconciliation/loadState internals — they move data WITHOUT the
 * verb effect sets, exactly like the old direct assignments did.
 */
import type { GoalRecord } from "./goal-record.ts";

/** Narrow structural context — the lifecycle module never imports pi. */
export interface LifecycleCtx {
	cwd: string;
}

export type GoalFocusReason = import("./goal-record.ts").GoalFocusReason;

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
}

export interface TransitionReport {
	kind: "setGoal" | "focus";
	previousGoalId: string | null;
	nextGoalId: string | null;
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
	};
}
