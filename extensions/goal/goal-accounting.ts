
export interface GoalAccountingClock {
	begin(goalId: string): void;
	settle(goalId: string): number | null;
	preview(goalId: string): number;
	pause(): void;
	forget(goalId: string): void;
}

export function createGoalAccounting(opts: { now?: () => number } = {}): GoalAccountingClock {
	const now = opts.now ?? (() => performance.now());
	let activeGoalId: string | null = null;
	let segmentStart: number | null = null;
	const carryMs = new Map<string, number>();

	return {
		begin(goalId) {
			activeGoalId = goalId;
			segmentStart = now();
		},
		settle(goalId) {
			if (activeGoalId !== goalId || segmentStart === null) return null;
			const elapsed = Math.max(0, now() - segmentStart);
			const total = elapsed + (carryMs.get(goalId) ?? 0);
			const seconds = Math.floor(total / 1000);
			carryMs.set(goalId, total - seconds * 1000);
			segmentStart = now();
			return seconds;
		},
		preview(goalId) {
			if (activeGoalId !== goalId || segmentStart === null) return 0;
			const elapsed = Math.max(0, now() - segmentStart);
			return Math.floor((elapsed + (carryMs.get(goalId) ?? 0)) / 1000);
		},
		pause() {
			activeGoalId = null;
			segmentStart = null;
		},
		forget(goalId) {
			carryMs.delete(goalId);
			if (activeGoalId === goalId) {
				activeGoalId = null;
				segmentStart = null;
			}
		},
	};
}
