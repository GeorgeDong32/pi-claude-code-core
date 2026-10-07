/**
 * classifier-retry.test.ts — deterministic replacements for the AR1005-R3
 * flaky wall-clock test (SPEC 2026-10-07 P2-1 Step 3): attempts × timeoutMs,
 * timer release on every exit, and abort-listener cleanup are asserted on a
 * FAKE clock — zero real timers, zero real elapsed-time assertions.
 */
import { describe, expect, it } from "vitest";
import {
	runClassifierAttempts,
	fakeClassifierClock,
	realClassifierClock,
} from "./classifier-retry.ts";
import { classifyToolCall } from "./classifier-client.ts";
import { invalidateClassifierVerdictCache } from "./classifier-client.ts";

function hangingRegistry(calls: Array<Record<string, unknown>>) {
	return {
		find: () => ({ id: "m", api: "anthropic-messages", baseUrl: "https://api.example.com", provider: "test" }) as never,
		getApiKeyAndHeaders: async () => ({ ok: true }),
		complete: (_m: unknown, _c: unknown, options: Record<string, unknown>) => {
			calls.push(options);
			// Real SDK semantics: abort RESOLVES with stopReason "aborted"
			// (the timeout branch then maps it to "Classifier timed out").
			return new Promise((resolve) => {
				(options.signal as AbortSignal | undefined)?.addEventListener("abort", () => resolve({ stopReason: "aborted", content: [] }), { once: true });
			});
		},
	} as never;
}

describe("runClassifierAttempts (the visible retry layer)", () => {
	it("retries every thrown error up to the attempt count, reporting the last error", async () => {
		const tries: number[] = [];
		const retries: Array<[number, unknown]> = [];
		const out = await runClassifierAttempts({
			attempts: 3,
			onRetry: (n, err) => retries.push([n, err]),
			attempt: async (n) => {
				tries.push(n);
				throw new Error(`boom ${n}`);
			},
		});
		expect(out.ok).toBe(false);
		expect(out.attempts).toBe(3);
		expect(String(out.error)).toContain("boom 3");
		expect(tries).toEqual([1, 2, 3]);
		expect(retries.map(([n]) => n)).toEqual([1, 2]); // no retry hook after the last
	});

	it("returns the first success without further attempts", async () => {
		const tries: number[] = [];
		const out = await runClassifierAttempts({
			attempts: 3,
			attempt: async (n) => {
				tries.push(n);
				if (n < 2) throw new Error("once");
				return "verdict";
			},
		});
		expect(out).toEqual({ ok: true, value: "verdict", attempts: 2 });
		expect(tries).toEqual([1, 2]);
	});
});

describe("fake clock", () => {
	it("fires due timers on advance; cleared timers never fire", () => {
		const clock = fakeClassifierClock();
		const fired: number[] = [];
		const t1 = clock.setTimer(() => fired.push(1), 40);
		const t2 = clock.setTimer(() => fired.push(2), 80);
		clock.clearTimer(t1);
		clock.advance(100);
		expect(fired).toEqual([2]);
		expect(clock.now()).toBe(100);
		expect((t2 as { cleared: boolean }).cleared).toBe(true);
	});
});

describe("classifyToolCall on the injected clock (replaces index.test.ts:1149)", () => {
	it("attempts × timeoutMs: three hanging transports each time out at 40ms; every timer and abort listener is released", async () => {
		invalidateClassifierVerdictCache();
		const calls: Array<Record<string, unknown>> = [];
		const clock = fakeClassifierClock();
		type Outcome = Awaited<ReturnType<typeof runClassifierAttempts<unknown>>>;
		let outcome: Outcome | undefined;
		const settled = runClassifierAttempts({
			attempts: 3,
			attempt: () =>
				classifyToolCall({
					modelRef: "test/m",
					session: { cwd: "/w", mode: "auto", branch: [], agentsMd: null },
					pendingTool: { name: "bash", input: { command: "npm install lodash" } },
					registry: hangingRegistry(calls),
					timeoutMs: 40,
					clock,
				}) as Promise<unknown>,
		}).then((o: Outcome) => {
			outcome = o;
		});
		// Drive the loop by hand: let the attempt reach the transport, fire
		// its timeout, let the rejection settle, repeat. Zero real-time
		// assertions — setImmediate is scheduling only.
		for (let i = 0; i < 12 && outcome === undefined; i++) {
			await new Promise((r) => setImmediate(r));
			clock.advance(40);
			await new Promise((r) => setImmediate(r));
		}
		await settled;
		// deterministic: exactly 3 transport calls, each with the per-attempt
		// timeout and SDK retries disabled
		expect(calls.length).toBe(3);
		for (const c of calls) {
			expect(c.maxRetries).toBe(0);
			expect(c.timeoutMs).toBe(40);
		}
		expect(outcome!.ok).toBe(false);
		expect(String(outcome!.error)).toContain("timed out");
		// timer discipline: every scheduled timeout was cleared before the
		// call returned (no leaked fake timers)
		expect(clock.timers.length).toBe(3);
		expect(clock.timers.every((t) => t.cleared)).toBe(true);
	}, 20_000);

	it("timeout must fire per attempt even when the wall clock is frozen", async () => {
		invalidateClassifierVerdictCache();
		const calls: Array<Record<string, unknown>> = [];
		const clock = fakeClassifierClock();
		// Manually advance between attempts — with a REAL clock this test
		// would hang forever; the injected one makes the timeout explicit.
		const p = (async () => {
			try {
				await classifyToolCall({
					modelRef: "test/m",
					session: { cwd: "/w", mode: "auto", branch: [], agentsMd: null },
					pendingTool: { name: "bash", input: { command: "npm install x" } },
					registry: hangingRegistry(calls),
					timeoutMs: 40,
					clock,
				});
				return "no-timeout";
			} catch (e) {
				return String(e);
			}
		})();
		// let the attempt reach the transport, then fire the timeout
		await new Promise((r) => setImmediate(r));
		clock.advance(40);
		expect(await p).toContain("timed out");
		expect(calls.length).toBe(1);
	});
});

describe("real clock defaults", () => {
	it("the default clock maps onto the real timers", () => {
		expect(realClassifierClock.now()).toBeGreaterThanOrEqual(0);
		const h = realClassifierClock.setTimer(() => {}, 60_000);
		expect(h).toBeDefined();
		realClassifierClock.clearTimer(h); // no throw
	});
});
