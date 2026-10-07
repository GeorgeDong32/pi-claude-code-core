/**
 * goal-turn-lock.test.ts — SPEC 2026-10-07 P0-2 acceptance tests.
 *
 * BATCH SCOPE (D3=A confirmed 2026-10-08): the turn-lock strategy + G3
 * field fix, plus the earlier CORE-05 / L6 drafting reset. D3=A removes the
 * non-progress mis-lock branch so obs_recall / subagent / MCP / codemode
 * stay callable next to an active goal; G3 fixes the progress-exception
 * read (`event.input`, not the nonexistent `event.args`). The two changes
 * ship and revert as one unit (spec §7).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import goalExtension from "../goal.ts";
import { FakeHost } from "../../../test/contracts/fake-host.ts";
import { writeActiveGoalFile } from "../storage/goal-files.ts";
import { createGoal } from "../goal-record.ts";
import { coreBus, resetCoreBusForTests } from "../../bus.ts";
import { PROPOSE_DRAFT_TOOL_NAME, QUESTION_TOOL_NAME } from "../goal-tool-names.ts";

interface ToolCallEvent {
	type: "tool_call";
	toolCallId: string;
	toolName: string;
	input: Record<string, unknown>;
	parentToolCallId?: string;
}

function setupWithPi(patch?: (pi: Record<string, unknown>) => void) {
	resetCoreBusForTests();
	const cwd = mkdtempSync(path.join(tmpdir(), "pi-goal-lock-"));
	const host = new FakeHost();
	const pi = host.asPi() as Record<string, unknown>;
	patch?.(pi);
	goalExtension(pi as never);
	const ctx = host.makeCtx({ cwd, ui: true });
	return { cwd, host, ctx, cleanup: () => rmSync(cwd, { recursive: true, force: true }) };
}

/** Active + autoContinue goal on disk, focused via session_start, one turn started. */
async function setupActiveGoal(opts: { auditor?: unknown } = {}) {
	resetCoreBusForTests();
	const cwd = mkdtempSync(path.join(tmpdir(), "pi-goal-lock-"));
	const host = new FakeHost();
	goalExtension(host.asPi(), (opts.auditor ? { auditor: opts.auditor as never } : {}) as never);
	const ctx = host.makeCtx({ cwd, ui: true, idle: true });
	const cleanup = () => rmSync(cwd, { recursive: true, force: true });
	writeActiveGoalFile({ cwd }, createGoal({ objective: "=== Goal ===\nObjective: ship the decoder", autoContinue: true, sisyphus: false }, Date.UTC(2026, 9, 8)));
	await host.fire("session_start", { reason: "new" }, ctx);
	await host.fire("turn_start", {}, ctx);
	const f = { cwd, host, ctx, cleanup };
	const busGoal = coreBus().snapshot().goal;
	assert.equal(busGoal.active, true, "fixture must reach an active focused goal");
	return f;
}

/** Fire one tool_call; returns the handler result (undefined = pass, {block} = blocked). */
function toolCall(f: { host: FakeHost; ctx: Record<string, unknown> }, toolName: string, input: Record<string, unknown> = {}, extra: Partial<ToolCallEvent> = {}): Promise<unknown> {
	return f.host.fire(
		"tool_call",
		{ type: "tool_call", toolCallId: `c-${toolName}-${Math.random().toString(36).slice(2, 7)}`, toolName, input, ...extra },
		f.ctx,
	);
}

function isBlocked(result: unknown): boolean {
	return !!result && typeof result === "object" && (result as { block?: boolean }).block === true;
}

test("L6 (CORE-05): a throwing sendMessage resets confirmationIntent and restores the non-drafting tool set", async () => {
	const f = setupWithPi((pi) => {
		pi.sendMessage = () => {
			throw new Error("simulated send failure");
		};
	});
	try {
		await f.host.commands.get("goal")!("fix the bug", f.ctx as never);
		// the error is surfaced (direct notify or the bus tail queue), not swallowed
		const busMsgs = (coreBus().snapshot().notifications ?? []).map((n) => n.msg);
		assert.ok(
			[...f.host.notifications, ...busMsgs].some((n) => n.includes("Could not start")),
			"failure notice must be surfaced",
		);
		// the LAST tool-set sync reflects the reset: drafting-only tools are
		// gone, the always-available commit tool remains
		const last = f.host.activeToolsCalls[f.host.activeToolsCalls.length - 1]!;
		assert.ok(!last.includes(QUESTION_TOOL_NAME), `goal_question must not stay active after a failed draft start (got: ${last.join(",")})`);
		assert.ok(last.includes(PROPOSE_DRAFT_TOOL_NAME));
	} finally {
		f.cleanup();
	}
});

