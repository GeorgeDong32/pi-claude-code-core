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
	/** RB1 (2026-11-10 review rework): other-open goals the renderer hid
	 * behind its cap ("... and N more") — ⑥'s overflow accounting input. */
	hiddenOpenCount: number;
	/** Terminal one-liners for "## Closed". */
	closed: ClosedItem[];
	/** Self-check identities (id + status must appear in the block). */
	identities: OpenIdentity[];
	/** Closed ids for the narrative prompt (SUM-08). */
	closedIds: string[];
}

export function goalSection(state: GoalLedgerState, opts?: { capOpenGoals?: number }): GoalSection {
	// The goal module's own summary text (focused + other open + terminal).
	// RB1 (2026-11-10 review rework): capOpenGoals is passed THROUGH to the
	// single formatter (LED-03) so ⑥ controls the cap instead of peeking.
	// F2 (2026-11-10 review final): fallback for OTHER callers only —
	// assemble's ⑥ always passes an explicit cap (goal-compaction.ts:81).
	const capOpenGoals = opts?.capOpenGoals ?? 20; // mirrors goal-compaction.ts:81
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

	// RB1 (2026-11-10 review rework): identities are EXACTLY the open goals
	// the renderer shows — focused (if open) plus the first capOpenGoals
	// others, mirroring goal-compaction.ts:84-103. Hidden goals surface via
	// hiddenOpenCount for ⑥'s single-budget accounting; nothing silently
	// drops out of the self-check promise set while under maxOpenItems.
	const openGoals = Array.from(state.goalsById.values()).filter((g) => g.status !== "complete");
	const otherOpenGoals = openGoals.filter((g) => g.id !== state.focusedGoalId);
	// D7.5 (2026-11-10 review D): a focused id that is NOT in goalsById is
	// not open (the formatter renders no FOCUSED block for it either).
	const focusedGoal = state.focusedGoalId !== null ? state.goalsById.get(state.focusedGoalId) : undefined;
	const focusedIsOpen = focusedGoal !== undefined && focusedGoal.status !== "complete";
	const renderedGoalIds = new Set<string>([
		...(focusedIsOpen && state.focusedGoalId ? [state.focusedGoalId] : []),
		...otherOpenGoals.slice(0, capOpenGoals).map((g) => g.id),
	]);
	const hiddenOpenCount = Math.max(0, otherOpenGoals.length - capOpenGoals);

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
		// statusLabel maps active+autoContinue → "running", etc.). RB1: only
		// RENDERED open goals are promised (focused-if-open + capped others).
		if (renderedGoalIds.has(goal.id)) identities.push({ source: "goal", id: goal.id, status: statusLabel(goal) });
	}

	// Open-work lines come from the goal module's rendering of OPEN goals —
	// keep its exact formatting (LED-03: no second formatter).
	const openBlock = extractSection(text, "FOCUSED GOAL");
	const otherOpen = extractSection(text, "OTHER OPEN GOALS");
	if (openBlock) openLines.push(...openBlock);
	// D7.4 (2026-11-10 review D): drop the formatter's own "... and N more"
	// line — hidden goals are reported ONCE by assemble's ⑥ pointer
	// (hiddenOpenCount), never twice with conflicting counts.
	if (otherOpen) openLines.push(...otherOpen.filter((line) => !/^\.\.\. and \d+ more$/.test(line.trim())));
	// Terminal goals: also keep the goal module's rendering for the closed
	// section when present (ids already collected above).
	const terminal = extractSection(text, "TERMINAL GOALS");
	if (terminal && closed.length > 0) {
		// Prefer the goal module's terminal lines as the closed one-liners.
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
