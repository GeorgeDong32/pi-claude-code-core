/**
 * goal/renderers.ts — the goal message renderers (arch review C6, carved
 * from goal.ts wiring 2026-10-03; TR-batch module convention). Pure
 * presentation: no factory state, no pi runtime — tests import this module
 * directly instead of dragging the whole extension factory.
 *
 * Kept deliberately LOCAL (not lib/tool-render's resultText): goal result
 * rendering uses only the FIRST text item of the content array — resultText
 * joins all parts, which is a different contract.
 */
import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

import { formatDuration, formatTokenValue, oneLineSummary, truncateText } from "./goal-core.ts";
import { asRecord, type DraftingFocus, type GoalEventDetails, type GoalEventKind, type GoalRecord, type GoalStateEntry, type GoalStatus } from "./goal-record.ts";

/** Exported for tests (same pattern as renderGoalEvent/renderGoalAuditEvent). */
export function renderGoalResult(result: { details?: unknown; content: Array<{ type: string; text?: string }> }, theme: Theme): Text {
	const first = result.content.find((item) => item.type === "text" && typeof item.text === "string");
	const firstText = first?.text ?? "";
	const details = result.details as GoalStateEntry | undefined;
	if (!details || typeof details !== "object" || !("goal" in details)) {
		return new Text(firstText, 0, 0);
	}
	// B3: structured classification wins — a kind means "show the text as-is"
	// (info lines: created ack / audit rejection / completion / pause / abort).
	// Wording changes can no longer silently flip the render branch.
	if (details.kind !== undefined) {
		return new Text(firstText, 0, 0);
	}
	// Legacy fallback (deprecated, replay-only): entries persisted before the
	// kind field existed. Includes the orphaned "Goal confirmed and created."
	// prefix an older build once emitted — keep it so old sessions replay.
	if (
		firstText.startsWith("Goal audit ")
		|| firstText.startsWith("Goal completion rejected")
		|| firstText.startsWith("Goal complete.")
		|| firstText.startsWith("Goal paused.")
		|| firstText.startsWith("Goal aborted.")
		|| firstText.startsWith("Goal confirmed and created.")
	) {
		return new Text(firstText, 0, 0);
	}
	return new Text(theme.fg("accent", "Goal ") + theme.fg("muted", oneLineSummary(details.goal)), 0, 0);
}

function normalizeGoalEventDetails(value: unknown): GoalEventDetails {
	const raw = asRecord(value);
	const kind: GoalEventKind = raw?.kind === "stale" ? "stale" : raw?.kind === "drafting" ? "drafting" : "checkpoint";
	const goalId = typeof raw?.goalId === "string" ? raw.goalId : "unknown";
	const focus: DraftingFocus | undefined = raw?.focus === "sisyphus" ? "sisyphus" : raw?.focus === "goal" ? "goal" : undefined;
	const status = raw?.status === "active" || raw?.status === "paused" || raw?.status === "complete" ? (raw.status as GoalStatus) : undefined;
	const currentStatus =
		raw?.currentStatus === "active" || raw?.currentStatus === "paused" || raw?.currentStatus === "complete"
			? (raw.currentStatus as GoalStatus)
			: raw?.currentStatus === null
				? null
				: undefined;
	return {
		kind,
		goalId,
		status,
		objective: typeof raw?.objective === "string" ? raw.objective : undefined,
		timestamp: typeof raw?.timestamp === "number" ? raw.timestamp : undefined,
		currentGoalId: typeof raw?.currentGoalId === "string" || raw?.currentGoalId === null ? raw.currentGoalId : undefined,
		currentStatus,
		focus,
	};
}

export interface GoalAuditEventDetails {
	phase: "started" | "passed" | "approved" | "rejected";
	goalId: string;
	auditor?: string;
	/** Approved-only completion stats backing the compact summary line. */
	achievedAt?: number;
	activeSeconds?: number;
	tokensUsed?: number;
	/** Which audit attempt finally approved the goal (1 = first try). */
	auditAttempts?: number;
}

