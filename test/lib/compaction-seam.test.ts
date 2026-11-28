import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FakeHost, clearCoreGlobals, snapshotCoreGlobals } from "../contracts/fake-host.ts";
import { resetCoreBusForTests } from "../../extensions/bus.ts";
import {
	notifyAfter,
	notifyBefore,
	registerCompactionSubscriber,
	resetCompactionSeam,
	type CompactionSeamInfo,
} from "../../lib/compaction-seam.ts";
import goalExtension from "../../extensions/goal/goal.ts";
import modesExtension from "../../extensions/modes/index.ts";
import { writeActiveGoalFile, readActiveGoalFiles } from "../../extensions/goal/storage/goal-files.ts";
import { createGoal } from "../../extensions/goal/goal-record.ts";

let globalsSnapshot: Record<string, unknown>;
let prevHome: string | undefined;
let home: string;
let project: string;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function draftInfo(over: Partial<CompactionSeamInfo> = {}): CompactionSeamInfo {
	return { origin: "boundary-draft", midRun: false, summaryChars: 1234, tokensBefore: 90_000, ...over };
}

function seamSpy(): { before: number; after: number } {
	const counts = { before: 0, after: 0 };
	registerCompactionSubscriber({
		before: () => (counts.before += 1),
		after: () => (counts.after += 1),
	});
	return counts;
}

beforeEach(() => {
	globalsSnapshot = snapshotCoreGlobals();
	clearCoreGlobals();
	resetCoreBusForTests();
	resetCompactionSeam();
	prevHome = process.env.HOME;
	home = mkdtempSync(join(tmpdir(), "sc-seam-home-"));
	project = mkdtempSync(join(tmpdir(), "sc-seam-proj-"));
	process.env.HOME = home;
});

afterEach(() => {
	resetCompactionSeam();
	process.env.HOME = prevHome;
	rmSync(home, { recursive: true, force: true });
	rmSync(project, { recursive: true, force: true });
	restoreGlobals(globalsSnapshot);
});

function restoreGlobals(snapshot: Record<string, unknown>): void {
	clearCoreGlobals();
	const g = globalThis as Record<string, unknown>;
	for (const [key, value] of Object.entries(snapshot)) g[key] = value;
}

describe("SM-01 seam contract (lib-level)", () => {
	it("delivers synchronously, isolates per-callback throws, honors unregister", () => {
		const seen: string[] = [];
		const unregister = registerCompactionSubscriber({
			before: () => {
				throw new Error("subscriber bug");
			},
			after: () => seen.push("bad-after"),
		});
		registerCompactionSubscriber({
			before: (info) => seen.push(`good-before:${info.midRun}`),
			after: (info) => seen.push(`good-after:${info.entryId}`),
		});
		expect(() => notifyBefore(draftInfo())).not.toThrow();
		expect(seen).toEqual(["good-before:false"]);
		unregister();
		notifyAfter(draftInfo({ entryId: "e1" }));
		notifyBefore(draftInfo({ midRun: true }));
		expect(seen).toEqual(["good-before:false", "good-after:e1", "good-before:true"]);
	});

	it("after is exactly-once per entryId; a missing entryId always delivers", () => {
		let calls = 0;
		registerCompactionSubscriber({ after: () => (calls += 1) });
		notifyAfter(draftInfo({ entryId: "same" }));
		notifyAfter(draftInfo({ entryId: "same" }));
		expect(calls).toBe(1);
		notifyAfter(draftInfo({ entryId: "other" }));
		expect(calls).toBe(2);
		notifyAfter(draftInfo());
		expect(calls).toBe(3);
	});
});

describe("SM-02 mechanics (dummy subscribers: committed vs lost)", () => {
	it("committed: before once then after once; lost: before only, no after", () => {
		const counts = seamSpy();
		notifyBefore(draftInfo());
		notifyAfter(draftInfo({ entryId: "commit-1" }));
		expect(counts).toEqual({ before: 1, after: 1 });

		const lost = seamSpy();
		notifyBefore(draftInfo());
		expect(lost).toEqual({ before: 1, after: 0 });
	});
});

