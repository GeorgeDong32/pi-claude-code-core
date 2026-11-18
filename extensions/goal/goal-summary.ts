import {
	formatDuration,
	formatTokenValue,
	formatCostValue,
	statusLabel,
	truncateText,
	pauseReasonLabel,
} from "./goal-core.ts";
import type { GoalRecord } from "./goal-record.ts";


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

export const AUDIT_ATTEMPT_NOTICE = 3;

export function missingCriteriaLines(objective: string, completionSummary: string): string[] {
	const ids = new Set<string>();
	for (const m of objective.matchAll(/\[(C\d+)\]/g)) ids.add(m[1]!);
	if (ids.size === 0) return [];
	const present = new Set<string>();
	for (const m of completionSummary.matchAll(/\[(C\d+)\]/g)) present.add(m[1]!);
	return [...ids].filter((id) => !present.has(id)).sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
}
