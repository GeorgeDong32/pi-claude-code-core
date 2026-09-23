/**
 * DC3 §4.1: notification tail queue contract — monotonic ids, cap 20,
 * newest last, frozen snapshot invariant, no ACK.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { coreBus, resetCoreBusForTests } from "../../extensions/bus.ts";
import { publishNotification, notify } from "../../extensions/ui/notify.ts";

// The queue lives on the shared bus singleton (that is the runtime
// contract), so tests reset it rather than injecting instances.
beforeEach(() => resetCoreBusForTests());
afterEach(() => resetCoreBusForTests());

describe("notification tail queue (DC3)", () => {
	it("appends with monotonic ids, newest last", () => {
		publishNotification("info", "one");
		publishNotification("warning", "two");
		const q = coreBus().snapshot().notifications!;
		expect(q.map((n) => n.msg)).toEqual(["one", "two"]);
		expect(q.map((n) => n.id)).toEqual([1, 2]);
		expect(q[1]!.level).toBe("warning");
	});

	it("caps at 20 — old items are pushed out, ids keep climbing", () => {
		for (let i = 1; i <= 25; i++) publishNotification("info", `m${i}`);
		const q = coreBus().snapshot().notifications!;
		expect(q).toHaveLength(20);
		expect(q[0]!.id).toBe(6);
		expect(q[0]!.msg).toBe("m6");
		expect(q[19]!.msg).toBe("m25");
	});

	it("queue inside the snapshot stays frozen", () => {
		publishNotification("error", "boom");
		const q = coreBus().snapshot().notifications!;
		expect(Object.isFrozen(q)).toBe(true);
		expect(() => (q as unknown as { push(x: unknown): void }).push({ id: 99, level: "info", msg: "x" })).toThrow();
	});

	it("notify() forwards directly only while a cctui is live (legacy cctui leg)", () => {
		const seen: [string, string][] = [];
		const ctxLike = { hasUI: true, ui: { notify: (m: string, l: string) => seen.push([m, l]) } };
		(globalThis as Record<string, unknown>).__piCcTui = { active: true };
		try {
			notify(ctxLike, "hello", "info");
			expect(seen).toEqual([["hello", "info"]]);
		} finally {
			delete (globalThis as Record<string, unknown>).__piCcTui;
		}
		// No cctui: the fallback adapter owns the display; no direct write.
		notify(ctxLike, "quiet", "warning");
		expect(coreBus().snapshot().notifications!.map((n) => n.msg)).toEqual(["hello", "quiet"]);
		expect(seen).toHaveLength(1);
	});

	it("notify() never writes directly on the print path", () => {
		const seen: [string, string][] = [];
		notify({ hasUI: false, ui: { notify: (m, l) => seen.push([m, l]) } }, "quiet", "warning");
		expect(coreBus().snapshot().notifications!.map((n) => n.level)).toEqual(["warning"]);
		expect(seen).toHaveLength(0);
	});
});
