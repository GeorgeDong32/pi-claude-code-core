/**
 * Compaction seam tests (SPEC SC §5.9, task W5).
 *
 * Requirement → test map:
 *   SM-01 → "SM-01 seam: …" (sync, self-contained, per-callback isolation,
 *            unregister, entryId dedupe)
 *   SM-02 → "SM-02 mechanics …" (dummy subscribers: committed once / lost
 *            before-only) + the three real-factory blocks below
 *            ({committed, lost, native} × goal/modes/memory)
 *   SM-03 → "SM-03 goal: a mid-run draft commit queues no continuation"
 *   SM-04 → "SM-04 modes …" (after = appendEntry/persistState once) and
 *            "SM-04 memory …" (before = staging, merged per sessionId)
 *   SM-05 → existing suites stay green with UNCHANGED expectations — proven
 *            by `pnpm run test`, not re-asserted here.
 *
 * Real factories run on FakeHost (contract-suite pattern, targets.ts); the
 * seam is reset between cases so registrations never leak across tests.
 */
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
import { setupAutomation, type AutomationState } from "../../extensions/memory/automation.ts";
import { ConsolidationTrigger } from "../../extensions/memory/consolidate.ts";
import { queueDir } from "../../extensions/memory/queue.ts";
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

/** Counting spy registered FIRST, so factory subscribers never mask it. */
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
		notifyAfter(draftInfo()); // defensive branch
		expect(calls).toBe(3);
	});
});

