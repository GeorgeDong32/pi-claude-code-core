import assert from "node:assert/strict";
import test from "node:test";

import { buildGoalRunningNotification } from "../widgets/goal-notifications.ts";

test("buildGoalRunningNotification uses compact widget-style lines", () => {
	assert.equal(
		buildGoalRunningNotification({
			objective: "=== Goal ===\nObjective: 研究 pi-goal 的 compact 行为\nSuccess criteria: answer",
			sisyphus: false,
			autoContinue: true,
		}),
		"● Goal running\n├─ ⟡ 研究 pi-goal 的 compact 行为\n└─ auto-continue on",
	);
	assert.equal(
		buildGoalRunningNotification({
			objective: "=== Sisyphus Goal ===\nObjective: Ship safely",
			sisyphus: true,
			autoContinue: false,
		}),
		"◆ Sisyphus running\n├─ ⟡ Ship safely\n└─ manual mode",
	);
});
