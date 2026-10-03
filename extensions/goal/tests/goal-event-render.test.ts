/**
 * Pins the collapsed rendering of pi-goal-event entries: drafting injections
 * collapse to the user's own words (nerd-font beacon + "Goal <topic>"), while checkpoint and
 * topic-less drafting keep their bare labels. The full prompt stays in the
 * message content — only display is affected.
 */
import assert from "node:assert/strict";
import test from "node:test";

import type { Theme } from "@earendil-works/pi-coding-agent";
import { renderGoalEvent } from "../renderers.ts";
import type { GoalEventDetails } from "../goal-record.ts";

const theme = {
	fg: (_color: string, value: string) => value,
} as Theme;

const textOf = (t: unknown): string => (t as { text: string }).text;

function details(overrides: Partial<GoalEventDetails>): { details: GoalEventDetails } {
	return { details: { kind: "drafting", goalId: "g1", ...overrides } };
}

test("collapsed drafting with topic renders the user's words, not the protocol", () => {
	const out = renderGoalEvent(details({ objective: "ship the retry decoder" }), { expanded: false }, theme);
	assert.equal(textOf(out), "\uf4de  Goal ship the retry decoder");
});

test("collapsed sisyphus drafting uses the Sisyphus noun", () => {
	const out = renderGoalEvent(details({ objective: "ordered rollout", focus: "sisyphus" }), { expanded: false }, theme);
	assert.equal(textOf(out), "\uf4de  Sisyphus ordered rollout");
});

test("collapsed drafting without a topic keeps the bare label", () => {
	const out = renderGoalEvent(details({}), { expanded: false }, theme);
	assert.equal(textOf(out), "Goal goal drafting");
});

test("collapsed checkpoint label is unchanged", () => {
	const out = renderGoalEvent(details({ kind: "checkpoint", status: "active" }), { expanded: false }, theme);
	assert.equal(textOf(out), "Goal checkpoint");
});

test("expanded drafting still exposes the objective and ids", () => {
	const out = renderGoalEvent(details({ objective: "ship it", goalId: "g7" }), { expanded: true }, theme);
	const text = textOf(out);
	assert.match(text, /^Goal goal drafting/);
	assert.match(text, /Objective: ship it/);
	assert.match(text, /Goal id: g7/);
});

// --- pi-goal-audit-event compact rendering ---

import { renderGoalAuditEvent } from "../renderers.ts";
import type { GoalAuditEventDetails } from "../renderers.ts";

function auditDetails(overrides: Partial<GoalAuditEventDetails>): { content?: unknown; details: GoalAuditEventDetails } {
	return { details: { phase: "started", goalId: "g1", ...overrides } };
}

test("collapsed audit start shows the tool-call-like line", () => {
	const out = renderGoalAuditEvent(auditDetails({}), { expanded: false }, theme);
	assert.equal(textOf(out), "\uf4af  Goal Audit start ...");
});

test("collapsed approved renders the goal-achieved summary with final usage", () => {
	const out = renderGoalAuditEvent(
		auditDetails({ phase: "approved", achievedAt: new Date("2026-09-24T14:32:00").getTime(), activeSeconds: 3725, tokensUsed: 45200, auditAttempts: 3 }),
		{ expanded: false },
		theme,
	);
	assert.equal(textOf(out), "\uf4de  Goal achieved at 14:32 (1h02m05s · 3 attempts · 45K tokens)");
});

test("first-try approval reads naturally as one attempt", () => {
	const out = renderGoalAuditEvent(
		auditDetails({ phase: "approved", achievedAt: new Date("2026-09-24T14:32:00").getTime(), activeSeconds: 23, tokensUsed: 566, auditAttempts: 1 }),
		{ expanded: false },
		theme,
	);
	assert.equal(textOf(out), "\uf4de  Goal achieved at 14:32 (23s · 1 attempt · 566 tokens)");
});

test("collapsed approved without attempts omits the stat (legacy entries)", () => {
	const out = renderGoalAuditEvent(
		auditDetails({ phase: "approved", achievedAt: new Date("2026-09-24T14:32:00").getTime(), activeSeconds: 23, tokensUsed: 566 }),
		{ expanded: false },
		theme,
	);
	assert.equal(textOf(out), "\uf4de  Goal achieved at 14:32 (23s · 566 tokens)");
});

test("collapsed approved without stats falls back to the plain label", () => {
	const out = renderGoalAuditEvent(auditDetails({ phase: "approved" }), { expanded: false }, theme);
	assert.equal(textOf(out), "Goal Audit approved");
});

test("collapsed rejected points at the report; expanded keeps full content", () => {
	const collapsed = renderGoalAuditEvent(auditDetails({ phase: "rejected" }), { expanded: false }, theme);
	assert.equal(textOf(collapsed), "\uf4e7  Goal Audit failed — expand (ctrl+o) for the report");
	const expanded = renderGoalAuditEvent({ ...auditDetails({ phase: "rejected" }), content: "report body" }, { expanded: true }, theme);
	assert.match(textOf(expanded), /Goal audit rejected/);
	assert.match(textOf(expanded), /report body/);
});

test("collapsed passed renders the in-place pass marker", () => {
	const out = renderGoalAuditEvent(auditDetails({ phase: "passed" }), { expanded: false }, theme);
	assert.equal(textOf(out), "\uf41d  Goal Audit pass");
});

// ---------- renderGoalResult (B3 structured kind) ----------

import { renderGoalResult } from "../renderers.ts";
import type { GoalRecord, GoalStateEntry } from "../goal-record.ts";

function stateDetails(kind: GoalStateEntry["kind"], goal: GoalRecord | null): { details: GoalStateEntry; content: Array<{ type: string; text: string }> } {
	return {
		details: { version: 3, ...(kind ? { kind } : {}), goal },
		content: [{ type: "text", text: "Goal paused. Reason: user asked." }],
	};
}

test("a result with kind renders its text verbatim — wording cannot flip the branch", () => {
	const out = renderGoalResult(stateDetails("paused", null), theme);
	assert.equal(textOf(out), "Goal paused. Reason: user asked.");
});

test("a result without kind falls back to the legacy prefix match", () => {
	const out = renderGoalResult(stateDetails(undefined, null), theme);
	assert.equal(textOf(out), "Goal paused. Reason: user asked.");
});

test("unclassified text without kind renders the one-line goal summary", () => {
	const goal = { id: "g1", status: "active", autoContinue: true, objective: "ship it", usage: { activeSeconds: 0, tokensUsed: 0 } } as unknown as GoalRecord;
	const out = renderGoalResult(
		{ details: { version: 3, goal }, content: [{ type: "text", text: "create_goal REJECTED: direct agent creation is disabled." }] },
		theme,
	);
	assert.match(textOf(out), /^Goal /);
	assert.doesNotMatch(textOf(out), /REJECTED/);
});
