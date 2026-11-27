import { asRecord, cloneGoal, type GoalRecord, type GoalResultKind, type GoalStateEntry } from "./goal-record.ts";


export const STATE_ENTRY = "pi-goal-state";
export const FOCUS_ENTRY = "pi-goal-focus";
export const GOAL_EVENT_ENTRY = "pi-goal-event";
export const GOAL_AUDIT_ENTRY = "pi-goal-audit-event";

export function goalDetails(goal: GoalRecord | null, kind?: GoalResultKind): GoalStateEntry {
	return { version: 3, ...(kind ? { kind } : {}), goal: goal ? cloneGoal(goal) : null };
}

export function extractGoalIdFromInjectedMessage(text: string): string | null {
	if (/^\[GOAL (?:DRAFTING|TWEAK DRAFTING)\b/.test(text)) return null;
	const xmlMatch = text.match(/^<pi_goal_continuation\s+goal_id=\"([^\"]+)\"/);
	if (xmlMatch) return xmlMatch[1] ?? null;
	const match = text.match(/^\[(?:GOAL CHECKPOINT|GOAL CONTINUATION|GOAL STALE) goalId=([^\]\s]+)\]/);
	return match?.[1] ?? null;
}

export function goalEventMessageId(message: { customType?: string; details?: unknown; content?: unknown }): string | null {
	if (message.customType !== GOAL_EVENT_ENTRY) return null;
	const details = asRecord(message.details);
	if (details?.kind === "drafting") return null;
	const goalId = details && typeof details.goalId === "string" ? details.goalId : null;
	if (goalId) return goalId;
	return typeof message.content === "string" ? extractGoalIdFromInjectedMessage(message.content) : null;
}
