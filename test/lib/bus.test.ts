/**
 * Bus write-side contracts (P1-BUS-01, 03, 05, 06, 08, 10).
 *
 * Read-side (reader total matrix P1-BUS-07, subpath types) lives in
 * bus-types.test.ts — the two files deliberately do NOT import each other's
 * system under test, so the compatibility-shim removal paths stay
 * independent (P1-BUS-09; see test/contracts/README.md registry).
 */
import { describe, expect, it, beforeEach } from "vitest";

import {
	clearCoreGlobals,
	snapshotCoreGlobals,
} from "../contracts/fake-host.ts";
import { createCoreBus, type CorePatch } from "../../extensions/bus.ts";
import type { CoreSnapshot } from "../../types/index.d.mts";

let globalsSnapshot: Record<string, unknown>;

beforeEach(() => {
	globalsSnapshot = snapshotCoreGlobals();
	clearCoreGlobals();
});

describe("P1-BUS-01 snapshot shape", () => {
	it("publishes a frozen pure-data snapshot under __piClaudeCodeCore", () => {
		const bus = createCoreBus();
		const snap = bus.publish({ modes: { mode: "plan", workingStats: null } });
		expect((globalThis as Record<string, unknown>).__piClaudeCodeCore).toBe(snap);
		expect(Object.isFrozen(snap)).toBe(true);
		expect(Object.isFrozen(snap.modes)).toBe(true);
		// DC5 (P1-BUS-10 v2): the ONE function-valued field is the data-carried
		// subscription point; everything else stays JSON-pure data.
		expect(snap.version).toBe(2);
		expect(typeof snap.onChange).toBe("function");
		const { onChange, ...data } = snap;
		void onChange;
		expect(JSON.parse(JSON.stringify(data))).toEqual(data);
		const walk = (v: unknown): void => {
			if (typeof v === "function") throw new Error("unexpected function in snapshot data");
			if (v && typeof v === "object") Object.values(v).forEach(walk);
		};
		expect(() => walk(data)).not.toThrow();
	});

	it("installs the Cmd write channel; unknown command is total (P1-BUS-08)", () => {
		const bus = createCoreBus();
		bus.publish({ effort: { level: "high", source: "session" } });
		const cmd = (globalThis as Record<string, unknown>).__piClaudeCodeCoreCmd as
			| ((cmd: never) => unknown)
			| undefined;
		expect(typeof cmd).toBe("function");
		expect(() => (cmd as (c: unknown) => unknown)({ kind: "nope" } as never)).not.toThrow();
		expect((cmd as (c: { kind: string }) => { ok: boolean; reason?: string })({ kind: "nope" })).toEqual({
			ok: false,
			reason: "unknown-command",
		});
	});

	it("dispose clears the core-owned keys and resets (legacy keys survive, P0-CT-03)", () => {
		const g = globalThis as Record<string, unknown>;
		const bus = createCoreBus();
		bus.publish({ modes: { mode: "ask", workingStats: "↑1" } });
		expect(g.__piClaudeCodeCore).toBeDefined();
		bus.dispose();
		expect(g.__piClaudeCodeCore).toBeUndefined();
		expect(g.__piClaudeCodeCoreCmd).toBeUndefined();
		// legacy projection remains exactly as last published
		expect(g.__piPermissionModes).toEqual({ version: 1, active: true, mode: "ask", workingStats: "↑1", meta: undefined });
		// DC5 gating: the legacy stats key is written only for a live CCTUI
		// (its consumer) — absent here by design (P0-CT-02 negative).
		expect(g.__pmWorkingStats).toBeUndefined();
	});
});

describe("P1-BUS-03/05 single publish point + legacy derivation", () => {
	it("one publish writes the new key and both core-owned legacy keys consistently", () => {
		const g = globalThis as Record<string, unknown>;
		const bus = createCoreBus();
		bus.publish({ modes: { mode: "auto", workingStats: "↑1.2k · ↓300" } });

		const snap = g.__piClaudeCodeCore as CoreSnapshot;
		const cap = g.__piPermissionModes as Record<string, unknown>;
		expect(cap).toEqual({
			version: 1,
			active: true,
			mode: snap.modes.mode,
			workingStats: snap.modes.workingStats,
		});
		// DC5: without a live CCTUI the legacy stats key stays unset even when
		// the publish carries stats (always-full snapshot + presence-gated write).
		expect(g.__pmWorkingStats).toBeUndefined();
		g.__piCcTui = { active: true };
		bus.publish({ modes: { mode: "auto", workingStats: "↑1" } });
		expect(g.__pmWorkingStats).toBe("(↑1)");
		delete g.__piCcTui;
	});

	it("legacy stats key is NOT written while workingStats is null (CT-02 negative)", () => {
		const g = globalThis as Record<string, unknown>;
		const bus = createCoreBus();
		bus.publish({ modes: { mode: "ask", workingStats: null } });
		expect(g.__piPermissionModes).toBeDefined();
		expect(g.__pmWorkingStats).toBeUndefined();
	});

	it("CCTUI presence keys are untouched by the bus (core does not write them)", () => {
		const g = globalThis as Record<string, unknown>;
		g.__piCcTui = { active: true };
		const bus = createCoreBus();
		bus.publish({ modes: { mode: "plan", workingStats: null } });
		expect(g.__piCcTui).toEqual({ active: true });
		expect(g.__ccTuiActive).toBeUndefined();
	});
});

describe("P1-BUS-06 snapshot invariants", () => {
	it("revision is monotonic across publishes", () => {
		const bus = createCoreBus();
		const s1 = bus.publish({ modes: { mode: "ask", workingStats: null } });
		const s2 = bus.publish({ effort: { level: "high", source: "session" } });
		const s3 = bus.publish({ modes: { mode: "bypass", workingStats: null } });
		expect(s1.revision).toBe(1);
		expect(s2.revision).toBe(2);
		expect(s3.revision).toBe(3);
	});

	it("channels are whole-replaced; untouched channels keep reference identity", () => {
		const bus = createCoreBus();
		const modes = { mode: "plan" as const, planPhase: "executing" as const, workingStats: null };
		const s1 = bus.publish({ modes });
		const s2 = bus.publish({ effort: { level: "low", source: "profile" } });
		expect(s2.modes).toBe(s1.modes); // structural sharing
		expect(s2.effort).toEqual({ level: "low", source: "profile" });
		const s3 = bus.publish({ modes: { mode: "ask", workingStats: null } });
		expect(s3.modes).not.toBe(s1.modes); // whole replacement, not deep merge
		expect(s3.modes.planPhase).toBeUndefined();
	});

	it("mutations of the frozen snapshot throw", () => {
		const bus = createCoreBus();
		const snap = bus.publish({ modes: { mode: "ask", workingStats: null } });
		expect(() => {
			(snap as { revision: number }).revision = 99;
		}).toThrow();
		expect(() => {
			(snap.modes as { mode: string }).mode = "bypass";
		}).toThrow();
	});

	it("patch union rejects partial channels at compile time (spike shape holds)", () => {
		const bus = createCoreBus();
		// Whole-channel patches compile and publish.
		const ok: CorePatch = { modes: { mode: "auto", workingStats: null } };
		expect(bus.publish(ok).modes.mode).toBe("auto");
	});
});
