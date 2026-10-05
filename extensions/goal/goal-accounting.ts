/*
 * goal/goal-accounting.ts — the goal activity clock (AR1005-GO-A, spec
 * 2026-10-05 §7.2). ONE owner for: which goal is on the clock, the current
 * activity segment's start, and each unfinished goal's millisecond
 * remainder (carry). goal.ts previously scattered these as two writable
 * variables and lost the sub-second remainder on EVERY settle — the
 * reproduced defect: 8 × 250 ms tool-end events recorded 0 seconds of a
 * real 2 seconds (floor-then-reset), and one more second recorded only 1.
 *
 * Interface (four capabilities):
 *   begin(goalId)      start a NEW activity segment for the goal (resets
 *                      the segment start; the goal's accumulated carry is
 *                      KEPT — begin is not a no-op and not a wipe)
 *   settle(goalId)     close the current segment delta and re-arm it:
 *                      elapsed + carry → floor(total/1000) whole seconds
 *                      returned to add to activeSeconds, the remainder
 *                      stays as carry. null when no segment is active for
 *                      this goal (caller re-begins). Zero-token/zero-cost
 *                      events still keep their carry — the clock is never
 *                      reset by a settle.
 *   preview(goalId)    read-only whole-second preview (current segment +
 *                      carry) for display; consumes nothing, so repeated
 *                      renders never add seconds. 0 when not active.
 *   pause()            drop the current segment (drafting / paused /
 *                      confirmation / focus switch) — carries are kept so
 *                      a resume continues accumulating fragments.
 *   forget(goalId)     release a goal's carry (complete / abort / delete —
 *                      the remainder can never be consumed again).
 *
 * Per-goal carries never cross-contaminate; focus A/B switches and
 * pause/resume preserve each goal's own remainder within the process.
 *
 * GO-A-02 (frozen disk format): records keep integer activeSeconds and
 * gain NO carryMs field — a process restart loses at most the
 * not-yet-persisted sub-second remainder of the current segment. That is
 * the accepted trade for not migrating the frozen record format; it does
 * NOT regress to per-event remainder loss.
 *
 * The clock reads time through an injected seam (tests pass a fixed
 * clock); production uses a monotonic clock. Wall-clock timestamps
 * (updatedAt, ledger `at`) stay with the existing Date.now()/nowIso()
 * call sites in goal.ts.
 */

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
			segmentStart = now(); // re-arm: the segment continues from here
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
