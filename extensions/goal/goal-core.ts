export interface GoalUsageLike {
	tokensUsed: number;
	activeSeconds: number;
	/** USD spent (fractional, never floored). Missing on pre-cost records → 0. */
	costUsed: number;
}

export interface GoalDisplayRecordLike {
	objective: string;
	status: "active" | "paused" | "complete";
	autoContinue: boolean;
	usage: GoalUsageLike;
	sisyphus: boolean;
	stopReason?: "user" | "agent";
}

export { isQuestionLikeToolName } from "./goal-tool-names.ts";


export function truncateText(value: string, max = 120): string {
	const oneLine = value.replace(/\s+/g, " ").trim();
	return oneLine.length > max ? `${oneLine.slice(0, max - 3)}...` : oneLine;
}

export function displayObjectiveTitle(objective: string): string {
	const lines = objective.replace(/\r/g, "").split("\n").map((line) => line.trim()).filter(Boolean);
	const sectionHeader = /^(success criteria|boundaries|constraints|steps|order rules|don'ts|if blocked|if blocked \/ unclear \/ failing|sisyphus reminder)\s*[:：]/i;
	for (const line of lines) {
		if (/^=+\s*(?:sisyphus\s+)?goal\s*=+$/i.test(line)) continue;
		const objectiveMatch = line.match(/^(?:objective|目标)\s*[:：]\s*(.+)$/i);
		if (objectiveMatch?.[1]) return objectiveMatch[1].trim();
		if (sectionHeader.test(line)) continue;
		return line;
	}
	return truncateText(objective);
}

/** USD rendering for goal usage: two decimals at $1 and above, THREE below
 * (flash-tier subagent rounds cost $0.023 — two decimals would read $0.02
 * and drift 9%). Tier is decided on the ROUNDED value so 0.9995 reads
 * $1.00 (not "$1.000") and 0.0004 reads $0 (not "$0.000"). */
export function formatCostValue(value: number): string {
	const safe = typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;
	const rounded = Math.round(safe * 1000) / 1000;
	if (rounded === 0) return "$0";
	return rounded >= 1 ? `$${rounded.toFixed(2)}` : `$${rounded.toFixed(3)}`;
}

export function formatTokenValue(value: number): string {
	const safe = Math.max(0, Math.floor(value));
	const compact =
		safe >= 1_000_000_000
			? `${(safe / 1_000_000_000).toFixed(safe >= 10_000_000_000 ? 0 : 1).replace(/\.0$/, "")}B`
			: safe >= 1_000_000
				? `${(safe / 1_000_000).toFixed(safe >= 10_000_000 ? 0 : 1).replace(/\.0$/, "")}M`
				: safe >= 10_000
					? `${(safe / 1_000).toFixed(0)}K`
					: safe >= 1_000
						? `${(safe / 1_000).toFixed(1).replace(/\.0$/, "")}K`
						: String(safe);
	const exact = safe.toLocaleString("en-US");
	if (compact === exact) return `${exact} tokens`;
	return `${compact} (${exact}) tokens`;
}

export function formatDuration(seconds: number): string {
	const total = Math.max(0, Math.floor(seconds));
	const hours = Math.floor(total / 3600);
	const minutes = Math.floor((total % 3600) / 60);
	const secs = total % 60;
	if (hours > 0) return `${hours}h${minutes.toString().padStart(2, "0")}m${secs.toString().padStart(2, "0")}s`;
	if (minutes > 0) return `${minutes}m${secs.toString().padStart(2, "0")}s`;
	return `${secs}s`;
}

/** Spoken-style duration for summary lines: "1 hour 2 minutes". */
export function formatDurationWords(seconds: number): string {
	const total = Math.max(0, Math.floor(seconds));
	const days = Math.floor(total / 86400);
	const hours = Math.floor((total % 86400) / 3600);
	const minutes = Math.floor((total % 3600) / 60);
	const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"}`;
	if (days > 0) return hours > 0 ? `${plural(days, "day")} ${plural(hours, "hour")}` : plural(days, "day");
	if (hours > 0) return minutes > 0 ? `${plural(hours, "hour")} ${plural(minutes, "minute")}` : plural(hours, "hour");
	if (minutes > 0) return plural(minutes, "minute");
	return "less than a minute";
}

export function statusLabel(goal: Pick<GoalDisplayRecordLike, "sisyphus" | "status" | "autoContinue" | "stopReason">): string {
	const prefix = goal.sisyphus ? "sisyphus " : "";
	if (goal.status === "active" && goal.autoContinue) return `${prefix}running`;
	if (goal.status === "paused" && goal.stopReason === "agent") return `${prefix}paused (agent)`;
	return `${prefix}${goal.status}`;
}

export function footerStatus(goal: GoalDisplayRecordLike): string {
	const usageBits: string[] = [];
	if (goal.usage.activeSeconds > 0) usageBits.push(formatDuration(goal.usage.activeSeconds));
	if (goal.usage.tokensUsed > 0) usageBits.push(formatTokenValue(goal.usage.tokensUsed).split(" ")[0]);
	if (goal.usage.costUsed > 0) usageBits.push(formatCostValue(goal.usage.costUsed));
	const usage = usageBits.length > 0 ? ` [${usageBits.join(" ")}]` : "";
	const prefix = goal.sisyphus ? "goal✊" : "goal";
	return `${prefix}: ${statusLabel(goal)}${usage} - ${truncateText(goal.objective, 60)}`;
}

/** goal-notes: pause reasons are prefixed "user: " when set via /goal-pause
 * (agent pause_goal reasons are unprefixed). One labeling authority for the
 * summary line and the paused system prompt. */
export function pauseReasonLabel(pauseReason: string): { label: string; text: string } {
	if (pauseReason.startsWith("user: ")) {
		return { label: "User pause note", text: pauseReason.slice("user: ".length) };
	}
	return { label: "Agent pause reason", text: pauseReason };
}

/** C6 (arch review 2026-10-03): moved from goal.ts — shared by the wiring's
 * uiNotify calls and renderers.ts. Structural type: any goal record shape
 * with status/objective/usage satisfies it. */
export function oneLineSummary(goal: GoalDisplayRecordLike | null): string {
	if (!goal) return "No goal is set.";
	const bits: string[] = [];
	if (goal.usage.tokensUsed > 0) bits.push(formatTokenValue(goal.usage.tokensUsed).split(" ")[0]);
	if (goal.usage.costUsed > 0) bits.push(formatCostValue(goal.usage.costUsed));
	const tail = bits.length > 0 ? ` [${bits.join(" ")}]` : "";
	return `${statusLabel(goal)}${tail} - ${truncateText(goal.objective)}`;
}
