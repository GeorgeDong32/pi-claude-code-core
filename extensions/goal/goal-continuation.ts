/**
 * goal-continuation.ts — the sisyphus continuation loop state machine
 * (arch B7 step 1, carved out of the goal.ts monolith).
 *
 * Owns the three loop variables that used to live as factory-closure state
 * (queuedFor / scheduledFor / timer). Knows NOTHING about pi events: the
 * host adapter injects a narrow probe (idle/busy) and the follow-up emit
 * seam, so the loop's turn sequence is directly assertable in node:test
 * without FakeHost (which still pins the wiring end-to-end, unchanged).
 *
 * Gates preserved verbatim from the monolith:
 *   - GH-03 belt: subagent child sessions never arm continuations;
 *   - drafting gates (confirmation intent / tweak drafting) pause the loop;
 *   - the active+autoContinue predicate is goal-policy's
 *     shouldQueueContinuation (single implementation).
 */

import { shouldQueueContinuation } from "./goal-policy.ts";
import type { GoalRecord } from "./goal-record.ts";

/** Monolith parity: the idle-retry delay (kept tiny — test-friendly). */
export const CONTINUATION_IDLE_RETRY_MS = 50;

export interface ContinuationProbe {
	isIdle(): boolean;
	hasPendingMessages(): boolean;
}

export interface ContinuationDeps {
	/** Live goal snapshot (or null). */
	getGoal(): GoalRecord | null;
	/** Any drafting session in flight pauses the loop. */
	isDrafting(): boolean;
	/** GH-03: subagent child sessions never arm. */
	isSubagentChild(): boolean;
	/** Prompt body for the goal's next step. */
	promptFor(goal: GoalRecord): string;
	/** Emit the follow-up checkpoint message (pi.sendMessage in the adapter). */
	sendFollowUp(prompt: string, goal: GoalRecord): void;
	/** Display sync when a queued send actually fires (syncGoalTools). */
	onDispatch(): void;
}

export interface ContinuationLoop {
	/** Arm the loop for the current goal (no-op when a gate closes it). */
	queue(probe: ContinuationProbe, force?: boolean): void;
	/** Full stop: timer + scheduled + queued markers. */
	halt(): void;
	/** Timer-only stop (shutdown path): keeps the queued marker untouched. */
	stopTimer(): void;
	/** Drop the queued marker only (turn-end re-arm path). */
	clearQueued(): void;
	/** The goal whose follow-up was actually dispatched (or null). */
	readonly queuedFor: string | null;
	/** The goal currently scheduled for a (re)try (or null). */
	readonly scheduledFor: string | null;
}

export function createContinuationLoop(deps: ContinuationDeps, retryMs: number = CONTINUATION_IDLE_RETRY_MS): ContinuationLoop {
	let queuedFor: string | null = null;
	let scheduledFor: string | null = null;
	let timer: ReturnType<typeof setTimeout> | null = null;

	function clearTimer(): void {
		if (timer) {
			clearTimeout(timer);
			timer = null;
		}
		scheduledFor = null;
	}

	function dispatch(probe: ContinuationProbe, goalId: string): void {
		timer = null;
		scheduledFor = null;
		deps.onDispatch();
		const goal = deps.getGoal();
		// id guard stays local; the active+autoContinue predicate is
		// goal-policy's shouldQueueContinuation (single implementation).
		if (!goal || goal.id !== goalId || !shouldQueueContinuation(goal)) {
			if (queuedFor === goalId) queuedFor = null;
			return;
		}

		let ready: boolean;
		try {
			ready = !probe.hasPendingMessages() && probe.isIdle();
		} catch {
			if (queuedFor === goalId) queuedFor = null;
			return;
		}

		if (!ready) {
			scheduledFor = goalId;
			timer = setTimeout(() => dispatch(probe, goalId), retryMs);
			timer.unref?.();
			return;
		}
		queuedFor = goalId;
		deps.sendFollowUp(deps.promptFor(goal), goal);
	}

	return {
		queue(probe: ContinuationProbe, force = false): void {
			// GH-03 belt: never arm continuations in subagent child sessions.
			if (deps.isSubagentChild()) return;
			if (deps.isDrafting()) return;
			const goal = deps.getGoal();
			if (!goal || !shouldQueueContinuation(goal)) return;
			const goalId = goal.id;
			if (!force && (queuedFor === goalId || scheduledFor === goalId)) return;
			clearTimer();
			let delay = retryMs;
			try {
				delay = probe.isIdle() && !probe.hasPendingMessages() ? 0 : retryMs;
			} catch {
				return;
			}
			scheduledFor = goalId;
			timer = setTimeout(() => dispatch(probe, goalId), delay);
			timer.unref?.();
		},
		halt(): void {
			clearTimer();
			queuedFor = null;
		},
		stopTimer(): void {
			clearTimer();
		},
		clearQueued(): void {
			queuedFor = null;
		},
		get queuedFor() {
			return queuedFor;
		},
		get scheduledFor() {
			return scheduledFor;
		},
	};
}
