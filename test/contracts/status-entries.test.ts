import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { clearCoreGlobals, restoreCoreGlobals, snapshotCoreGlobals, snapshotEnv, restoreEnv } from "./fake-host.ts";
import { setupTarget } from "./helpers.ts";
import { targets } from "./targets.ts";
import { RECALL_CUSTOM_TYPE, RECALL_DETAILS_FIELDS, renderRecallBlock } from "../../extensions/memory/recall.ts";

const ALLOWED_STATUS_SLOTS = new Set(["modes", "pi-effort-thinking", "pi-effort-fast", "goal"]);
const ALLOWED_CLEANUP_SLOTS = new Set(["effort"]);
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
		expect(seen.has("modes")).toBe(true);
	});
});

describe("P0-CT-08 (RV): pi-memory-recall frozen shape", () => {
	it("customType string + details v1 field set are frozen (spec 2026-10-02-memory-recall-v2)", () => {
		expect(RECALL_CUSTOM_TYPE).toBe("pi-memory-recall");
		expect([...RECALL_DETAILS_FIELDS]).toEqual(["v", "delivery", "model", "files", "bytes", "elapsedMs"]);
		const block = renderRecallBlock(
			[
				{
					key: "memory/a.md",
					file: "a.md",
					title: "a",
					description: "d",
					type: "project",
					layer: "project",
					mtimeMs: Date.now() - 47 * 86_400_000,
					absPath: "/tmp/mem/a.md",
					body: "b",
				},
			],
			{ model: "test/selector-1", elapsedMs: 3, remainingSessionBytes: 60_000 },
		);
		expect(block).not.toBeNull();
		expect(Object.keys(block!.details).sort()).toEqual([...RECALL_DETAILS_FIELDS].sort());
	});
});
