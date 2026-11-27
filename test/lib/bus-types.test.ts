import { describe, expect, it } from "vitest";

import type { CoreSnapshot } from "../../types/index.d.mts";

describe("D4-READER-REMOVE: published type twin tracks the real bus shape", () => {
	it("a REAL bus publish satisfies CoreSnapshot and round-trips every declared channel (incl. instance)", async () => {
		const { createCoreBus } = await import("../../extensions/bus.ts");
		const bus = createCoreBus();
		const published = bus.publish({
			modes: { mode: "auto", workingStats: "↑1.2k" } as CoreSnapshot["modes"],
		});
		const check: CoreSnapshot = published;
		expect(check.version).toBe(2);
		expect(typeof check.instance).toBe("string");
		expect(check.instance).toBeTruthy();
		const again = bus.publish({ effort: { level: "high", source: "session" } });
		expect(again.instance).toBe(check.instance);
		expect(again.revision).toBeGreaterThan(check.revision);
		const patched = bus.publish({ instance: "spoofed" } as Partial<CoreSnapshot>);
		expect(patched.instance).toBe(check.instance);
		bus.dispose();
	});

	it("optional channels round-trip: display.footer, contextBudget, notifications, observation, fusion", async () => {
		const { createCoreBus } = await import("../../extensions/bus.ts");
		const bus = createCoreBus();
		const snap = bus.publish({
			display: { footer: ["modes:plan", "effort:xhigh"] },
			contextBudget: { rulesMax: 40000, memoryIndexMax: 25000, dynamicSteerMax: 8000 },
			notifications: [{ id: 1, level: "info", msg: "hi" }],
			observation: { tokensAvoided: 5, placeholders: 1 },
			fusion: { fusedCount: 2 },
		} as Partial<CoreSnapshot>);
		const check: CoreSnapshot = snap;
		expect(check.display?.footer).toEqual(["modes:plan", "effort:xhigh"]);
		expect(check.contextBudget).toEqual({ rulesMax: 40000, memoryIndexMax: 25000, dynamicSteerMax: 8000 });
		expect(check.notifications).toEqual([{ id: 1, level: "info", msg: "hi" }]);
		expect(check.observation).toEqual({ tokensAvoided: 5, placeholders: 1 });
		expect(check.fusion).toEqual({ fusedCount: 2 });
		bus.dispose();
	});
});

describe("P2-4 XPKG-08: modes.usage twin guard", () => {
	it("U-T1: a REAL bus publish of modes.usage satisfies the published CoreSnapshot type (compile-time + runtime shape)", async () => {
		const { createCoreBus } = await import("../../extensions/bus.ts");
		const bus = createCoreBus();
		const usage = {
			input: 1200,
			output: 340,
			cacheRead: 5000,
			cacheWrite: 0,
			cost: 0.012,
			tps: 42.5,
			ctxTokens: 10,
			ctxPercent: 0.01,
			contextWindow: 100_000,
		};
		const snap = bus.publish({
			modes: { mode: "auto", workingStats: "↑1.2k", usage } as CoreSnapshot["modes"],
		});
		const check: CoreSnapshot = snap;
		expect(check.modes.usage).toEqual(usage);
		const partial = bus.publish({
			modes: { mode: "auto", workingStats: null, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0 } } as CoreSnapshot["modes"],
		});
		expect(partial.modes.usage).toEqual({ input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0 });
		bus.dispose();
	});
});
