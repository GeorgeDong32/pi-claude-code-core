/**
 * Goal cost accounting (spec 2026-10-04-goal-cost-accounting):
 * ① GoalUsage.costUsed — USD dimension, fractional, upgrade-safe reads.
 * ② turn_end assistant usage now also carries usage.cost.total.
 * ③ tool_result events report execution usage (subagents, codemode model
 *    calls) — previously invisible to the goal ledger (verified 2026-10-03:
 *    three reviewer runs, 1.94M tokens / $0.49, silently absent).
 * Same FakeHost harness as goal-statemachine.test.ts: on-disk goal fixture +
 * event fire, asserting the persisted record rather than internals.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import goalExtension from "../goal.ts";
import { writeActiveGoalFile, readActiveGoalFiles } from "../storage/goal-files.ts";
import { createGoal, normalizeUsage, emptyUsage } from "../goal-record.ts";
import { formatCostValue, footerStatus, oneLineSummary, type GoalDisplayRecordLike } from "../goal-core.ts";
import { FakeHost } from "../../../test/contracts/fake-host.ts";
import { coreBus, resetCoreBusForTests } from "../../bus.ts";

function setup(opts: { ui?: boolean } = {}) {
	resetCoreBusForTests();
	const cwd = mkdtempSync(path.join(tmpdir(), "pi-goal-cost-"));
	const host = new FakeHost();
	goalExtension(host.asPi());
	const ctx = host.makeCtx({ cwd, ui: opts.ui ?? false, sessionEntries: [] });
	writeActiveGoalFile({ cwd }, createGoal({ objective: "=== Goal ===\nObjective: ship cost accounting", autoContinue: false, sisyphus: false }, Date.UTC(2026, 9, 4)));
	return { cwd, host, ctx, cleanup: () => rmSync(cwd, { recursive: true, force: true }) };
}

const focusEntry = (goalId: string) => ({
	type: "custom",
	customType: "pi-goal-focus",
	data: { version: 1, focusedGoalId: goalId },
});

async function activeGoal(f: ReturnType<typeof setup>): Promise<ReturnType<typeof readActiveGoalFiles>[number] | undefined> {
	return readActiveGoalFiles({ cwd: f.cwd })[0];
}

test("turn_end: assistant usage.cost.total accumulates into costUsed", async () => {
	const f = setup();
	try {
		const goal = await activeGoal(f);
		await f.host.fire("session_start", { reason: "new" }, f.ctx);
		await f.host.fire(
			"turn_end",
			{
				type: "turn_end",
				turnIndex: 0,
				message: { role: "assistant", content: [{ type: "text", text: "done" }], usage: { input: 1000, output: 100, cacheRead: 5000, cacheWrite: 0, cost: { total: 0.123 } } },
				toolResults: [],
			},
			f.ctx,
		);
		const updated = await activeGoal(f);
		assert.equal(updated?.usage.tokensUsed, goal ? goal.usage.tokensUsed + 6100 : 6100);
		assert.ok(updated && updated.usage.costUsed >= 0.123 - 1e-9 && updated.usage.costUsed <= 0.123 + 1e-9, `costUsed ${updated?.usage.costUsed} ≈ 0.123`);
	} finally {
		f.cleanup();
	}
});

test("tool_result: execution usage (subagent-shaped) adds both tokens and cost", async () => {
	const f = setup();
	try {
		await f.host.fire("session_start", { reason: "new" }, f.ctx);
		await f.host.fire(
			"tool_result",
			{
				type: "tool_result",
				toolName: "subagent",
				toolCallId: "call-1",
				input: {},
				content: [{ type: "text", text: "review done" }],
				isError: false,
				usage: { input: 400000, output: 25000, cacheRead: 150000, cacheWrite: 0, cost: { total: 0.023 } },
			},
			f.ctx,
		);
		const updated = await activeGoal(f);
		assert.equal(updated?.usage.tokensUsed, 575000);
		assert.ok(updated && Math.abs(updated.usage.costUsed - 0.023) < 1e-9);
	} finally {
		f.cleanup();
	}
});

test("tool_result: usage-less tool results change nothing", async () => {
	const f = setup();
	try {
		await f.host.fire("session_start", { reason: "new" }, f.ctx);
		await f.host.fire(
			"tool_result",
			{ type: "tool_result", toolName: "read", toolCallId: "call-2", input: {}, content: [{ type: "text", text: "file" }], isError: false },
			f.ctx,
		);
		const updated = await activeGoal(f);
		assert.equal(updated?.usage.tokensUsed, 0);
		assert.equal(updated?.usage.costUsed, 0);
	} finally {
		f.cleanup();
	}
});

test("tool_result: not accounted while no goal is focused-active on disk for this session", async () => {
	const f = setup();
	try {
		// Goal exists on disk but the extension never saw session_start focus
		// adoption — activeGoalId accounting has not begun, so the event is
		// dropped (same guard family as turn_end accounting).
		await f.host.fire(
			"tool_result",
			{ type: "tool_result", toolName: "subagent", toolCallId: "c", input: {}, content: [], isError: false, usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 1 } } },
			f.ctx,
		);
		const updated = await activeGoal(f);
		assert.equal(updated?.usage.tokensUsed, 0);
		assert.equal(updated?.usage.costUsed, 0);
	} finally {
		f.cleanup();
	}
});

test("normalizeUsage: legacy records without costUsed read back as 0", () => {
	const parsed = normalizeUsage({ tokensUsed: 5000, activeSeconds: 42 });
	assert.deepEqual(parsed, { tokensUsed: 5000, activeSeconds: 42, costUsed: 0 });
	assert.deepEqual(emptyUsage(), { tokensUsed: 0, activeSeconds: 0, costUsed: 0 });
	// fractional cost is preserved (never floored like token counts)
	assert.equal(normalizeUsage({ tokensUsed: 1, activeSeconds: 0, costUsed: 0.023 }).costUsed, 0.023);
});

test("formatCostValue: three tiers with rounded-tier edges", () => {
	assert.equal(formatCostValue(0), "$0");
	assert.equal(formatCostValue(0.023), "$0.023");
	assert.equal(formatCostValue(0.499), "$0.499");
	assert.equal(formatCostValue(1), "$1.00");
	assert.equal(formatCostValue(50.9), "$50.90");
	// r1 NIT-1 edges: tier decided on the rounded value
	assert.equal(formatCostValue(0.9995), "$1.00");
	assert.equal(formatCostValue(0.9994), "$0.999");
	assert.equal(formatCostValue(0.0004), "$0");
});

test("footerStatus / oneLineSummary carry cost next to tokens", () => {
	const goal: GoalDisplayRecordLike = {
		objective: "=== Goal ===\nObjective: ship it",
		status: "active",
		autoContinue: true,
		usage: { activeSeconds: 125, tokensUsed: 4_500, costUsed: 0.487 },
		sisyphus: false,
	};
	assert.match(footerStatus(goal), /\[2m05s 4\.5K \$0\.487\]/);
	assert.match(oneLineSummary(goal), /\[4\.5K \$0\.487\]/);
	// zero cost stays hidden (pre-cost records render exactly as before)
	const legacy: GoalDisplayRecordLike = { ...goal, usage: { activeSeconds: 10, tokensUsed: 100, costUsed: 0 } };
	assert.doesNotMatch(footerStatus(legacy), /\$/);
});

test("persisted record and bus widget snapshot carry costUsed", async () => {
	const f = setup({ ui: true });
	try {
		await f.host.fire("session_start", { reason: "new" }, f.ctx);
		await f.host.fire(
			"turn_end",
			{
				type: "turn_end",
				turnIndex: 0,
				message: { role: "assistant", content: [{ type: "text", text: "ok" }], usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, cost: { total: 2.5 } } },
				toolResults: [],
			},
			f.ctx,
		);
		// persisted record (what archives consume)
		const updated = await activeGoal(f);
		assert.ok(updated && Math.abs(updated.usage.costUsed - 2.5) < 1e-9);
		// bus widget projection — drive a UI refresh via goal-list, then read
		// the snapshot (harness pattern from goal-statemachine.test.ts)
		await f.host.commands.get("goal-list")!("", f.ctx as never);
		const widget = (coreBus().snapshot().goal as { widget?: { goal?: { costUsed?: number; tokensUsed?: number } } }).widget?.goal;
		assert.ok(widget, "focused goal widget present after refresh");
		assert.ok(widget && typeof widget.costUsed === "number" && Math.abs(widget.costUsed - 2.5) < 1e-9);
	} finally {
		f.cleanup();
	}
});
