import assert from "node:assert/strict";
import test from "node:test";

import {
	formatQuestionnaireAnswers,
	runGoalQuestionnaire,
	isHeadlessQuestionSufficientForDraft,
	normalizeQuestionnaireQuestions,
	proposalDialogFailureMessage,
	proposalDecisionFromQuestionnaireResult,
	shouldAutoConfirmProposal,
	type GoalQuestionnaireResult,
} from "../goal-questionnaire.ts";

test("normalizeQuestionnaireQuestions trims ids, de-duplicates, filters options, and validates recommended", () => {
	assert.deepEqual(
		normalizeQuestionnaireQuestions([
			{ id: " scope ", question: "Scope?", options: [" A ", "", "B"], recommended: 1 },
			{ id: "scope", question: "Again?", options: ["X"], recommended: 2, allowCustom: false },
			{ id: "  ", question: "Empty id?", options: [], recommended: 0 },
		]),
		[
			{ id: "scope", question: "Scope?", options: [" A ", "B"], recommended: 1, allowCustom: true },
			{ id: "scope-2", question: "Again?", options: ["X"], recommended: undefined, allowCustom: false },
			{ id: "q3", question: "Empty id?", options: [], recommended: undefined, allowCustom: true },
		],
	);
});

test("formatQuestionnaireAnswers records answers only — questions stay in the call args", () => {
	const result: GoalQuestionnaireResult = {
		cancelled: false,
		questions: [
			{ id: "scope", question: "Scope?", context: "Pick one", options: ["A", "B"], allowCustom: true },
			{ id: "notes", question: "Notes?", options: [], allowCustom: true },
		],
		answers: [
			{ id: "scope", question: "Scope?", answer: "A", wasCustom: false },
			{ id: "notes", question: "Notes?", answer: "Custom", wasCustom: true },
		],
	};

	assert.equal(formatQuestionnaireAnswers(result), "**scope:** A\n**notes:** (wrote) Custom");
});

test("headless question sufficiency blocks vague-topic default fabrication", () => {
	assert.equal(isHeadlessQuestionSufficientForDraft({
		topic: "整理笔记",
		questionText: "你的笔记目前存放在哪里，是什么格式？输出为什么形式？",
	}), false);
	assert.equal(isHeadlessQuestionSufficientForDraft({
		topic: "在 sandbox 当前目录创建 hello.txt，内容为 Hello, Goal!，不要修改其他文件。",
		questionText: "如果 hello.txt 已存在，应该覆盖还是停止？",
	}), true);
});

test("proposal confirmation helpers keep headless and cancel semantics stable", () => {
	assert.equal(shouldAutoConfirmProposal({ hasUI: false }), true);
	assert.equal(shouldAutoConfirmProposal({ hasUI: true, autoConfirmEnv: "1" }), true);
	assert.equal(shouldAutoConfirmProposal({ hasUI: true, autoConfirmEnv: "0" }), false);
	assert.equal(proposalDecisionFromQuestionnaireResult({ cancelled: true, answer: "Confirm — create this goal now" }), "continue");
	assert.equal(proposalDecisionFromQuestionnaireResult({ cancelled: false, answer: "Confirm — create this goal now" }), "confirm");
	assert.equal(proposalDecisionFromQuestionnaireResult({ cancelled: false, answer: "Continue chatting — keep refining" }), "continue");
	assert.match(proposalDialogFailureMessage(new Error("boom")), /NOT created/);
	assert.match(proposalDialogFailureMessage(new Error("boom")), /drafting remains active/);
});


test("questionnaire context and question wrap with a hanging indent", async () => {
	let lines: string[] | null = null;
	// Stub tui: every method access is a no-op (Editor only needs requestRender).
	const fakeTui = new Proxy({}, { get: () => () => {} }) as never;
	const theme = {
		fg: (_c: string, s: string) => s,
		bg: (_c: string, s: string) => s,
		bold: (s: string) => s,
	} as never;
	const ctx = {
		hasUI: true,
		mode: "tui",
		ui: {
			custom: async (factory: (t: unknown, th: unknown, kb: unknown, done: (v: unknown) => void) => { render(w: number): string[] }, _opts?: unknown) => {
				const comp = factory(fakeTui, theme, undefined, () => {});
				lines = comp.render(60);
				return null;
			},
		},
	} as never;
	const result = await runGoalQuestionnaire(ctx, [{
		id: "confirm",
		question: "Confirm Goal Draft",
		context: "=== Goal ===\nObjective: ship the decoder rewrite with tests and coverage",
		options: ["Confirm — create this goal now", "Continue chatting — keep refining"],
		recommended: 0,
		allowCustom: false,
	}]);
	assert.equal(result, null); // stub custom resolves null (cancel path)
	const strip = (s: string) => s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");
	const plain = (lines ?? []).map(strip);
	const question = plain.find((l) => l.includes("Confirm Goal Draft"));
	assert.ok(question, "question line rendered");
	assert.ok(question.startsWith(" "), `question not indented: ${JSON.stringify(question)}`);
	const contextLines = plain.filter((l) => l.includes("=== Goal") || l.includes("Objective:"));
	assert.ok(contextLines.length >= 2, "multi-line context rendered");
	for (const line of contextLines) {
		assert.ok(line.startsWith(" "), `context not indented: ${JSON.stringify(line)}`);
	}
});
