/**
 * classifier-retry.ts — the classifier retry seam (SPEC 2026-10-07 P2-1
 * Step 3, A4=B). Two concerns, deliberately kept apart:
 *
 *  - ClassifierClock: injectable now/setTimer/clearTimer. The per-attempt
 *    timeout inside classifyToolCall runs entirely on this clock, so tests
 *    drive attempts × timeoutMs deterministically instead of measuring real
 *    wall time (replaces the AR1005-R3 flaky 40ms-timer test). Timers and
 *    abort listeners are released on every exit path by the clock contract:
 *    setTimer returns a handle, clearTimer must accept it on every branch.
 *  - runClassifierAttempts: the VISIBLE retry layer (plan2 B2). Same attempt
 *    count and retry condition as the old inline loop (every transport error
 *    is retryable; verdict-level denial is NOT a retry — that decision stays
 *    with the caller). The mechanism lives here so the gate no longer owns
 *    retry knowledge.
 */
export interface ClassifierClock {
	now(): number;
	setTimer(fn: () => void, ms: number): unknown;
	clearTimer(handle: unknown): void;
}

export const realClassifierClock: ClassifierClock = {
	now: () => Date.now(),
	setTimer: (fn, ms) => setTimeout(fn, ms),
	clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** Fake clock for tests: timers fire only when the test advances them. */
export function fakeClassifierClock(startNow = 0): ClassifierClock & {
	advance(ms: number): void;
	timers: Array<{ fn: () => void; at: number; cleared: boolean }>;
} {
	let now = startNow;
	const timers: Array<{ fn: () => void; at: number; cleared: boolean }> = [];
	return {
		now: () => now,
		setTimer(fn, ms) {
			const t = { fn, at: now + ms, cleared: false };
			timers.push(t);
			return t;
		},
		clearTimer(handle) {
			const t = handle as { cleared: boolean } | undefined;
			if (t) t.cleared = true;
		},
		advance(ms) {
			now += ms;
			// fire due timers; a cleared timer never fires
			for (const t of [...timers]) {
				if (!t.cleared && t.at <= now) {
					t.cleared = true;
					t.fn();
				}
			}
		},
		timers,
	};
}

export interface ClassifierRetryOutcome<T> {
	ok: boolean;
	value?: T;
	error?: unknown;
	attempts: number;
}

/**
 * The visible retry layer: up to `attempts` transport calls, retrying on
 * ANY thrown error (the old loop's condition — the SDK layer runs with
 * maxRetries: 0). Verdict handling is the caller's business; this function
 * only decides "try again or give up".
 */
export async function runClassifierAttempts<T>(deps: {
	attempt: (n: number) => Promise<T>;
	attempts: number;
	onRetry?: (n: number, error: unknown) => void;
}): Promise<ClassifierRetryOutcome<T>> {
	let lastError: unknown;
	for (let n = 1; n <= deps.attempts; n++) {
		try {
			const value = await deps.attempt(n);
			return { ok: true, value, attempts: n };
		} catch (error) {
			lastError = error;
			if (n < deps.attempts) deps.onRetry?.(n, error);
		}
	}
	return { ok: false, error: lastError, attempts: deps.attempts };
}
