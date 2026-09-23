/** DC5 §4.3 option C: fallback adapter — yield-to-cctui at the write point. */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { createFallbackAdapter, type FallbackHost } from "../../extensions/ui/fallback.ts";
import { resetCoreBusForTests } from "../../extensions/bus.ts";

function fakeHost(): { host: FallbackHost; calls: (string | undefined)[] } {
	const calls: (string | undefined)[] = [];
	return {
		host: {
			hasUI: true,
			setWorkingMessage: (m) => calls.push(m),
			theme: { fg: (_r, s) => `<dim>${s}</dim>` },
		},
		calls,
	};
}

const g = globalThis as Record<string, unknown>;

beforeEach(() => {
	resetCoreBusForTests();
	delete g.__piCcTui;
	delete g.__ccTuiActive;
});
afterEach(() => {
	delete g.__piCcTui;
	delete g.__ccTuiActive;
});

const snap = (workingStats: string | null) =>
	({ version: 2, revision: 1, modes: { mode: "ask", workingStats }, effort: { level: null, source: "model-default" }, goal: { active: false, summary: null }, review: { status: "idle", lastRunAt: null } }) as never;

describe("fallback adapter (DC5)", () => {
	it("writes the dim working line when no cctui is live", () => {
		const { host, calls } = fakeHost();
		const adapter = createFallbackAdapter(host);
		adapter.onSnapshot(snap("↑1 · ↓2"));
		expect(calls).toEqual(["<dim>Working… (↑1 · ↓2)</dim>"]);
	});

	it("yields at the write point when a cctui is live (no arbiter, self-healing)", () => {
		const { host, calls } = fakeHost();
		const adapter = createFallbackAdapter(host);
		g.__piCcTui = { active: true };
		adapter.onSnapshot(snap("↑1"));
		expect(calls).toEqual([]);
		// Self-heal: key withdrawn → next snapshot writes again.
		delete g.__piCcTui;
		adapter.onSnapshot(snap("↑2"));
		expect(calls).toEqual(["<dim>Working… (↑2)</dim>"]);
	});

	it("clears the line when stats return to null; repeated snapshots are idempotent", () => {
		const { host, calls } = fakeHost();
		const adapter = createFallbackAdapter(host);
		adapter.onSnapshot(snap("↑1"));
		adapter.onSnapshot(snap("↑1")); // same stats → no rewrite
		adapter.onSnapshot(snap(null));
		expect(calls).toEqual(["<dim>Working… (↑1)</dim>", undefined]);
	});

	it("shutdown clears the line once", () => {
		const { host, calls } = fakeHost();
		const adapter = createFallbackAdapter(host);
		adapter.onSnapshot(snap("↑1"));
		adapter.shutdown();
		expect(calls[1]).toBeUndefined();
	});

	it("headless host (hasUI false) never writes", () => {
		const calls: (string | undefined)[] = [];
		const adapter = createFallbackAdapter({
			hasUI: false,
			setWorkingMessage: (m) => calls.push(m),
			theme: { fg: (_r, s) => s },
		});
		adapter.onSnapshot(snap("↑1"));
		expect(calls).toEqual([]);
	});
});
