/**
 * GH (spec 2026-10-01-goal-hijack-fix): subagent child sessions never adopt
 * the project's on-disk goals and never arm continuations. Before the fix,
 * a child sharing the parent cwd adopted the active goal at session_start
 * and its <pi_goal_continuation> checkpoint occupied the agent loop before
 * the dispatched task prompt could be delivered — every subagent spawn in
 * the project failed with "Agent is already processing a prompt" while a
 * goal was active (evidence: pi-subagents events.jsonl, 2026-10-01).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import goalExtension from "../goal.ts";
import { writeActiveGoalFile } from "../storage/goal-files.ts";
import { createGoal } from "../goal-record.ts";
import { coreBus, resetCoreBusForTests } from "../../bus.ts";
import { FakeHost } from "../../../test/contracts/fake-host.ts";

const CHILD_ENV = "PI_SUBAGENT_CHILD";

interface Fixture {
	cwd: string;
	host: FakeHost;
	ctx: Record<string, unknown>;
	goalList: () => unknown;
	continuationMessages: () => Array<string>;
	cleanup: () => void;
}

function setup(opts: { ui?: boolean; idle?: boolean } = {}): Fixture {
	resetCoreBusForTests();
	const cwd = mkdtempSync(path.join(tmpdir(), "pi-goal-hijack-"));
	const host = new FakeHost();
	goalExtension(host.asPi());
	const ctx = host.makeCtx({ cwd, ui: opts.ui ?? false, sessionEntries: [], idle: opts.idle ?? false });
	return {
		cwd,
		host,
		ctx,
		goalList: () => host.commands.get("goal-list")!("", ctx as never),
		continuationMessages: () =>
			host.sentMessages
				.map((m) => JSON.stringify(m.message))
				.filter((s) => s.includes("pi_goal_continuation") || s.includes("GOAL CHECKPOINT")),
		cleanup: () => rmSync(cwd, { recursive: true, force: true }),
	};
}

function diskGoal(cwd: string, objective: string): void {
	writeActiveGoalFile({ cwd }, createGoal({ objective, autoContinue: true, sisyphus: false }, Date.UTC(2026, 8, 23)));
}

/** Runs the body with PI_SUBAGENT_CHILD=1, restoring the previous value. */
async function asChild(body: () => Promise<void>): Promise<void> {
	const prev = process.env[CHILD_ENV];
	process.env[CHILD_ENV] = "1";
	try {
		await body();
	} finally {
		if (prev === undefined) delete process.env[CHILD_ENV];
		else process.env[CHILD_ENV] = prev;
	}
}

test("GH-02: child session does not adopt the on-disk active goal", async () => {
	await asChild(async () => {
		const f = setup({ ui: true });
		try {
			diskGoal(f.cwd, "=== Goal ===\nObjective: ship the decoder");
			await f.host.fire("session_start", { reason: "new" }, f.ctx);
			await f.goalList(); // drives updateUI → publish
			const ch = coreBus().snapshot().goal;
			assert.equal(ch.active, false, "child must not adopt the disk goal");
			assert.equal(ch.summary, null);
		} finally {
			f.cleanup();
		}
	});
});

test("GH-03: child session never sends a goal continuation (idle ctx, immediate-send window)", async () => {
	// NOTE (review F3): green here is guaranteed by the GH-02 guards keeping
	// state.goal null — this case pins the OUTCOME, not the queueContinuation
	// belt itself (no in-child path can set state.goal once adoption is
	// guarded). The belt is code-walkthrough covered per spec §3 item 3.
	await asChild(async () => {
		const f = setup({ ui: true, idle: true });
		try {
			diskGoal(f.cwd, "=== Goal ===\nObjective: ship the decoder");
			await f.host.fire("session_start", { reason: "new" }, f.ctx);
			// idle ctx → delay 0 → the pre-fix code sent within a macrotask
			await new Promise((resolve) => setTimeout(resolve, 20));
			assert.equal(f.continuationMessages().length, 0, "child must not arm/send continuations");
		} finally {
			f.cleanup();
		}
	});
});

test("GH-02b: child command paths do not re-adopt the disk pool (goal-list reconcile)", async () => {
	await asChild(async () => {
		const f = setup({ ui: true });
		try {
			diskGoal(f.cwd, "=== Goal ===\nObjective: ship the decoder");
			await f.host.fire("session_start", { reason: "new" }, f.ctx);
			// goal-list reconciles from disk before listing — without the guard
			// the child would list (adopt) the parent's on-disk goal here
			await f.goalList();
			const listed = f.host.notifications.filter((n) => String(n).includes("ship the decoder"));
			assert.equal(listed.length, 0, "child goal-list must not surface the disk goal");
			const ch = coreBus().snapshot().goal;
			assert.equal(ch.active, false);
		} finally {
			f.cleanup();
		}
	});
});

test("GH-04: child session tool set carries no active-goal lifecycle gating", async () => {
	await asChild(async () => {
		const f = setup({ ui: true });
		try {
			diskGoal(f.cwd, "=== Goal ===\nObjective: ship the decoder");
			await f.host.fire("session_start", { reason: "new" }, f.ctx);
			const last = f.host.activeToolsCalls.at(-1) ?? [];
			// no goal adopted → lifecycle tools for an ACTIVE goal must be absent
			for (const gated of ["update_goal", "pause_goal", "abort_goal", "create_goal"]) {
				assert.ok(!last.includes(gated), `child tool set must not gate in ${gated}`);
			}
		} finally {
			f.cleanup();
		}
	});
});

test("GH-05: parent session (no child env) still adopts and continues — zero behavior change", async () => {
	const f = setup({ ui: true, idle: true });
	try {
		diskGoal(f.cwd, "=== Goal ===\nObjective: ship the decoder");
		await f.host.fire("session_start", { reason: "new" }, f.ctx);
		await f.goalList();
		const ch = coreBus().snapshot().goal;
		assert.equal(ch.active, true, "parent must adopt as before");
		assert.ok(ch.summary && ch.summary.includes("ship the decoder"));
		await new Promise((resolve) => setTimeout(resolve, 20));
		assert.ok(f.continuationMessages().length > 0, "parent continuation still sent");
	} finally {
		f.cleanup();
	}
});
