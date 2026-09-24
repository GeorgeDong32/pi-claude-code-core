import assert from "node:assert/strict";
import test from "node:test";

import { buildGoalRunningNotification } from "../widgets/goal-notifications.ts";

test("buildGoalRunningNotification is a one-line ack that does not duplicate the widget", () => {
	assert.equal(
		buildGoalRunningNotification({
			objective: "=== Goal ===\nObjective: 研究 pi-goal 的 compact 行为\nSuccess criteria: answer",
			sisyphus: false,
			autoContinue: true,
		}),
		"Goal set · auto-continue on",
	);
	assert.equal(
		buildGoalRunningNotification({
			objective: "=== Sisyphus Goal ===\nObjective: Ship safely",
			sisyphus: true,
			autoContinue: false,
		}),
		"Sisyphus goal set · manual mode",
	);
});
