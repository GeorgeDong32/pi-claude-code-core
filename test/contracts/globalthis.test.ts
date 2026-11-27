import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearCoreGlobals, restoreCoreGlobals, snapshotCoreGlobals, usageAssistantEntry } from "./fake-host.ts";
import { setupModes } from "./helpers.ts";
import type { SetupResult } from "./helpers.ts";

let globalsSnapshot: Record<string, unknown>;

beforeEach(() => {
	globalsSnapshot = snapshotCoreGlobals();
	clearCoreGlobals();
});

afterEach(() => {
	restoreCoreGlobals(globalsSnapshot);
	vi.useRealTimers();
});

describe("P0-CT §4.1 globalThis capability channel", () => {
	let s: SetupResult;

	beforeEach(async () => {
		s = setupModes();
		const ctx = s.host.makeCtx({ cwd: s.cwd, ui: true });
		await s.host.fire("session_start", {}, ctx);
	});

	it("P0-CT-01: instantiating modes publishes __piPermissionModes with the PmCapability shape", () => {
		const cap = (globalThis as Record<string, unknown>).__piPermissionModes as Record<string, unknown>;
		expect(cap).toBeDefined();
		expect(cap.version).toBeTypeOf("number");
		expect(cap.active).toBe(true);
		expect(typeof cap.mode).toBe("string");
		expect(cap.workingStats === null || typeof cap.workingStats === "string").toBe(true);
		expect(cap.workingStats).toBeNull();
		const meta = cap.meta as Record<string, { icon: string; label: string; role: string }> | undefined;
		expect(meta).toBeDefined();
		expect(meta!["ask"]!.icon).toBe("●");
		expect(meta!["bypass"]!.label).toBe("Bypass");
		expect(Object.isFrozen(meta)).toBe(true);
	});

	it("P0-CT-02: with CCTUI present, pm suppresses its own working line and publishes stats to both legacy keys", async () => {
		const g = globalThis as Record<string, unknown>;
		g.__piCcTui = { active: true };

		const ctx = s.host.makeCtx({
			cwd: s.cwd,
			ui: true,
			sessionEntries: [usageAssistantEntry()],
		});
		await s.host.fire("message_update", {}, ctx);

		expect(s.host.workingMessageCalls).toHaveLength(0);
		const cap = g.__piPermissionModes as { workingStats: unknown };
		expect(typeof cap.workingStats).toBe("string");
		expect(cap.workingStats).toContain("↑");
		const legacy = g.__pmWorkingStats;
		expect(typeof legacy).toBe("string");
		expect((legacy as string).startsWith("(")).toBe(true);
	});

	it("P0-CT-02 (legacy detector variant): __ccTuiActive=true is honored too", async () => {
		const g = globalThis as Record<string, unknown>;
		g.__ccTuiActive = true;

		const ctx = s.host.makeCtx({
			cwd: s.cwd,
			ui: true,
			sessionEntries: [usageAssistantEntry()],
		});
		await s.host.fire("message_update", {}, ctx);
		expect(s.host.workingMessageCalls).toHaveLength(0);
		expect(typeof g.__pmWorkingStats).toBe("string");
	});

	it("P0-CT-02 (negative): without CCTUI the working line is owned by pm itself", async () => {
		const ctx = s.host.makeCtx({
			cwd: s.cwd,
			ui: true,
			sessionEntries: [usageAssistantEntry()],
		});
		await s.host.fire("message_update", {}, ctx);
		expect(s.host.workingMessageCalls.length).toBeGreaterThan(0);
		expect((globalThis as Record<string, unknown>).__pmWorkingStats).toBeUndefined();
	});

	it("P0-CT-03: after session_shutdown the key REMAINS with active:true (pin current behavior) and the forwarding poller stops", async () => {
		vi.useFakeTimers();
		// vi.getTimerCount() only sees timers registered after useFakeTimers, so
		// the instance whose poller is measured is created inside this scope.
		const s2 = setupModes();
		const ctx = s2.host.makeCtx({ cwd: s2.cwd, ui: true });
		await s2.host.fire("session_start", {}, ctx);

		const g = globalThis as Record<string, unknown>;
		const before = g.__piPermissionModes as { mode: string; active: boolean };
		expect(before).toBeDefined();

		const timersDuringSession = vi.getTimerCount();
		expect(timersDuringSession).toBeGreaterThan(0);

		await s2.host.fire("session_shutdown", {}, ctx);

		const after = g.__piPermissionModes as { mode: string; active: boolean };
		expect(after).toBeDefined();
		expect(after.active).toBe(true);
		expect(after.mode).toBe(before.mode);
		expect(vi.getTimerCount()).toBe(timersDuringSession - 1);
	});
});
