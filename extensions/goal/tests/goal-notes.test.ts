import assert from "node:assert/strict";
import test from "node:test";

import { createGoal, normalizeGoalRecord, cloneGoal } from "../goal-record.ts";
import { continuationPrompt, goalPrompt, userNoteBlock, resumeNoteBlock } from "../prompts/goal-prompts.ts";

function goal(overrides: Record<string, unknown> = {}) {
	return {
		...createGoal({ objective: "ship the thing", autoContinue: true, sisyphus: false }, Date.UTC(2026, 0, 2)),
		...overrides,
	};
}

test("record round-trip: userNote persists non-empty, drops empty/missing", () => {
	const withNote = normalizeGoalRecord({ ...goal({ userNote: "always run gates before done" }) });
	assert.equal(withNote?.userNote, "always run gates before done");
	const empty = normalizeGoalRecord({ ...goal({ userNote: "   " }) });
	assert.equal(empty?.userNote, undefined);
	const missing = normalizeGoalRecord(goal());
	assert.equal(missing?.userNote, undefined);
	assert.equal(cloneGoal(withNote!).userNote, "always run gates before done");
});

test("blocks: userNoteBlock empty when unset; wrapped when set", () => {
	assert.equal(userNoteBlock(goal()), "");
	const block = userNoteBlock(goal({ userNote: "prefer Chinese reports" }));
	assert.match(block, /<user_note>/);
	assert.match(block, /prefer Chinese reports/);
	assert.match(block, /\/goal-note/);
});

test("resumeNoteBlock: one-shot labeling", () => {
	const block = resumeNoteBlock("按建议值执行");
	assert.match(block, /<resume_note>/);
	assert.match(block, /one-shot/);
	assert.match(block, /按建议值执行/);
});

test("continuationPrompt: carries userNote + resumeNote only when present", () => {
	const bare = continuationPrompt(goal());
	assert.doesNotMatch(bare, /<user_note>/);
	assert.doesNotMatch(bare, /<resume_note>/);

	const standing = continuationPrompt(goal({ userNote: "note A" }));
	assert.match(standing, /<user_note>\nnote A/);
	assert.doesNotMatch(standing, /<resume_note>/);

	const both = continuationPrompt(goal({ userNote: "note A" }), "note R");
	assert.match(both, /<user_note>\nnote A/);
	assert.match(both, /<resume_note>\nnote R/);
	assert.ok(both.indexOf("<resume_note>") < both.indexOf("completion audit"));
});

test("goalPrompt: standing note rides the initial goal prompt", () => {
	assert.doesNotMatch(goalPrompt(goal()), /<user_note>/);
	assert.match(goalPrompt(goal({ userNote: "note A" })), /<user_note>\nnote A/);
});

import { pauseReasonLabel } from "../goal-core.ts";

test("pauseReasonLabel: user-prefixed vs agent reasons", () => {
	assert.deepEqual(pauseReasonLabel("user: 太慢了，先停下"), { label: "User pause note", text: "太慢了，先停下" });
	assert.deepEqual(pauseReasonLabel("missing credentials"), { label: "Agent pause reason", text: "missing credentials" });
});

test("pauseReasonLabel: BH-R1 provider-error reasons get their own label (prefix stripped)", () => {
	assert.deepEqual(
		pauseReasonLabel("provider error: 429 quota exceeded"),
		{ label: "Provider error", text: "429 quota exceeded" },
	);
});
