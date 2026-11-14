/**
 * BH-R1 (spec 2026-11-14-backtest-hardening §4 W-B): a run that ends with a
 * provider error (assistant stopReason "error") must not re-queue the sisyphus
 * continuation forever. Two consecutive error terminations pause the goal
 * THROUGH the lifecycle pause verb (pauseReason "provider error: <first 120
 * chars>", suggested action → /goal resume); any non-error termination resets
 * the per-goal consecutive-error counter. The aborted branch keeps its
 * existing user-pause behavior.
 *
 * Backtest evidence (spec §1 R1): Air 2,241 provider errors / 13h / 111M
 * tokens logged; local 675 errors / 2.6h — the continuation loop re-queued on
 * every error with no backoff.
 *
 * Harness: the shared FakeHost (test/contracts/fake-host.ts) — on-disk goal
 * fixture + event fire, asserting the persisted record and the sent
 * continuations, same shape as goal-hijack.test.ts.
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
import { coreBus, resetCoreBusForTests } from "../../bus.ts";

interface Fixture {
	cwd: string;
	host: FakeHost;
	ctx: Record<string, unknown>;
	diskGoal: () => ReturnType<typeof readActiveGoalFiles>[number] | undefined;
	continuationCount: () => number;
	notifications: () => string[];
	cleanup: () => void;
}

function setup(): Fixture {
	resetCoreBusForTests();
	const cwd = mkdtempSync(path.join(tmpdir(), "pi-goal-errpause-"));
	const host = new FakeHost();
	goalExtension(host.asPi());
	const ctx = host.makeCtx({ cwd, ui: true, sessionEntries: [], idle: true });
	return {
		cwd,
		host,
		ctx,
		diskGoal: () => readActiveGoalFiles({ cwd })[0],
		continuationCount: () =>
			host.sentMessages.filter((m) => {
				const record = m.message as { customType?: string; content?: unknown };
				return record.customType === "pi-goal-event" && String(record.content ?? "").includes("pi_goal_continuation");
			}).length,
		notifications: () =>
			(coreBus().snapshot().notifications ?? []).map((n) => String(n.msg ?? "")),
		cleanup: () => rmSync(cwd, { recursive: true, force: true }),
	};
}

function diskGoal(cwd: string, objective: string): void {
	writeActiveGoalFile({ cwd }, createGoal({ objective, autoContinue: true, sisyphus: true }, Date.UTC(2026, 10, 14)));
}

/** agent_end payload whose last assistant message ended with the given stopReason. */
function runEnd(stopReason: string, errorMessage?: string): unknown {
	return {
		messages: [
			{
				role: "assistant",
				content: [{ type: "text", text: "…working…" }],
				usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
				stopReason,
				...(errorMessage !== undefined ? { errorMessage } : {}),
				timestamp: Date.now(),
			},
		],
	};
}

const PROVIDER_ERROR = "429 quota exceeded: rate limit reached for requests";

async function settle(): Promise<void> {
	// the continuation loop dispatches on a 0–50ms timer; give it a beat
	await new Promise((resolve) => setTimeout(resolve, 60));
}

test("BH-R1: two consecutive provider errors pause the goal; no third continuation is queued", async () => {
	const f = setup();
	try {
		diskGoal(f.cwd, "=== Goal ===\nObjective: ship the decoder");
		await f.host.fire("session_start", { reason: "new" }, f.ctx);
		await settle();
		const baseline = f.continuationCount();

		// first error: the loop may retry once (count < 2 → continuation queued)
		await f.host.fire("agent_end", runEnd("error", PROVIDER_ERROR), f.ctx);
		await settle();
		assert.equal(f.diskGoal()?.status, "active", "first error must NOT pause the goal");
		assert.equal(f.continuationCount(), baseline + 1, "first error still re-queues the continuation");

		// second consecutive error: pause THROUGH the lifecycle pause verb
		await f.host.fire("agent_end", runEnd("error", PROVIDER_ERROR), f.ctx);
		await settle();
		const paused = f.diskGoal();
		assert.equal(paused?.status, "paused", "second consecutive error must pause the goal");
		assert.equal(paused?.autoContinue, false, "paused goal must not auto-continue");
		assert.equal(paused?.pauseReason, `provider error: ${PROVIDER_ERROR}`, "pauseReason carries the provider error text");
		assert.match(paused?.pauseSuggestedAction ?? "", /\/goal resume/, "suggested action points at /goal resume");
		assert.ok(
			f.notifications().some((n) => n.includes("provider error")),
			"the user is notified about the provider-error pause",
		);
		assert.equal(f.continuationCount(), baseline + 1, "no third continuation after the pause");
	} finally {
		f.cleanup();
	}
});

