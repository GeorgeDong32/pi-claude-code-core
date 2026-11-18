/**
 * goal-entries.ts — frozen session-entry constants, the pi-goal-state v3
 * payload projection, and injected-goal-id parsing (SPEC SR E13a: split
 * from goal.ts; pure module — no pi access, no closure state).
 *
 * Spec IDs: P0-CT-08 (frozen entry custom types), P2-2 (lifecycle-owned
 * pool/focus), Phase 5 C1 (structured continuation marker), B3 (v3 entry
 * shape), invariant 7 (frozen surfaces).
 *
 * Design decisions:
 * - STATE_ENTRY / FOCUS_ENTRY / GOAL_EVENT_ENTRY / GOAL_AUDIT_ENTRY are
 *   pinned by test/contracts/status-entries.test.ts — never rename.
 * - goalDetails emits the frozen payload v3; kind is additive.
 * - extractGoalIdFromInjectedMessage / goalEventMessageId are the single
 *   authority on "which goal does this injected message belong to".
 */
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
	// Phase 5 C1: structured outer marker `<pi_goal_continuation goal_id="..." kind="...">`.
	// Borrowed from pi-codex-goal. More robust than bare bracket text because
	// the angle brackets + attributes are nearly impossible for users to type
	// by accident, and the structure is grep-able / parse-able by external tooling.
	const xmlMatch = text.match(/^<pi_goal_continuation\s+goal_id=\"([^\"]+)\"/);
	if (xmlMatch) return xmlMatch[1] ?? null;
	const match = text.match(/^\[(?:GOAL CHECKPOINT|GOAL CONTINUATION|GOAL STALE) goalId=([^\]\s]+)\]/);
	return match?.[1] ?? null;
}

export function goalEventMessageId(message: { customType?: string; details?: unknown; content?: unknown }): string | null {
	if (message.customType !== GOAL_EVENT_ENTRY) return null;
	const details = asRecord(message.details);
	// Drafting messages never correspond to a real goal id; they must not be staleness-checked.
	if (details?.kind === "drafting") return null;
	const goalId = details && typeof details.goalId === "string" ? details.goalId : null;
	if (goalId) return goalId;
	return typeof message.content === "string" ? extractGoalIdFromInjectedMessage(message.content) : null;
}
