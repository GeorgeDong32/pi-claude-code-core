
import { buildCompactionSummary } from "../../goal/goal-compaction.ts";
import { statusLabel } from "../../goal/goal-core.ts";
import type { ClosedItem, GoalLedgerState, OpenIdentity } from "./types.ts";

export interface GoalSection {
	openLines: string[];
	hiddenOpenCount: number;
	closed: ClosedItem[];
	identities: OpenIdentity[];
	closedIds: string[];
}

export function goalSection(state: GoalLedgerState, opts?: { capOpenGoals?: number }): GoalSection {
	const capOpenGoals = opts?.capOpenGoals ?? 20;
	const text = buildCompactionSummary({
		goalsById: state.goalsById,
		focusedGoalId: state.focusedGoalId,
		ledgerEvents: state.ledgerEvents,
		capOpenGoals,
	});
	const openLines: string[] = [];
	const closed: ClosedItem[] = [];
	const identities: OpenIdentity[] = [];
	const closedIds: string[] = [];

	const openGoals = Array.from(state.goalsById.values()).filter((g) => g.status !== "complete");
	const otherOpenGoals = openGoals.filter((g) => g.id !== state.focusedGoalId);
	const focusedGoal = state.focusedGoalId !== null ? state.goalsById.get(state.focusedGoalId) : undefined;
	const focusedIsOpen = focusedGoal !== undefined && focusedGoal.status !== "complete";
	const renderedGoalIds = new Set<string>([
		...(focusedIsOpen && state.focusedGoalId ? [state.focusedGoalId] : []),
		...otherOpenGoals.slice(0, capOpenGoals).map((g) => g.id),
	]);
	const hiddenOpenCount = Math.max(0, otherOpenGoals.length - capOpenGoals);

	for (const goal of state.goalsById.values()) {
		if (goal.status === "complete") {
			const label = objectiveOf(goal).slice(0, 60);
			closed.push({ id: goal.id, label, detail: "completed" });
			closedIds.push(goal.id);
			continue;
		}
		if (renderedGoalIds.has(goal.id)) identities.push({ source: "goal", id: goal.id, status: statusLabel(goal) });
	}

	const openBlock = extractSection(text, "FOCUSED GOAL");
	const otherOpen = extractSection(text, "OTHER OPEN GOALS");
	if (openBlock) openLines.push(...openBlock);
	if (otherOpen) openLines.push(...otherOpen.filter((line) => !/^\.\.\. and \d+ more$/.test(line.trim())));
	const terminal = extractSection(text, "TERMINAL GOALS");
	if (terminal && closed.length > 0) {
		return { openLines, closed: closedFromTerminal(terminal, closed), identities, closedIds, hiddenOpenCount };
	}
	return { openLines, closed, identities, closedIds, hiddenOpenCount };
}

function closedFromTerminal(terminalLines: string[], fallback: ClosedItem[]): ClosedItem[] {
	const items: ClosedItem[] = [];
	for (const line of terminalLines) {
		const match = /^-\s+(\S+)\s+—/.exec(line.trim());
		if (match) items.push({ id: match[1], label: line.trim().slice(2, 62) });
	}
	return items.length > 0 ? items : fallback;
}

function objectiveOf(goal: { objective: string }): string {
	const line = goal.objective.split("\n").find((l) => l.startsWith("Objective:"));
	return (line ? line.slice("Objective:".length) : goal.objective).trim();
}

function extractSection(text: string, marker: string): string[] | undefined {
	const start = text.indexOf(`[${marker}`);
	if (start === -1) return undefined;
	const rest = text.slice(start);
	const next = rest.indexOf("\n[", 1);
	const section = (next === -1 ? rest : rest.slice(0, next)).trim();
	return section.length > 0 ? section.split("\n") : undefined;
}
