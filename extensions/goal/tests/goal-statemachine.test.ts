/**
 * DC4b (spec DC4 test-first): goal.ts state machine driven end-to-end
 * without a real TUI — the contract-suite FakeHost (ui recording) plus
 * on-disk goal fixtures, asserting the bus goal channel (the seam DC4a
 * made publishable) instead of rendering internals.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import goalExtension from "../goal.ts";
import { writeActiveGoalFile } from "../storage/goal-files.ts";
import { createGoal } from "../goal-record.ts";
import type { GoalRecord } from "../goal-record.ts";
import { coreBus, resetCoreBusForTests } from "../../bus.ts";
import { FakeHost } from "../../../test/contracts/fake-host.ts";

interface Fixture {
	cwd: string;
	host: FakeHost;
	ctx: Record<string, unknown>;
	goalList: () => unknown;
	goalPause: () => unknown;
	cleanup: () => void;
}

function setup(opts: { ui?: boolean; entries?: unknown[] } = {}): Fixture {
	resetCoreBusForTests();
	const cwd = mkdtempSync(path.join(tmpdir(), "pi-goal-sm-"));
	const host = new FakeHost();
	goalExtension(host.asPi());
	const ctx = host.makeCtx({ cwd, ui: opts.ui ?? false, sessionEntries: opts.entries ?? [] });
	return {
		cwd,
		host,
		ctx,
		goalList: () => host.commands.get("goal-list")!("", ctx as never),
		goalPause: () => host.commands.get("goal-pause")!("", ctx as never),
		cleanup: () => rmSync(cwd, { recursive: true, force: true }),
	};
}

function diskGoal(fixture: Fixture, objective: string): GoalRecord {
	return writeActiveGoalFile({ cwd: fixture.cwd }, createGoal({ objective, autoContinue: true, sisyphus: false }, Date.UTC(2026, 8, 23)));
}

const focusEntry = (goalId: string) => ({
	type: "custom",
	customType: "pi-goal-focus",
	data: { version: 1, focusedGoalId: goalId },
});

test("headless: no goals — channel stays inactive and widget-less after a UI refresh", async () => {
	const f = setup({ ui: false });
	try {
		await f.host.fire("session_start", { reason: "new" }, f.ctx);
		await f.goalList(); // drives updateUI → headless publish
		const ch = coreBus().snapshot().goal;
		assert.equal(ch.active, false);
		assert.equal(ch.summary, null);
		assert.equal(ch.widget, undefined); // headless publish carries no widget state
	} finally {
		f.cleanup();
	}
});

test("ui: single open goal auto-focuses (no focus entry) — focused widget snapshot", async () => {
	const f = setup({ ui: true });
	try {
		const goal = diskGoal(f, "=== Goal ===\nObjective: ship the decoder");
		await f.host.fire("session_start", { reason: "new" }, f.ctx);
		await f.goalList();
		const ch = coreBus().snapshot().goal;
		assert.equal(ch.active, true);
		assert.ok(ch.summary && ch.summary.includes("ship the decoder"));
		assert.equal(ch.widget?.focus, "focused");
		assert.ok((ch.widget?.statusLine ?? "").length > 0);
		// DC4b: presentation-complete widget state — the projection carries
		// everything renderGoalWidgetLines consumes.
		assert.equal(ch.widget?.openGoalCount, 1);
		assert.equal(ch.widget?.goal?.status, "active");
		assert.ok(ch.widget?.goal?.objective.includes("ship the decoder"));
		assert.equal(goal.status, "active");
	} finally {
		f.cleanup();
	}
});

test("ui: focus entry pointing at a missing goal yields the unfocused snapshot", async () => {
	const f = setup({ ui: true, entries: [focusEntry("goal-does-not-exist")] });
	try {
		diskGoal(f, "=== Goal ===\nObjective: orphan focus target");
		await f.host.fire("session_start", { reason: "new" }, f.ctx);
		await f.goalList();
		const ch = coreBus().snapshot().goal;
		assert.equal(ch.active, false);
		assert.equal(ch.widget?.focus, "unfocused");
		assert.match(ch.widget?.statusLine ?? "", /goal: unfocused \[1 open\]/);
	} finally {
		f.cleanup();
	}
});

test("ui: goal-pause flips the channel to paused", async () => {
	const f = setup({ ui: true });
	try {
		diskGoal(f, "=== Goal ===\nObjective: pausable objective");
		await f.host.fire("session_start", { reason: "new" }, f.ctx);
		await f.goalList();
		assert.equal(coreBus().snapshot().goal.active, true);
		await f.goalPause();
		const ch = coreBus().snapshot().goal;
		assert.equal(ch.paused, true);
		assert.equal(ch.active, true); // paused ≠ inactive: the goal is still focused
	} finally {
		f.cleanup();
	}
});

test("ui: focused goal vanishing from disk reconciles to the none snapshot", async () => {
	const f = setup({ ui: true });
	try {
		const goal = diskGoal(f, "=== Goal ===\nObjective: disappearing act");
		await f.host.fire("session_start", { reason: "new" }, f.ctx);
		await f.goalList();
		assert.equal(coreBus().snapshot().goal.widget?.focus, "focused");
		// Remove the goal file; the next reconcile drops focus and renders none.
		rmSync(path.join(f.cwd, goal.activePath ?? "missing"));
		await f.goalList();
		const ch = coreBus().snapshot().goal;
		assert.equal(ch.active, false);
		assert.equal(ch.widget?.focus, "none");
		assert.equal(ch.widget?.statusLine, "");
	} finally {
		f.cleanup();
	}
});

test("ui: /goals injects a compact custom message — full prompt to the model, topic kept for display", async () => {
	const f = setup({ ui: true });
	try {
		await f.host.fire("session_start", { reason: "new" }, f.ctx);
		f.host.sentMessages.length = 0;
		f.host.userMessages.length = 0;
		await f.host.commands.get("goals")!("ship the retry decoder", f.ctx);
		// Injection moved off sendUserMessage: no raw user-message transcript dump.
		assert.equal(f.host.userMessages.length, 0);
		const sent = f.host.sentMessages.at(-1);
		assert.equal(sent?.message.customType, "pi-goal-event");
		assert.equal(sent?.message.display, true);
		const text = typeof sent?.message.content === "string" ? sent.message.content : "";
		assert.match(text, /\[GOAL CONFIRMATION focus=goal\]/);
		assert.ok(text.includes("ship the retry decoder"));
		const details = asRecord(sent?.message.details);
		assert.equal(details?.kind, "drafting");
		assert.equal(details?.objective, "ship the retry decoder");
		assert.equal(details?.focus, "goal");
		const opts = asRecord(sent?.opts);
		assert.equal(opts?.triggerTurn, true);
		assert.equal(opts?.deliverAs, "steer"); // fake ctx isIdle() === false
	} finally {
		f.cleanup();
	}
});

test("ui: /sisyphus injects the sisyphus drafting variant of the same channel", async () => {
	const f = setup({ ui: true });
	try {
		await f.host.fire("session_start", { reason: "new" }, f.ctx);
		f.host.sentMessages.length = 0;
		await f.host.commands.get("sisyphus")!("ordered retry rollout", f.ctx);
		const sent = f.host.sentMessages.at(-1);
		assert.equal(sent?.message.customType, "pi-goal-event");
		const text = typeof sent?.message.content === "string" ? sent.message.content : "";
		assert.match(text, /\[GOAL CONFIRMATION focus=sisyphus\]/);
		const details = asRecord(sent?.message.details);
		assert.equal(details?.kind, "drafting");
		assert.equal(details?.focus, "sisyphus");
		assert.equal(details?.objective, "ordered retry rollout");
	} finally {
		f.cleanup();
	}
});

test("message_end keeps drafting custom messages visible but hides checkpoints", async () => {
	const f = setup({ ui: true });
	try {
		const replace = async (message: Record<string, unknown>) =>
			(await f.host.fire("message_end", { message }, f.ctx)) as unknown;
		const drafting = { role: "custom", customType: "pi-goal-event", display: true, content: "x", details: { kind: "drafting", goalId: "d1" } };
		const checkpoint = { role: "custom", customType: "pi-goal-event", display: true, content: "x", details: { kind: "checkpoint", goalId: "g1" } };
		const results = await Promise.all([replace(drafting), replace(checkpoint)]);
		const draftingResult = asRecord(asRecord(results[0])?.message);
		const checkpointResult = asRecord(asRecord(results[1])?.message);
		assert.equal(draftingResult, null); // drafting passes through untouched
		assert.equal(checkpointResult?.display, false); // checkpoint forced hidden
	} finally {
		f.cleanup();
	}
});

test("ui: /goal <topic> routes to the drafting discussion (Codex-style entry)", async () => {
	const f = setup({ ui: true });
	try {
		await f.host.fire("session_start", { reason: "new" }, f.ctx);
		f.host.sentMessages.length = 0;
		f.host.userMessages.length = 0;
		await f.host.commands.get("goal")!("codex style entry topic", f.ctx);
		assert.equal(f.host.userMessages.length, 0);
		const sent = f.host.sentMessages.at(-1);
		assert.equal(sent?.message.customType, "pi-goal-event");
		assert.equal(sent?.message.display, true);
		const details = asRecord(sent?.message.details);
		assert.equal(details?.kind, "drafting");
		assert.equal(details?.objective, "codex style entry topic");
		const text = typeof sent?.message.content === "string" ? sent.message.content : "";
		assert.match(text, /\[GOAL CONFIRMATION focus=goal\]/);
	} finally {
		f.cleanup();
	}
});

test("ui: bare /goal stays a read-only status command (no injection)", async () => {
	const f = setup({ ui: true });
	try {
		await f.host.fire("session_start", { reason: "new" }, f.ctx);
		f.host.sentMessages.length = 0;
		f.host.userMessages.length = 0;
		await f.host.commands.get("goal")!("", f.ctx);
		assert.equal(f.host.sentMessages.length, 0);
		assert.equal(f.host.userMessages.length, 0);
	} finally {
		f.cleanup();
	}
});

test("ui: /goal pause pauses the focused goal via reserved word", async () => {
	const f = setup({ ui: true });
	try {
		diskGoal(f, "=== Goal ===\nObjective: reserved word smoke");
		await f.host.fire("session_start", { reason: "new" }, f.ctx);
		await f.goalList();
		assert.equal(coreBus().snapshot().goal.active, true);
		f.host.sentMessages.length = 0;
		await f.host.commands.get("goal")!("pause", f.ctx);
		assert.equal(coreBus().snapshot().goal.paused, true);
		assert.equal(f.host.sentMessages.length, 0); // management, not drafting
	} finally {
		f.cleanup();
	}
});

function asRecord(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}
