/**
 * Pins the collapsed rendering of pi-goal-event entries: drafting injections
 * collapse to the user's own words ("⟳ Goal <topic>"), while checkpoint and
 * topic-less drafting keep their bare labels. The full prompt stays in the
 * message content — only display is affected.
 */
import assert from "node:assert/strict";
import test from "node:test";

import type { Theme } from "@earendil-works/pi-coding-agent";
import { renderGoalEvent } from "../goal.ts";
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
	assert.equal(textOf(out), "⟳ Goal ship the retry decoder");
});

test("collapsed sisyphus drafting uses the Sisyphus noun", () => {
	const out = renderGoalEvent(details({ objective: "ordered rollout", focus: "sisyphus" }), { expanded: false }, theme);
	assert.equal(textOf(out), "⟳ Sisyphus ordered rollout");
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
