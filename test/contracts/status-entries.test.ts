/**
 * P0-CT §4.3 + §4.4 — status-slot and session-entry type contracts
 * (P0-CT-07, P0-CT-08).
 *
 * All four factories are instantiated into ONE host and their session_start
 * is fired, then the recorded setStatus/setWidget/appendEntry calls are
 * checked against the frozen whitelists. Any new slot/key/entry type a
 * module starts using turns these red (that is the point).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { clearCoreGlobals, restoreCoreGlobals, snapshotCoreGlobals, snapshotEnv, restoreEnv } from "./fake-host.ts";
import { setupTarget } from "./helpers.ts";
import { targets } from "./targets.ts";

const ALLOWED_STATUS_SLOTS = new Set(["modes", "pi-effort-thinking", "pi-effort-fast", "goal"]);
const ALLOWED_CLEANUP_SLOTS = new Set(["effort"]); // pi-effort clears the legacy aggregate slot with undefined
const ALLOWED_WIDGET_KEYS = new Set(["plan-todos", "goal"]);
const ALLOWED_ENTRY_TYPES = new Set([
	"modes",
	"pi-goal-state",
	"pi-goal-focus",
	"pi-goal-event",
	"pi-goal-audit-event",
	"pi-review",
	"pi-review-directive",
]);

let globalsSnapshot: Record<string, unknown>;
let envSnapshot: Record<string, string | undefined>;

beforeEach(() => {
	globalsSnapshot = snapshotCoreGlobals();
	clearCoreGlobals();
	envSnapshot = snapshotEnv();
});

afterEach(() => {
	restoreEnv(envSnapshot);
	restoreCoreGlobals(globalsSnapshot);
});

describe("P0-CT §4.3 status slots + §4.4 session entry types", () => {
	it("P0-CT-07: all four modules together touch only their whitelisted status slots and widget keys", async () => {
		const hosts = [] as ReturnType<typeof setupTarget>[];
		for (const target of Object.values(targets)) {
			const s = setupTarget(target);
			hosts.push(s);
			const ctx = s.host.makeCtx({ cwd: s.cwd, ui: true });
			await s.host.fire("session_start", { cwd: s.cwd }, ctx);
		}

		for (const s of hosts) {
			for (const call of s.host.statusCalls) {
				// Slot names must stay inside the whitelist. The legacy
				// aggregate "effort" slot is tolerated ONLY as a cleanup write
				// (value undefined) — a real value there is a contract break.
				if (call.slot === "effort") {
					expect(call.value).toBeUndefined();
					continue;
				}
				expect(
					ALLOWED_STATUS_SLOTS.has(call.slot),
					`non-whitelisted status slot ${JSON.stringify(call.slot)}`,
				).toBe(true);
			}
			for (const call of s.host.widgetCalls) {
				expect(ALLOWED_WIDGET_KEYS.has(call.key), `non-whitelisted widget key ${JSON.stringify(call.key)}`).toBe(true);
			}
		}
	});

	it("P0-CT-07 (tolerated cleanup): pi-effort's cleanup write to the legacy 'effort' slot carries value undefined", async () => {
		const s = setupTarget(targets.effort);
		const ctx = s.host.makeCtx({ cwd: s.cwd, ui: true });
		await s.host.fire("session_start", {}, ctx);
		const effortCleanup = s.host.statusCalls.filter((c) => c.slot === "effort");
		for (const call of effortCleanup) {
			expect(call.value).toBeUndefined();
		}
	});

	it("P0-CT-08: appendEntry types across all four modules stay inside the session-compat whitelist", async () => {
		const hosts = [] as ReturnType<typeof setupTarget>[];
		for (const target of Object.values(targets)) {
			const s = setupTarget(target);
			hosts.push(s);
			const ctx = s.host.makeCtx({ cwd: s.cwd, ui: true });
			await s.host.fire("session_start", {}, ctx);
			// pm writes its `modes` persistence entry on explicit switches
			// (not on session_start): exercise the shift+tab cycle path.
			if (target === targets.modes) {
				const cycle = s.host.shortcuts.get("shift+tab");
				expect(cycle).toBeDefined();
				await cycle?.(ctx);
			}
		}
		const seen = new Set<string>();
		for (const s of hosts) {
			for (const entry of s.host.appendEntries) {
				seen.add(entry.type);
				expect(
					ALLOWED_ENTRY_TYPES.has(entry.type),
					`non-whitelisted session entry type ${JSON.stringify(entry.type)}`,
				).toBe(true);
			}
		}
		// Non-vacuous: pm's `modes` entry must have fired via the switch path.
		// (goal/review entry types fire on their commands — exercised by the
		// P2 migration suites, pinned here only as "nothing outside the
		// whitelist at instantiation + session_start".)
		expect(seen.has("modes")).toBe(true);
	});
});
