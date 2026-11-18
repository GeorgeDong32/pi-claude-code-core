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
