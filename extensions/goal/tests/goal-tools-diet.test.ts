/**
 * Goal tools diet (spec 2026-11-27-goal-tools-diet v2): the six lifecycle
 * tools are codemode-exposed and never declared, so the declared tool list is
 * the same with no goal, during a draft, with an active/paused goal and in a
 * tweak interview. The drafting-phase rules they used to get from visibility
 * are now execute-time gates. Pinned here:
 *   - exposure per tool and the always-on pair's prompt cost caps
 *   - the declared set across a whole goal lifecycle (prefix stability)
 *   - the gates reject in the wrong phase and pass in the right one
 *   - the injected prompts name the codemode call form
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
import { resetCoreBusForTests } from "../../bus.ts";
import { validateDraftingInterview, validateNoDraftingPhase } from "../goal-policy.ts";
import { goalPrompt, continuationPrompt, goalTweakDraftingPrompt } from "../prompts/goal-prompts.ts";
import { CREATE_GOAL_TOOL_NAME, PROPOSE_DRAFT_TOOL_NAME, QUESTION_TOOL_NAME, SISYPHUS_STEP_TOOL_NAME } from "../goal-tool-names.ts";

const CODEMODE_TOOLS = ["update_goal", "pause_goal", "abort_goal", "apply_goal_tweak", "goal_question", "goal_questionnaire"];

type ToolDef = { name: string; description?: string; parameters?: unknown; promptSnippet?: string; promptGuidelines?: string[]; exposure?: string };
const cost = (t: ToolDef) =>
	(t.description?.length ?? 0)
	+ JSON.stringify(t.parameters ?? {}).length
	+ (t.promptGuidelines ?? []).join("").length
	+ (t.promptSnippet?.length ?? 0);
const declared = (host: FakeHost) => [...(host.activeToolsCalls.at(-1) ?? [])].sort().join(",");

function setup(cwd?: string) {
	resetCoreBusForTests();
	const dir = cwd ?? mkdtempSync(path.join(tmpdir(), "pi-goal-diet-"));
	const host = new FakeHost();
	goalExtension(host.asPi());
	const ctx = host.makeCtx({ cwd: dir, ui: true });
	return { host, ctx, cwd: dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

async function command(f: ReturnType<typeof setup>, name: string, args: string): Promise<void> {
	await f.host.commands.get(name)!(args, f.ctx as never);
}

test("exposure: the six lifecycle tools are codemode-exposed with one-line descriptions and no prompt metadata", () => {
	const f = setup();
	try {
		for (const name of CODEMODE_TOOLS) {
			const tool = f.host.tools.get(name) as ToolDef | undefined;
			assert.ok(tool, `${name} registered`);
			assert.equal(tool.exposure, "codemode", name);
			assert.ok((tool.description?.length ?? 0) <= 140, `${name} description one line`);
			assert.equal(tool.promptSnippet, undefined, `${name} carries no promptSnippet`);
			assert.equal(tool.promptGuidelines, undefined, `${name} carries no promptGuidelines`);
		}
		assert.notEqual((f.host.tools.get(PROPOSE_DRAFT_TOOL_NAME) as ToolDef).exposure, "codemode", "propose_goal_draft stays direct (plan mode rejects codemode)");
		assert.notEqual((f.host.tools.get("get_goal") as ToolDef).exposure, "codemode", "get_goal stays direct");
	} finally {
		f.cleanup();
	}
});

test("cost caps: the always-on goal pair stays under budget (description + schema + guidelines + snippet)", () => {
	const f = setup();
	try {
		const propose = cost(f.host.tools.get(PROPOSE_DRAFT_TOOL_NAME) as ToolDef);
		const get = cost(f.host.tools.get("get_goal") as ToolDef);
		assert.ok(propose <= 900, `propose_goal_draft ${propose} > 900`);
		assert.ok(get <= 400, `get_goal ${get} > 400`);
		assert.equal((f.host.tools.get(PROPOSE_DRAFT_TOOL_NAME) as { parameters?: { properties?: Record<string, unknown> } }).parameters?.properties?.draftId, undefined, "deprecated draftId removed");
	} finally {
		f.cleanup();
	}
});

test("declared set: identical with no goal, after a draft start, with an active goal, paused, resumed, in a tweak interview and after clear", async () => {
	const f = setup();
	try {
		const factory = declared(f.host);
		assert.ok(factory.includes("get_goal") && factory.includes(PROPOSE_DRAFT_TOOL_NAME));
		assert.ok(!factory.includes(CREATE_GOAL_TOOL_NAME) && !factory.includes(SISYPHUS_STEP_TOOL_NAME), "hidden pair stays undeclared");
		for (const name of CODEMODE_TOOLS) assert.ok(!factory.includes(name), `${name} never declared`);

		await f.host.fire("session_start", { reason: "new" }, f.ctx);
		assert.equal(declared(f.host), factory, "session_start");
		await command(f, "goal", "fix the bug");
		assert.equal(declared(f.host), factory, "draft start");
		await command(f, "goal-clear", "start over");

		writeActiveGoalFile({ cwd: f.cwd }, createGoal({ objective: "=== Goal ===\nObjective: ship the decoder", autoContinue: true, sisyphus: false }, Date.UTC(2026, 10, 27)));
		await f.host.fire("session_start", { reason: "new" }, f.ctx);
		assert.equal(declared(f.host), factory, "active goal focused");
		await command(f, "goal-pause", "waiting on a credential");
		assert.equal(declared(f.host), factory, "paused");
		await command(f, "goal-resume", "");
		assert.equal(declared(f.host), factory, "resumed");
		await command(f, "goal-tweak", "narrow the scope");
		assert.equal(declared(f.host), factory, "tweak interview");
		await command(f, "goal-clear", "done here");
		assert.equal(declared(f.host), factory, "cleared");
	} finally {
		f.cleanup();
	}
});

test("gates: lifecycle verbs are refused during a drafting interview and allowed outside one", async () => {
	const phaseNone = { confirmationIntent: null, tweakDraftingFor: null };
	assert.equal(validateNoDraftingPhase(phaseNone, "update_goal").ok, true);
	assert.equal(validateNoDraftingPhase({ confirmationIntent: {}, tweakDraftingFor: null }, "pause_goal").ok, false);
	const tweak = validateNoDraftingPhase({ confirmationIntent: null, tweakDraftingFor: "g1" }, "abort_goal");
	assert.equal(tweak.ok, false);
	assert.ok(!tweak.ok && /\/goal-tweak drafting interview/.test(tweak.message));

	const f = setup();
	try {
		await f.host.fire("session_start", { reason: "new" }, f.ctx);
		// a /goal draft start opens the confirmation interview
		await command(f, "goal", "fix the bug");
		const update = f.host.tools.get("update_goal")!;
		const out = (await update.execute("t1", { status: "complete", completionSummary: "x" }, undefined, undefined, f.ctx)) as { content: Array<{ text: string }> };
		assert.match(out.content[0]!.text, /update_goal REJECTED: a goal confirmation is in progress/);
		const pause = f.host.tools.get("pause_goal")!;
		const paused = (await pause.execute("t2", { reason: "blocked" }, undefined, undefined, f.ctx)) as { content: Array<{ text: string }> };
		assert.match(paused.content[0]!.text, /pause_goal REJECTED/);
	} finally {
		f.cleanup();
	}
});

test("gates: the question tools answer only inside a goal interview", async () => {
	assert.equal(validateDraftingInterview({ confirmationIntent: null, tweakDraftingFor: null }, "goal_question").ok, false);
	assert.equal(validateDraftingInterview({ confirmationIntent: { focus: "goal" }, tweakDraftingFor: null }, "goal_questionnaire").ok, true);
	assert.equal(validateDraftingInterview({ confirmationIntent: null, tweakDraftingFor: "g1" }, "goal_question").ok, true);

	const f = setup();
	const headless = f.host.makeCtx({ cwd: f.cwd, ui: false });
	try {
		await f.host.fire("session_start", { reason: "new" }, headless);
		const question = f.host.tools.get(QUESTION_TOOL_NAME)!;
		const outside = (await question.execute("q1", { question: "Which scope?" }, undefined, undefined, headless)) as { content: Array<{ text: string }> };
		assert.match(outside.content[0]!.text, /goal_question REJECTED: no goal interview is in progress/);
		await command(f, "goal", "fix the bug");
		const inside = (await question.execute("q2", { question: "Which scope?" }, undefined, undefined, headless)) as { content: Array<{ text: string }> };
		assert.doesNotMatch(inside.content[0]!.text, /REJECTED/);
	} finally {
		f.cleanup();
	}
});

test("prompts: every injected goal text names the codemode call form", () => {
	const goal = createGoal({ objective: "=== Goal ===\nObjective: ship it", autoContinue: true, sisyphus: false }, Date.UTC(2026, 10, 27)) as never;
	for (const text of [goalPrompt(goal), continuationPrompt(goal), goalTweakDraftingPrompt(goal as never, "hint")]) {
		assert.match(text, /codemode/, text.slice(0, 80));
		assert.match(text, /tools\.(update_goal|pause_goal|apply_goal_tweak)/);
		assert.doesNotMatch(text, /(?<![\w.])update_goal\(/, "no bare update_goal( call form");
	}
});
