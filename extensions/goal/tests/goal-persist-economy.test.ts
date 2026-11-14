/**
 * BH-E1 (spec 2026-11-14-backtest-hardening §4 W-B): goal-state write
 * amplification. Usage-bearing events used to append a FULL pi-goal-state
 * snapshot + rewrite .pi/goals/<id>.md + rescan the disk pool on EVERY event
 * (backtest: 98.8% of persisted entries differed only in usage/updatedAt; the
 * worst session file was 40% goal-state entries).
 *
 * New model: usage/updatedAt-only changes update IN-MEMORY state only; usage
 * reaches disk at exactly three points — each agent_end (only when usage
 * changed since the last persist), session_shutdown, and any real state
 * transition (transitions write immediately, carrying the latest usage).
 * Budget/usage reads keep using the in-memory value. The persisted entry
 * FORMAT is untouched (P0-CT-08 frozen).
 *
 * Harness: the shared FakeHost — on-disk goal fixture + event fire, counting
 * pi-goal-state entries (the amplification unit), same shape as
 * goal-cost-accounting.test.ts.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import goalExtension from "../goal.ts";
import { writeActiveGoalFile, readActiveGoalFiles } from "../storage/goal-files.ts";
import { createGoal } from "../goal-record.ts";
import { FakeHost } from "../../../test/contracts/fake-host.ts";

interface Fixture {
	cwd: string;
	host: FakeHost;
	ctx: Record<string, unknown>;
	diskGoal: () => ReturnType<typeof readActiveGoalFiles>[number] | undefined;
	stateEntries: () => Array<{ version: number; goal: { usage: { tokensUsed: number; activeSeconds: number; costUsed: number } } | null }>;
	cleanup: () => void;
}

function setup(opts: { clock?: () => number } = {}): Fixture {
	const cwd = mkdtempSync(path.join(tmpdir(), "pi-goal-econ-"));
	const host = new FakeHost();
	goalExtension(host.asPi(), opts.clock ? { now: opts.clock } : undefined);
	const ctx = host.makeCtx({ cwd, ui: false, sessionEntries: [] });
	writeActiveGoalFile({ cwd }, createGoal({ objective: "=== Goal ===\nObjective: ship cost accounting", autoContinue: false, sisyphus: false }, Date.UTC(2026, 10, 14)));
	return {
		cwd,
		host,
		ctx,
		diskGoal: () => readActiveGoalFiles({ cwd })[0],
		stateEntries: () =>
			host.appendEntries
				.filter((e) => e.type === "pi-goal-state")
				.map((e) => e.data as { version: number; goal: { usage: { tokensUsed: number; activeSeconds: number; costUsed: number } } | null }),
		cleanup: () => rmSync(cwd, { recursive: true, force: true }),
	};
}

const turnEndWithUsage = (tokens: number): unknown => ({
	type: "turn_end",
	turnIndex: 0,
	message: { role: "assistant", content: [{ type: "text", text: "working" }], usage: { input: tokens, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0.001 } } },
	toolResults: [],
});

test("BH-E1: N usage events in one run produce at most ONE usage-related state entry", async () => {
	const f = setup();
	try {
		await f.host.fire("session_start", { reason: "new" }, f.ctx);
		await f.host.fire("before_agent_start", { messageType: "user", systemPrompt: "BASE", prompt: "work on the goal" }, f.ctx);
		const before = f.stateEntries().length;

		// 10 usage-bearing events inside ONE run
		for (let i = 1; i <= 10; i++) {
			await f.host.fire("turn_end", turnEndWithUsage(1000), f.ctx);
		}
		const midRunEntries = f.stateEntries().length - before;
		assert.equal(midRunEntries, 0, "usage events must not append pi-goal-state entries");

		// the single run-boundary flush
		await f.host.fire("agent_end", { messages: [] }, f.ctx);
		const total = f.stateEntries().length - before;
		assert.ok(total <= 1, `one run appends at most 1 usage-related entry (got ${total})`);
		assert.equal(f.diskGoal()?.usage.tokensUsed, 10_000, "the flushed entry carries the accumulated usage");
	} finally {
		f.cleanup();
	}
});

test("BH-E1: a real state transition persists immediately, carrying the latest usage", async () => {
	const f = setup();
	try {
		await f.host.fire("session_start", { reason: "new" }, f.ctx);
		await f.host.fire("before_agent_start", { messageType: "user", systemPrompt: "BASE", prompt: "work" }, f.ctx);
		await f.host.fire("turn_end", turnEndWithUsage(2500), f.ctx);
		// no agent_end yet — usage is memory-only; the transition must still
		// land it on disk right away (transition writes carry latest usage)
		await f.host.commands.get("goal-pause")!("", f.ctx as never);
		const paused = f.diskGoal();
		assert.equal(paused?.status, "paused");
		assert.equal(paused?.usage.tokensUsed, 2500, "the transition persist carries the un-flushed run usage");
		assert.equal(f.stateEntries().at(-1)?.goal?.usage.tokensUsed, 2500);
	} finally {
		f.cleanup();
	}
});

test("BH-E1: session_shutdown flushes memory usage; a restart restores it (≤ one run stale)", async () => {
	const f = setup();
	try {
		await f.host.fire("session_start", { reason: "new" }, f.ctx);
		await f.host.fire("before_agent_start", { messageType: "user", systemPrompt: "BASE", prompt: "work" }, f.ctx);
		await f.host.fire("turn_end", turnEndWithUsage(4321), f.ctx);
		assert.equal(f.diskGoal()?.usage.tokensUsed, 0, "usage stays memory-only before the flush points");

		await f.host.fire("session_shutdown", {}, f.ctx);
		assert.equal(f.diskGoal()?.usage.tokensUsed, 4321, "shutdown persists the run usage");

		// restart: a fresh factory adopts the persisted record
		const host2 = new FakeHost();
		goalExtension(host2.asPi());
		const ctx2 = host2.makeCtx({ cwd: f.cwd, ui: false, sessionEntries: [] });
		await host2.fire("session_start", { reason: "resume" }, ctx2);
		const restored = readActiveGoalFiles({ cwd: f.cwd })[0];
		assert.equal(restored?.usage.tokensUsed, 4321, "restored usage is at most one run's increment stale");
	} finally {
		f.cleanup();
	}
});

test("BH-E1: an agent_end without usage change appends nothing (idle run)", async () => {
	const f = setup();
	try {
		await f.host.fire("session_start", { reason: "new" }, f.ctx);
		await f.host.fire("before_agent_start", { messageType: "user", systemPrompt: "BASE", prompt: "work" }, f.ctx);
		const before = f.stateEntries().length;
		await f.host.fire("agent_end", { messages: [] }, f.ctx);
		assert.equal(f.stateEntries().length - before, 0, "no usage delta → no entry at agent_end");
	} finally {
		f.cleanup();
	}
});

test("BH-E1: 50-turn synthetic run — entry counts before/after", async () => {
	// The spec asks for a synthetic 50-turn scenario in the report. On the
	// BASELINE each turn_end appended one full pi-goal-state entry (50 entries
	// + md rewrite + pool rescan per event); with BH-E1 the same run appends
	// exactly 1 (the agent_end flush).
	const f = setup();
	try {
		await f.host.fire("session_start", { reason: "new" }, f.ctx);
		await f.host.fire("before_agent_start", { messageType: "user", systemPrompt: "BASE", prompt: "work" }, f.ctx);
		const before = f.stateEntries().length;
		for (let i = 0; i < 50; i++) {
			await f.host.fire("turn_end", turnEndWithUsage(500), f.ctx);
		}
		await f.host.fire("agent_end", { messages: [] }, f.ctx);
		const total = f.stateEntries().length - before;
		assert.ok(total <= 1, `50-turn run: ≤1 usage entry (got ${total}; baseline appended 50)`);
		assert.equal(f.diskGoal()?.usage.tokensUsed, 25_000);
	} finally {
		f.cleanup();
	}
});