describe("SM-02 mechanics (dummy subscribers: committed vs lost)", () => {
	it("committed: before once then after once; lost: before only, no after", () => {
		const counts = seamSpy();
		notifyBefore(draftInfo()); // proposal intent
		notifyAfter(draftInfo({ entryId: "commit-1" })); // reconciliation hit
		expect(counts).toEqual({ before: 1, after: 1 });

		const lost = seamSpy();
		notifyBefore(draftInfo()); // proposal later overridden — no after ever
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
		await sleep(20); // session_start itself queues a continuation (0ms timer) — flush it out of the deltas
		return g;
	}

	const goalEventCount = (host: FakeHost) =>
		host.sentMessages.filter((m) => m.message.customType === "pi-goal-event").length;

	it("native path: session_compact fires once, seam NOT called; continuation queued once", async () => {
		const spy = seamSpy();
		const { host, ctx } = await startedGoalSession();
		const before = goalEventCount(host); // session_start's own continuation already flushed
		await host.fire("session_before_compact", { reason: "threshold" }, ctx);
		await host.fire("session_compact", { fromExtension: false }, ctx);
		await sleep(20); // continuation dispatch is a 0ms timer
		expect(spy).toEqual({ before: 0, after: 0 });
		expect(goalEventCount(host)).toBe(before + 1); // exactly one from the compact hook
		expect(readActiveGoalFiles({ cwd: project }).length).toBe(1);
	});

	it("draft committed (midRun:false): seam before+after → continuation exactly once, goal persisted", async () => {
		const g = await startedGoalSession();
		const before = goalEventCount(g.host);
		const spy = seamSpy();
		notifyBefore(draftInfo({ midRun: true })); // proposal intent (mid-run)
		notifyAfter(draftInfo({ entryId: "draft-e1", midRun: false })); // reconciled at run end
		await sleep(20);
		expect(spy).toEqual({ before: 1, after: 1 });
		expect(goalEventCount(g.host)).toBe(before + 1);
		expect(readActiveGoalFiles({ cwd: project }).length).toBe(1); // persist ran
	});

	it("SM-03: mid-run draft commit queues NO continuation (but persists the goal)", async () => {
		const g = await startedGoalSession();
		const before = g.host.sentMessages.length;
		notifyBefore(draftInfo({ midRun: true }));
		notifyAfter(draftInfo({ entryId: "draft-mid", midRun: true }));
		await sleep(20);
		expect(g.host.sentMessages.length).toBe(before); // no follow-up queued
		expect(readActiveGoalFiles({ cwd: project }).length).toBe(1); // persist ran
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
		notifyAfter(draftInfo({ entryId: "modes-e1" })); // seam dedupe
		expect(host.appendEntries.filter((e) => e.type === "modes")).toHaveLength(1);
		expect(spy).toEqual({ before: 0, after: 1 });
	});
});

describe("SM-02/04 memory (real setupAutomation on FakeHost)", () => {
	function setupMemory(sessionEntries: unknown[], sessionId: string) {
		const host = new FakeHost();
		const state: AutomationState = { enabled: true, reviews: 0, corrections: 0, flushes: 0, opsApplied: 0, routed: 0 };
		const agentDir = join(home, ".pi", "agent");
		const userDir = join(agentDir, "memory-user");
		const projectsDirStr = join(agentDir, "memory-projects");
		const trigger = new ConsolidationTrigger({ sendDirective: () => {} });
		setupAutomation(host.asPi(), {
			gate: { state: { yielded: false } },
			dirs: (() => ({ project, user: userDir, projectsDir: projectsDirStr, agentDir })) as never,
			trigger,
			settings: () => ({ automation: true }),
			state,
			deps: { complete: (async () => ({ stopReason: "stop", content: [] })) as never },
		});
		const ctx = host.makeCtx({ cwd: project, ui: false, sessionEntries, sessionId });
		return { host, ctx, state, agentDir };
	}

	const entries = Array.from({ length: 6 }, (_, i) => ({
		type: "message",
		message: { role: i % 2 ? "assistant" : "user", content: [{ type: "text", text: `m${i}` }] },
	}));

	function queueFiles(agentDir: string): string[] {
		return existsSync(queueDir(agentDir)) ? readdirSync(queueDir(agentDir)).filter((f) => f.endsWith(".json")) : [];
	}

	it("native before_compact stages one record; seam NOT called", async () => {
		const spy = seamSpy();
		const { host, ctx, agentDir, state } = setupMemory(entries, "sess-native-1");
		await host.fire("session_start", { reason: "new" }, ctx);
		for (let i = 0; i < 3; i += 1) await host.fire("message_end", { message: { role: "user", content: [{ type: "text", text: `w ${i}` }] } }, ctx);
		await host.fire("session_before_compact", { reason: "threshold", signal: new AbortController().signal }, ctx);
		expect(queueFiles(agentDir)).toHaveLength(1);
		expect(state.lastFlush).toContain("compact-queued");
		expect(spy).toEqual({ before: 0, after: 0 });
	});

	it("seam before (draft intent) stages; native + seam staging merge to ONE record (SM-04 + idempotence)", async () => {
		const { host, ctx, state, agentDir } = setupMemory(entries, "sess-draft-1");
		await host.fire("session_start", { reason: "new" }, ctx);
		for (let i = 0; i < 3; i += 1) await host.fire("message_end", { message: { role: "user", content: [{ type: "text", text: `w ${i}` }] } }, ctx);
		notifyBefore(draftInfo({ midRun: true })); // boundary-draft intent
		expect(state.lastFlush).toContain("boundary-draft");
		expect(queueFiles(agentDir)).toHaveLength(1);
		await host.fire("session_before_compact", { reason: "threshold", signal: new AbortController().signal }, ctx);
		expect(queueFiles(agentDir)).toHaveLength(1); // same sessionId → merged
	});

	it("memory has no after action: a committed draft notification changes nothing on disk", async () => {
		const { host, ctx } = setupMemory(entries, "sess-after-1");
		await host.fire("session_start", { reason: "new" }, ctx);
		for (let i = 0; i < 3; i += 1) await host.fire("message_end", { message: { role: "user", content: [{ type: "text", text: `w ${i}` }] } }, ctx);
		notifyAfter(draftInfo({ entryId: "mem-e1" }));
		expect(queueFiles(join(home, ".pi", "agent"))).toHaveLength(0);
	});
});
