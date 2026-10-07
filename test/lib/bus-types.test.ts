/**
 * Reader-side contracts (P1-BUS-02, 07): the `./types` subpath total reader.
 * The legacy-fallback assertions below exercise ONLY the reader — the bus
 * write-side (extensions/bus.ts) is not imported in the legacy tests, so the
 * reader's legacy branch and the write-side legacy aliases can be removed
 * independently (P1-BUS-09, registry: test/contracts/README.md). The single
 * dynamic import in the last test is a shape-compatibility guard only.
 */
import { describe, expect, it } from "vitest";

// Runtime from the twin-free .mjs (vite resolves it literally); types from
// the published declaration module (type-only, erased before resolution).
import { readCoreStatus } from "../../types/core-status.mjs";
import type { CoreSnapshot } from "../../types/index.d.mts";

function snapWith(partial: Record<string, unknown>): CoreSnapshot {
	return {
		version: 1,
		revision: 1,
		modes: { mode: "", workingStats: null },
		effort: { level: null, source: "model-default" },
		goal: { active: false, summary: null },
		review: { status: "idle", lastRunAt: null },
		...partial,
	} as CoreSnapshot;
}

describe("P1-BUS-07 reader total matrix", () => {
	it("never throws and always returns a valid CoreStatus", () => {
		const garbage = {
			undefined: undefined,
			emptyObject: {},
			versionZero: { version: 0 },
			versionOne: snapWith({ modes: { mode: "plan", workingStats: "s" } }),
			futureVersion: { version: 99, modes: "garbage", effort: 42 },
			nullHost: null,
			primitiveHost: 42,
		};
		for (const value of Object.values(garbage)) {
			const status = readCoreStatus(value);
			expect(status).toBeTypeOf("object");
			expect(status.modes).toBeTypeOf("object");
			expect(typeof status.modes.mode).toBe("string");
			expect(status.effort).toBeTypeOf("object");
			expect(status.goal).toBeTypeOf("object");
			expect(status.review).toBeTypeOf("object");
			expect(typeof status.version).toBe("number");
		}
	});

	it("falls back: new key → legacy __piPermissionModes → defaults", () => {
		// defaults
		expect(readCoreStatus({})).toMatchObject({ version: 0, modes: { mode: "" } });
		// legacy pm capability
		const legacy = readCoreStatus({
			__piPermissionModes: { version: 1, active: true, mode: "ask", workingStats: "↑1" },
		});
		expect(legacy.modes).toEqual({ mode: "ask", workingStats: "↑1" });
		expect(legacy.effort.level).toBeNull();
		// new key wins over legacy
		const both = readCoreStatus({
			__piPermissionModes: { version: 1, active: true, mode: "ask", workingStats: null },
			__piClaudeCodeCore: snapWith({ modes: { mode: "bypass", workingStats: null } }),
		});
		expect(both.modes.mode).toBe("bypass");
	});

	it("reads the full snapshot shape including optional channels", () => {
		const snapshot = snapWith({
			modes: { mode: "plan", planPhase: "reviewing", workingStats: "↑2 · $0.01" },
			effort: { level: "xhigh", source: "env" },
			goal: { active: true, summary: "ship it" },
			review: { status: "running", lastRunAt: 1758400000000 },
			display: { footer: ["modes:plan", "effort:xhigh"] },
		});
		const status = readCoreStatus({ __piClaudeCodeCore: snapshot });
		expect(status.modes).toEqual({ mode: "plan", planPhase: "reviewing", workingStats: "↑2 · $0.01" });
		expect(status.effort).toEqual({ level: "xhigh", source: "env" });
		expect(status.goal).toEqual({ active: true, summary: "ship it" });
		expect(status.review).toEqual({ status: "running", lastRunAt: 1758400000000 });
		expect(status.display?.footer).toEqual(["modes:plan", "effort:xhigh"]);
	});

	it("snapshot type and bus implementation agree (twin-shape guard)", async () => {
		// Compile-time: CoreSnapshot from types/ satisfies the bus's expectation.
		const { createCoreBus } = await import("../../extensions/bus.ts");
		const bus = createCoreBus();
		const published = bus.publish({ modes: { mode: "auto", workingStats: null } });
		const read = readCoreStatus({ __piClaudeCodeCore: published });
		// The reader's projection of a real publish matches the published data.
		expect(read.modes.mode).toBe("auto");
		// DC5: publishes are v2 (onChange DATA field); readers accept >=1.
		expect(read.version).toBe(2);
		expect(read.revision).toBe(published.revision);
	});
});

// ---- SPEC 2026-10-07 P2-4: XPKG-08 twin guard (U-T1) ------------------------
describe("P2-4 XPKG-08: modes.usage twin guard", () => {
	it("U-T1: a REAL bus publish of modes.usage satisfies the published CoreSnapshot type (compile-time + runtime shape)", async () => {
		// dynamic import keeps the legacy reader tests independent of the
		// write side (same pattern as the shape-compatibility guard above)
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
		// compile-time: the publish result IS a CoreSnapshot
		const check: CoreSnapshot = snap;
		// runtime: every declared field round-trips
		expect(check.modes.usage).toEqual(usage);
		// optional-only publish (tps/ctx absent) also satisfies the type
		const partial = bus.publish({
			modes: { mode: "auto", workingStats: null, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0 } } as CoreSnapshot["modes"],
		});
		expect(partial.modes.usage).toEqual({ input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0 });
		bus.dispose();
	});
});