describe("SM-02/03/04 goal (real factory on FakeHost)", () => {
	function setupGoal(autoContinue = true) {
		const host = new FakeHost();
		goalExtension(host.asPi(), { now: () => Date.now() });
		const ctx = host.makeCtx({ cwd: project, ui: false, sessionEntries: [], idle: true });
		writeActiveGoalFile(
			{ cwd: project },
			createGoal({ objective: "=== Goal ===\nObjective: seam integration", autoContinue, sisyphus: false }, Date.now()),
		);
		return { host, ctx };
	}

	async function startedGoalSession() {
		const g = setupGoal();
		await g.host.fire("session_start", { reason: "new" }, g.ctx);
		await sleep(20);
		return g;
	}

	const goalEventCount = (host: FakeHost) =>
		host.sentMessages.filter((m) => m.message.customType === "pi-goal-event").length;

	it("native path: session_compact fires once, seam NOT called; continuation queued once", async () => {
		const spy = seamSpy();
		const { host, ctx } = await startedGoalSession();
		const before = goalEventCount(host);
		await host.fire("session_before_compact", { reason: "threshold" }, ctx);
		await host.fire("session_compact", { fromExtension: false }, ctx);
		await sleep(20);
		expect(spy).toEqual({ before: 0, after: 0 });
		expect(goalEventCount(host)).toBe(before + 1);
		expect(readActiveGoalFiles({ cwd: project }).length).toBe(1);
	});

	it("draft committed (midRun:false): seam before+after → continuation exactly once, goal persisted", async () => {
		const g = await startedGoalSession();
		const before = goalEventCount(g.host);
		const spy = seamSpy();
		notifyBefore(draftInfo({ midRun: true }));
		notifyAfter(draftInfo({ entryId: "draft-e1", midRun: false }));
		await sleep(20);
		expect(spy).toEqual({ before: 1, after: 1 });
		expect(goalEventCount(g.host)).toBe(before + 1);
		expect(readActiveGoalFiles({ cwd: project }).length).toBe(1);
	});

	it("SM-03: mid-run draft commit queues NO continuation (but persists the goal)", async () => {
		const g = await startedGoalSession();
		const before = g.host.sentMessages.length;
		notifyBefore(draftInfo({ midRun: true }));
		notifyAfter(draftInfo({ entryId: "draft-mid", midRun: true }));
		await sleep(20);
		expect(g.host.sentMessages.length).toBe(before);
		expect(readActiveGoalFiles({ cwd: project }).length).toBe(1);
	});

	it("draft lost: before fires (staging-side effects idempotent), no after, no continuation", async () => {
		const g = await startedGoalSession();
		const before = g.host.sentMessages.length;
		notifyBefore(draftInfo({ midRun: false }));
		await sleep(20);
		expect(g.host.sentMessages.length).toBe(before);
	});
});

describe("SM-02/04 modes (real factory on FakeHost)", () => {
	function setupModes() {
		const host = new FakeHost();
		modesExtension(host.asPi());
		const ctx = host.makeCtx({ cwd: project, ui: false, sessionEntries: [] });
		return { host, ctx };
	}

	it("native session_compact runs the after body once; the seam is NOT called", async () => {
		const spy = seamSpy();
		const { host, ctx } = setupModes();
		await host.fire("session_compact", { fromExtension: false }, ctx);
		expect(host.appendEntries.filter((e) => e.type === "modes")).toHaveLength(1);
		expect(spy).toEqual({ before: 0, after: 0 });
	});

	it("seam after (draft committed) runs the same body exactly once per entryId", async () => {
		const { host } = setupModes();
		const spy = seamSpy();
		notifyAfter(draftInfo({ entryId: "modes-e1" }));
		notifyAfter(draftInfo({ entryId: "modes-e1" }));
		expect(host.appendEntries.filter((e) => e.type === "modes")).toHaveLength(1);
		expect(spy).toEqual({ before: 0, after: 1 });
	});
});