test("BH-R1: error → success → error does NOT pause (counter resets on non-error termination)", async () => {
	const f = setup();
	try {
		diskGoal(f.cwd, "=== Goal ===\nObjective: ship the decoder");
		await f.host.fire("session_start", { reason: "new" }, f.ctx);
		await settle();
		const baseline = f.continuationCount();

		await f.host.fire("agent_end", runEnd("error", PROVIDER_ERROR), f.ctx);
		await settle();
		await f.host.fire("agent_end", runEnd("stop"), f.ctx); // successful termination resets the counter
		await settle();
		await f.host.fire("agent_end", runEnd("error", PROVIDER_ERROR), f.ctx);
		await settle();

		const goal = f.diskGoal();
		assert.equal(goal?.status, "active", "an intervening success must reset the consecutive-error count");
		assert.equal(goal?.autoContinue, true);
		assert.equal(goal?.pauseReason, undefined, "no pause reason is stamped on the healthy path");
		assert.ok(f.continuationCount() >= baseline + 3, "every run still re-queues while the goal is healthy");
	} finally {
		f.cleanup();
	}
});

test("BH-R1: a provider-error pause is resumable via /goal resume; the error counter starts fresh", async () => {
	const f = setup();
	try {
		diskGoal(f.cwd, "=== Goal ===\nObjective: ship the decoder");
		await f.host.fire("session_start", { reason: "new" }, f.ctx);
		await settle();

		// auto-pause on two consecutive errors
		await f.host.fire("agent_end", runEnd("error", PROVIDER_ERROR), f.ctx);
		await settle();
		await f.host.fire("agent_end", runEnd("error", PROVIDER_ERROR), f.ctx);
		await settle();
		assert.equal(f.diskGoal()?.status, "paused");

		// /goal resume: the resume verb clears the pause fields and re-activates
		const resume = f.host.commands.get("goal-resume");
		assert.ok(resume, "/goal resume command registered");
		await resume("", f.ctx as never);
		const resumed = f.diskGoal();
		assert.equal(resumed?.status, "active", "the goal resumes");
		assert.equal(resumed?.autoContinue, true);
		assert.equal(resumed?.pauseReason, undefined, "resume clears the provider-error pauseReason");
		assert.equal(resumed?.pauseSuggestedAction, undefined, "resume clears the suggested action");
		assert.equal(resumed?.stopReason, undefined, "resume clears stopReason");

		// fresh counter: ONE further error must NOT immediately re-pause
		await f.host.fire("agent_end", runEnd("error", PROVIDER_ERROR), f.ctx);
		await settle();
		assert.equal(f.diskGoal()?.status, "active", "one error after resume must not re-pause (counter is fresh)");
		// and the guard still works after the resume: the next consecutive error does
		await f.host.fire("agent_end", runEnd("error", PROVIDER_ERROR), f.ctx);
		await settle();
		assert.equal(f.diskGoal()?.status, "paused", "the second consecutive error after resume pauses again");
		assert.match(f.diskGoal()?.pauseReason ?? "", /^provider error: /);
	} finally {
		f.cleanup();
	}
});

test("BH-R1: the frozen pi-goal-state entry shape is untouched (version 3, same fields)", async () => {
	const f = setup();
	try {
		diskGoal(f.cwd, "=== Goal ===\nObjective: ship the decoder");
		await f.host.fire("session_start", { reason: "new" }, f.ctx);
		await settle();
		await f.host.fire("agent_end", runEnd("error", PROVIDER_ERROR), f.ctx);
		await settle();
		await f.host.fire("agent_end", runEnd("error", PROVIDER_ERROR), f.ctx);
		await settle();
		const entries = f.host.appendEntries.filter((e) => e.type === "pi-goal-state");
		assert.ok(entries.length > 0, "the pause transition persists a pi-goal-state entry");
		const last = entries.at(-1)?.data as { version?: number; goal?: { status?: string; pauseReason?: string } };
		assert.equal(last?.version, 3, "entry version stays frozen at 3 (P0-CT-08)");
		assert.equal(last?.goal?.status, "paused");
		assert.match(last?.goal?.pauseReason ?? "", /^provider error: /);
		void coreBus;
	} finally {
		f.cleanup();
	}
});