export function renderGoalEvent(message: { details?: GoalEventDetails }, options: { expanded: boolean }, theme: Theme): Text {
	const details = normalizeGoalEventDetails(message.details);
	const label =
		details.kind === "stale" ? "stale checkpoint"
			: details.kind === "drafting" ? (details.focus === "sisyphus" ? "sisyphus drafting" : "goal drafting")
				: "checkpoint";
	if (!options.expanded) {
		// Drafting with a topic: collapse the injected confirmation protocol to
		// the user's own words (the full prompt still goes to the model). Only
		// the beacon + noun carry the theme label color — the user's text
		// stays in the normal message color.
		if (details.kind === "drafting" && details.objective) {
			const noun = details.focus === "sisyphus" ? "Sisyphus" : "Goal";
			return new Text(theme.fg("customMessageLabel", `\uf4de  ${noun} `) + theme.fg("customMessageText", truncateText(details.objective, 72)), 0, 0);
		}
		// Other goal-authored rows are fully theme-colored.
		return new Text(theme.fg("customMessageLabel", `Goal ${label}`), 0, 0);
	}
	const lines = [`Status: ${details.status === "active" ? "running" : details.status ?? "unknown"}`];
	if (details.objective) lines.push(`Objective: ${details.objective}`);
	lines.push(`Goal id: ${details.goalId}`);
	if (details.currentGoalId || details.currentStatus) {
		lines.push(`Current: ${details.currentGoalId ?? "none"}${details.currentStatus ? ` (${details.currentStatus})` : ""}`);
	}
	return new Text(
		theme.fg("customMessageLabel", `Goal ${label}`) + "\n" + theme.fg("customMessageText", lines.join("\n")),
		0,
		0,
	);
}

export function renderGoalAuditEvent(message: { content?: unknown; details?: GoalAuditEventDetails }, options: { expanded: boolean }, theme: Theme): Text {
	const details = message.details;
	const phase = details?.phase ?? "started";
	if (!options.expanded) {
		// Compact, tool-call-like line in a single theme color; ctrl+o
		// expands to the full two-tone report.
		if (phase === "approved") {
			const at = typeof details?.achievedAt === "number" ? details.achievedAt : undefined;
			const seconds = typeof details?.activeSeconds === "number" ? details.activeSeconds : undefined;
			const tokens = typeof details?.tokensUsed === "number" ? details.tokensUsed : undefined;
			if (at !== undefined && seconds !== undefined && tokens !== undefined) {
				const hhmm = new Date(at).toTimeString().slice(0, 5);
				// "Goal achieved at 14:32 (23s · 1 attempt · 566 tokens)" —
				// attempts omitted for legacy entries without the count.
				const stats = [formatDuration(seconds)];
				if (typeof details?.auditAttempts === "number") stats.push(`${details.auditAttempts} attempt${details.auditAttempts === 1 ? "" : "s"}`);
				stats.push(`${formatTokenValue(tokens).split(" ")[0]} tokens`);
				return new Text(
					theme.fg("customMessageLabel", `\uf4de  Goal achieved at ${hhmm} (${stats.join(" · ")})`),
					0,
					0,
				);
			}
			return new Text(theme.fg("customMessageLabel", "Goal Audit approved"), 0, 0);
		}
		if (phase === "passed") return new Text(theme.fg("customMessageLabel", "\uf41d  Goal Audit pass"), 0, 0);
		if (phase === "rejected") return new Text(theme.fg("customMessageLabel", "\uf4e7  Goal Audit failed — expand (ctrl+o) for the report"), 0, 0);
		return new Text(theme.fg("customMessageLabel", "\uf4af  Goal Audit start ..."), 0, 0);
	}
	const label = phase === "approved" || phase === "passed" ? "passed" : phase === "rejected" ? "rejected" : "started";
	const content = typeof message.content === "string" ? message.content : `Goal audit ${label}.`;
	return new Text(
		theme.fg("customMessageLabel", `Goal audit ${label}`) + "\n" + theme.fg("customMessageText", content),
		0,
		0,
	);
}