test("L6 control: a SUCCESSFUL draft start keeps the drafting tool set", async () => {
	const f = setupWithPi();
	try {
		await f.host.commands.get("goal")!("fix the bug", f.ctx as never);
		const last = f.host.activeToolsCalls[f.host.activeToolsCalls.length - 1]!;
		assert.ok(last.includes(QUESTION_TOOL_NAME), "drafting phase exposes goal_question");
	} finally {
		f.cleanup();
	}
});

test("L1 (D3=A): obs_recall then edit in the same turn — edit is NOT blocked", async () => {
	const f = await setupActiveGoal();
	try {
		assert.equal(await toolCall(f, "obs_recall", { id: "obs-1" }), undefined, "obs_recall passes");
		assert.equal(isBlocked(await toolCall(f, "edit", { path: "a.ts", oldString: "x", newString: "y" })), false, "edit after obs_recall must pass");
	} finally {
		f.cleanup();
	}
});

test("L2 (D3=A): subagent / MCP / codemode and nested read do not lock the turn", async () => {
	const f = await setupActiveGoal();
	try {
		for (const [tool, input, extra] of [
			["subagent", { prompt: "scout" }, {}],
			["mcp__exa__search", { query: "q" }, {}],
			["codemode", { script: "ls" }, {}],
			["read", { path: "notes.txt" }, { parentToolCallId: "c-codemode-1" }],
		] as const) {
			assert.equal(await toolCall(f, tool, input, extra), undefined, `${tool} passes`);
			assert.equal(
				isBlocked(await toolCall(f, "edit", { path: "a.ts", oldString: "x", newString: "y" })),
				false,
				`edit after ${tool} (parentToolCallId=${extra.parentToolCallId ?? "-"}) must pass`,
			);
		}
	} finally {
		f.cleanup();
	}
});

test("L3a: pause_goal SUCCESS locks the turn (edit blocked, get_goal still allowed)", async () => {
	const f = await setupActiveGoal();
	try {
		await f.host.tools.get("pause_goal")!.execute("t-pause", { reason: "missing credentials" }, undefined, undefined, f.ctx as never);
		assert.equal(isBlocked(await toolCall(f, "edit", { path: "a.ts", oldString: "x", newString: "y" })), true, "edit after pause_goal must be blocked");
		assert.equal(await toolCall(f, "get_goal"), undefined, "get_goal stays available after the stop");
	} finally {
		f.cleanup();
	}
});

test("L3a-neg: a FAILED pause_goal (empty reason) does not lock the turn", async () => {
	const f = await setupActiveGoal();
	try {
		await assert.rejects(
			() => f.host.tools.get("pause_goal")!.execute("t-pause2", { reason: "  " }, undefined, undefined, f.ctx as never),
			/pause_goal requires a non-empty reason/,
		);
		assert.equal(isBlocked(await toolCall(f, "edit", { path: "a.ts", oldString: "x", newString: "y" })), false, "failed pause must not lock the turn");
	} finally {
		f.cleanup();
	}
});

test("L3b: abort_goal SUCCESS locks the turn", async () => {
	const f = await setupActiveGoal();
	try {
		await f.host.tools.get("abort_goal")!.execute("t-abort", { reason: "user abandoned it" }, undefined, undefined, f.ctx as never);
		assert.equal(isBlocked(await toolCall(f, "edit", { path: "a.ts", oldString: "x", newString: "y" })), true, "edit after abort_goal must be blocked");
		assert.equal(await toolCall(f, "get_goal"), undefined, "get_goal stays available after the stop");
	} finally {
		f.cleanup();
	}
});

test("L3c: apply_goal_tweak SUCCESS (after /goal-tweak drafting) locks the turn", async () => {
	const f = await setupActiveGoal();
	try {
		await f.host.commands.get("goal-tweak")!("", f.ctx as never);
		const res = await f.host.tools.get("apply_goal_tweak")!.execute(
			"t-tweak",
			{ newObjective: "=== Goal ===\nObjective: ship the decoder v2", changeSummary: "scope narrowed" },
			undefined,
			undefined,
			f.ctx as never,
		);
		assert.ok(res, "apply_goal_tweak executes");
		assert.equal(isBlocked(await toolCall(f, "edit", { path: "a.ts", oldString: "x", newString: "y" })), true, "edit after apply_goal_tweak must be blocked");
		assert.equal(await toolCall(f, "get_goal"), undefined, "get_goal stays available after the stop");
	} finally {
		f.cleanup();
	}
});

test("L3d: update_goal=complete with an APPROVED audit locks the turn", async () => {
	// Fake auditor seam (goal-audit-flow already exposes the same parameter
	// seam; goal.ts forwards it from its test deps).
	const f = await setupActiveGoal({
		auditor: async () => ({ approved: true, disapproved: false, output: "<approved/>", model: "fake-auditor" }),
	});
	try {
		const res = (await f.host.tools.get("update_goal")!.execute("t-complete", { status: "complete", completionSummary: "shipped" }, undefined, undefined, f.ctx as never)) as { terminate?: boolean };
		assert.equal(res.terminate, true, "approved completion terminates the run");
		assert.equal(isBlocked(await toolCall(f, "edit", { path: "a.ts", oldString: "x", newString: "y" })), true, "edit after approved complete must be blocked");
		assert.equal(await toolCall(f, "get_goal"), undefined, "get_goal stays available after the stop");
	} finally {
		f.cleanup();
	}
});

