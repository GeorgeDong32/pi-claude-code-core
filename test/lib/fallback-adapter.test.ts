/** DC5 §4.3 option C: fallback adapter — yield-to-cctui at the write point. */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { createFallbackAdapter, type FallbackHost } from "../../extensions/ui/fallback.ts";
import { coreBus, resetCoreBusForTests } from "../../extensions/bus.ts";
import { publishNotification } from "../../extensions/ui/notify.ts";

function fakeHost(): { host: FallbackHost; calls: (string | undefined)[]; notes: [string, string][] } {
	const calls: (string | undefined)[] = [];
	const notes: [string, string][] = [];
	return {
		host: {
			hasUI: true,
			setWorkingMessage: (m) => calls.push(m),
			notify: (m, l) => notes.push([m, l]),
			theme: { fg: (_r, s) => `<dim>${s}</dim>` },
		},
		calls,
		notes,
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
			notify: () => {},
			theme: { fg: (_r, s) => s },
		});
		adapter.onSnapshot(snap("↑1"));
		expect(calls).toEqual([]);
	});
});

describe("fallback adapter notifications (DC5b)", () => {
	it("startup subscribes via onChange: publishes surface without a manual onSnapshot", () => {
		const { host, notes } = fakeHost();
		const adapter = createFallbackAdapter(host);
		adapter.startup();
		publishNotification("info", "queue-rendered");
		expect(notes).toEqual([["queue-rendered", "info"]]);
		adapter.shutdown();
	});

	it("a live cctui advances the cursor without replaying history later", () => {
		const { host, notes } = fakeHost();
		const adapter = createFallbackAdapter(host);
		adapter.startup();
		g.__piCcTui = { active: true };
		publishNotification("info", "for-cctui"); // direct-forwarded by notify(), not here
		expect(notes).toEqual([]);
		delete g.__piCcTui;
		publishNotification("info", "back-to-fallback");
		expect(notes).toEqual([["back-to-fallback", "info"]]);
		adapter.shutdown();
	});

	it("publish() keeps the frozen invariant with the consumer attached", () => {
		const { host } = fakeHost();
		const adapter = createFallbackAdapter(host);
		adapter.startup();
		publishNotification("error", "still-frozen");
		expect(Object.isFrozen(coreBus().snapshot().notifications)).toBe(true);
		adapter.shutdown();
	});
});
