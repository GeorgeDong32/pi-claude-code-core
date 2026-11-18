
import { shouldQueueContinuation } from "./goal-policy.ts";
import type { GoalRecord } from "./goal-record.ts";

export const CONTINUATION_IDLE_RETRY_MS = 50;

export interface ContinuationProbe {
	isIdle(): boolean;
	hasPendingMessages(): boolean;
}

export interface ContinuationDeps {
	getGoal(): GoalRecord | null;
	isDrafting(): boolean;
	isSubagentChild(): boolean;
	promptFor(goal: GoalRecord): string;
	sendFollowUp(prompt: string, goal: GoalRecord): void;
	onDispatch(): void;
}

export interface ContinuationLoop {
	queue(probe: ContinuationProbe, force?: boolean): void;
	halt(): void;
	stopTimer(): void;
	clearQueued(): void;
	readonly queuedFor: string | null;
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
