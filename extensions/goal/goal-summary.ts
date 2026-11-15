/**
 * goal-summary.ts — usage summary text, the serializable widget projection,
 * and the missing-criteria completion notice (SPEC SR E13a: split from
 * goal.ts; pure module — no pi access, no closure state).
 *
 * Spec IDs: GO-A (usage display), DC4b (serializable widget projection),
 * G3-C20/G3-C21 (criteria coverage notice + third-attempt warning).
 *
 * Design decisions:
 * - WidgetGoalProjection is the exported return shape of widgetGoalProjection:
 *   carrying it on the bus snapshot makes the widget rebuildable by any
 *   consumer without closure getters.
 * - missingCriteriaLines scans [Cn] tags only; objectives without numbered
 *   criteria never trigger the notice.
 */
import {
	formatDuration,
	formatTokenValue,
	formatCostValue,
	statusLabel,
	truncateText,
	pauseReasonLabel,
} from "./goal-core.ts";
import type { GoalRecord } from "./goal-record.ts";

// ---------- summaries ----------

function usageLines(goal: GoalRecord): string[] {
	return [
		`Time spent: ${formatDuration(goal.usage.activeSeconds)}`,
		`Tokens used: ${formatTokenValue(goal.usage.tokensUsed)}`,
		`Cost: ${formatCostValue(goal.usage.costUsed)}`,
	];
}

export function detailedSummary(goal: GoalRecord | null): string {
	if (!goal) return "No goal is set. Use /goals <topic> or /sisyphus <topic> to discuss, or /goals-set <objective> / /sisyphus-set <objective> to start immediately.";
	const lines = [
		`Goal: ${goal.objective}`,
		`Status: ${statusLabel(goal)}`,
		`Auto-continue: ${goal.autoContinue ? "on" : "off"}`,
		...usageLines(goal),
	];
	if (goal.sisyphus) {
		lines.push("Mode: Sisyphus (prompt/criteria variant; shared goal lifecycle)");
	}
	if (goal.activePath) lines.push(`File: ${goal.activePath}`);
	if (goal.archivedPath) lines.push(`Archive: ${goal.archivedPath}`);
	if (goal.stopReason) lines.push(`Stop reason: ${goal.stopReason}`);
	if (goal.pauseReason) {
		const { label, text } = pauseReasonLabel(goal.pauseReason);
		lines.push(`${label}: ${text}`);
	}
	if (goal.pauseSuggestedAction) lines.push(`Agent suggests: ${goal.pauseSuggestedAction}`);
	if (goal.userNote) lines.push(`User note: ${truncateText(goal.userNote, 80)}`);
	return lines.join("\n");
}

/**
 * Live above-editor widget for the active goal. Inspired by rpiv-todo's
 * TodoOverlay: register the widget once with a factory, read live state
 * via the closure at render time, and call `tui.requestRender()` on every
 * state change so the overlay refreshes without re-registration.
 *
 * Layout (sisyphus, running):
 *   ◆ Sisyphus  [▰▰▰▱▱] 3/5
 *   ├─ ⟡ extract validator … wire it … update tests.
 *   ├─ Status: sisyphus running · auto-continue · 14m 21s · 24.3k tokens
 *   └─ .pi/goals/active_goal_xxx.md
 *
 * Layout (paused with blocker):
 *   ⊘ Goal paused
 *   ├─ ⟡ improve benchmark coverage for the parser
 *   ├─ Status: paused (agent) · 2m 14s · 12.4k tokens
 *   ├─ Blocker: cannot find the tests directory
 *   └─ Suggested: ask the user for the test location
 */
// DC4b: serializable projection of the fields renderGoalWidgetLines
// consumes — carrying it on the snapshot makes the widget rebuildable
// by any consumer without closure getters.
export interface WidgetGoalProjection {
	objective: string; status: string; sisyphus: boolean;
	stopReason?: string; pauseReason?: string; pauseSuggestedAction?: string;
	activePath?: string; archivedPath?: string; tokensUsed: number; activeSeconds: number; costUsed: number;
}

export function widgetGoalProjection(goal: GoalRecord): WidgetGoalProjection {
	return {
		objective: goal.objective,
		status: goal.status,
		sisyphus: goal.sisyphus,
		...(goal.stopReason !== undefined ? { stopReason: goal.stopReason } : {}),
		...(goal.pauseReason !== undefined ? { pauseReason: goal.pauseReason } : {}),
		...(goal.pauseSuggestedAction !== undefined ? { pauseSuggestedAction: goal.pauseSuggestedAction } : {}),
		...(goal.activePath !== undefined ? { activePath: goal.activePath } : {}),
		...(goal.archivedPath !== undefined ? { archivedPath: goal.archivedPath } : {}),
		tokensUsed: goal.usage.tokensUsed,
		activeSeconds: goal.usage.activeSeconds,
		costUsed: goal.usage.costUsed,
	};
}

/** G3-C21 threshold — named constant per the spec's hard constraint ⑥. */
export const AUDIT_ATTEMPT_NOTICE = 3;

/** G3-C20: which [Cn] criteria appear in the objective but not in the
 * completion summary. Objectives without numbered criteria → []. */
export function missingCriteriaLines(objective: string, completionSummary: string): string[] {
	const ids = new Set<string>();
	for (const m of objective.matchAll(/\[(C\d+)\]/g)) ids.add(m[1]!);
	if (ids.size === 0) return [];
	const present = new Set<string>();
	for (const m of completionSummary.matchAll(/\[(C\d+)\]/g)) present.add(m[1]!);
	return [...ids].filter((id) => !present.has(id)).sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
}