test("L3d-neg: update_goal=complete with a REJECTED audit does not lock the turn", async () => {
	const f = await setupActiveGoal({
		auditor: async () => ({ approved: false, disapproved: true, output: "<disapproved/>", model: "fake-auditor" }),
	});
	try {
		const res = (await f.host.tools.get("update_goal")!.execute("t-complete2", { status: "complete", completionSummary: "not really" }, undefined, undefined, f.ctx as never)) as { content: Array<{ type: string; text: string }> };
		assert.ok(res.content[0]!.text.length > 0 && !/"terminate"|archived/i.test(res.content[0]!.text), "rejection text returned, goal stays open");
		assert.equal(isBlocked(await toolCall(f, "edit", { path: "a.ts", oldString: "x", newString: "y" })), false, "rejected audit must not lock the turn");
	} finally {
		f.cleanup();
	}
});

test("L4: turn_start resets the stop lock", async () => {
	const f = await setupActiveGoal();
	try {
		await f.host.tools.get("pause_goal")!.execute("t-pause3", { reason: "blocked" }, undefined, undefined, f.ctx as never);
		assert.equal(isBlocked(await toolCall(f, "edit", { path: "a.ts", oldString: "x", newString: "y" })), true, "locked right after pause");
		await f.host.fire("turn_start", {}, f.ctx);
		assert.equal(isBlocked(await toolCall(f, "edit", { path: "a.ts", oldString: "x", newString: "y" })), false, "next turn's edit passes again");
	} finally {
		f.cleanup();
	}
});

test("L5a (G3): bash echo is progress-neutral — no nudge reset, no stop lock, following edit passes", async () => {
	const f = await setupActiveGoal();
	try {
		// Two get_goal tool_calls bring the reminder counter to 2 (nudge threshold).
		await toolCall(f, "get_goal");
		await toolCall(f, "get_goal");
		const first = (await f.host.tools.get("get_goal")!.execute("g1", {}, undefined, undefined, f.ctx as never)) as { content: Array<{ type: string; text: string }> };
		assert.ok(first.content[0]!.text.includes("[NUDGE]"), "counter at 2 shows the nudge");
		// echo bash: progress-neutral — the nudge counter must survive.
		assert.equal(await toolCall(f, "bash", { command: "echo hi" }), undefined, "echo bash passes");
		const second = (await f.host.tools.get("get_goal")!.execute("g2", {}, undefined, undefined, f.ctx as never)) as { content: Array<{ type: string; text: string }> };
		assert.ok(second.content[0]!.text.includes("[NUDGE]"), "echo bash must NOT reset the get_goal reminder counter");
		assert.equal(isBlocked(await toolCall(f, "edit", { path: "a.ts", oldString: "x", newString: "y" })), false, "edit after echo bash passes (no stop lock)");
	} finally {
		f.cleanup();
	}
});

test("L5b (G3): read of .pi/goals/ is progress-neutral — no nudge reset, no stop lock", async () => {
	const f = await setupActiveGoal();
	try {
		await toolCall(f, "get_goal");
		await toolCall(f, "get_goal");
		await toolCall(f, "read", { path: ".pi/goals/x.md" });
		const after = (await f.host.tools.get("get_goal")!.execute("g3", {}, undefined, undefined, f.ctx as never)) as { content: Array<{ type: string; text: string }> };
		assert.ok(after.content[0]!.text.includes("[NUDGE]"), "goal-file read must NOT reset the get_goal reminder counter");
		assert.equal(isBlocked(await toolCall(f, "edit", { path: "a.ts", oldString: "x", newString: "y" })), false, "edit after goal-file read passes (no stop lock)");
	} finally {
		f.cleanup();
	}
});

test("L7 (D3=A): a run that only called obs_recall still queues an agent_end continuation", async () => {
	const f = await setupActiveGoal();
	try {
		await toolCall(f, "obs_recall", { id: "obs-7" });
		await f.host.fire("turn_end", { message: { role: "assistant", content: [{ type: "text", text: "recalled context" }] } }, f.ctx);
		await f.host.fire("agent_end", { messages: [] }, f.ctx);
		await new Promise((r) => setTimeout(r, 40));
		const followUps = f.host.sentMessages.filter((m) => m.message.customType === "pi-goal-event");
		assert.ok(followUps.length >= 1, "agent_end continuation must still fire (loop rhythm unchanged by D3=A)");
	} finally {
		f.cleanup();
	}
});
