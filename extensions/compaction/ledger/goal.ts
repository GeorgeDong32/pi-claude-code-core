/*
 * Ledger goal section (SPEC SC §5.6 LED-03, task W6).
 *
 * Reuses goal's own buildCompactionSummary — the ONE goal formatter (source
 * scan enforces no second implementation). This wrapper splits its output
 * into ledger-shaped parts: open goals (Tier A) feed "## Open work",
 * terminal goals feed "## Closed (one-line)"; each carries its id+status so
 * the LED-08 self-check can find them.
 */

import { buildCompactionSummary } from "../../goal/goal-compaction.ts";
import { statusLabel } from "../../goal/goal-core.ts";
import type { ClosedItem, GoalLedgerState, OpenIdentity } from "./types.ts";

export interface GoalSection {
	/** Tier A open-goal lines for "## Open work". */
	openLines: string[];
	/** Terminal one-liners for "## Closed". */
	closed: ClosedItem[];
	/** Self-check identities (id + status must appear in the block). */
	identities: OpenIdentity[];
	/** Closed ids for the narrative prompt (SUM-08). */
	closedIds: string[];
}

export function goalSection(state: GoalLedgerState): GoalSection {
	// The goal module's own summary text (focused + other open + terminal).
	const text = buildCompactionSummary({
		goalsById: state.goalsById,
		focusedGoalId: state.focusedGoalId,
		ledgerEvents: state.ledgerEvents,
	});
	const openLines: string[] = [];
	const closed: ClosedItem[] = [];
	const identities: OpenIdentity[] = [];
	const closedIds: string[] = [];

	for (const goal of state.goalsById.values()) {
		if (goal.status === "complete") {
			// Terminal: one closed line. ("aborted" terminals are reconstructed
			// from ledger EVENTS by the goal module's own summary below.)
			const label = objectiveOf(goal).slice(0, 60);
			closed.push({ id: goal.id, label, detail: "completed" });
			closedIds.push(goal.id);
			continue;
		}
		// Self-check status must match what the goal module RENDERS (its
		// statusLabel maps active+autoContinue → "running", etc.).
		identities.push({ source: "goal", id: goal.id, status: statusLabel(goal) });
	}

	// Open-work lines come from the goal module's rendering of OPEN goals —
	// keep its exact formatting (LED-03: no second formatter).
	const openBlock = extractSection(text, "FOCUSED GOAL");
	const otherOpen = extractSection(text, "OTHER OPEN GOALS");
	if (openBlock) openLines.push(...openBlock);
	if (otherOpen) openLines.push(...otherOpen);
	// Terminal goals: also keep the goal module's rendering for the closed
	// section when present (ids already collected above).
	const terminal = extractSection(text, "TERMINAL GOALS");
	if (terminal && closed.length > 0) {
		// Prefer the goal module's terminal lines as the closed one-liners.
		return { openLines, closed: closedFromTerminal(terminal, closed), identities, closedIds };
	}
	return { openLines, closed, identities, closedIds };
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
	// Goal objectives carry a "=== Goal ===\nObjective: X" prefix in this
	// repo's goal records — surface the human part.
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
