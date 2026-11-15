/**
 * goal-turn-usage.ts — message classification + four-channel token/cost
 * extraction for goal accounting (SPEC SR E13a: split from goal.ts; pure
 * module — no pi access, no closure state).
 *
 * Spec IDs: DEVIATIONS #69 (cache-inclusive accounting), BH-R1 (stop-reason
 * probe), goal-cost spec 2026-10-04 (execution-reported usage).
 *
 * Design decisions:
 * - ALL FOUR usage channels count (input/output/cacheRead/cacheWrite) —
 *   with prompt caching the non-cached input alone reads ~10× under the
 *   provider-reported total.
 * - usageChannelTokens / usageCostTotal stay private; callers consume the
 *   message/event-level helpers only.
 */
import { asRecord } from "./goal-record.ts";

export function isAbortedAssistantMessage(message: unknown): boolean {
	const raw = asRecord(message);
	return raw?.role === "assistant" && raw.stopReason === "aborted";
}

export function isToolUseAssistantMessage(message: unknown): boolean {
	const raw = asRecord(message);
	return raw?.role === "assistant" && raw.stopReason === "toolUse";
}

export function hasAbortedAssistantMessage(messages: unknown[]): boolean {
	return messages.some(isAbortedAssistantMessage);
}

/** BH-R1: the last assistant message of a run — its stopReason decides whether
 * the continuation decision point saw a provider error. */
export function lastAssistantStopReason(messages: unknown[]): { stopReason?: string; errorMessage?: string } {
	for (let i = messages.length - 1; i >= 0; i--) {
		const raw = asRecord(messages[i]);
		if (raw?.role !== "assistant") continue;
		return {
			stopReason: typeof raw.stopReason === "string" ? raw.stopReason : undefined,
			errorMessage: typeof raw.errorMessage === "string" ? raw.errorMessage : undefined,
		};
	}
	return {};
}

function usageChannelTokens(value: unknown): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return 0;
	return Math.max(0, Math.trunc(value));
}

/**
 * Sum ALL FOUR usage channels of the message's single API request.
 * Cache-inclusive accounting (DEVIATIONS #69, 2026-10-01): with prompt
 * caching the non-cached `input` is a tiny fraction of real processing, so
 * `cacheRead`/`cacheWrite` must count too — otherwise tokensUsed reads as
 * ~10× under the provider-reported total.
 */
export function assistantTurnTokens(message: unknown): number {
	const raw = asRecord(message);
	if (!raw || raw.role !== "assistant") return 0;
	const usage = asRecord(raw.usage);
	if (!usage) return 0;
	return (
		usageChannelTokens(usage.input) +
		usageChannelTokens(usage.output) +
		usageChannelTokens(usage.cacheRead) +
		usageChannelTokens(usage.cacheWrite)
	);
}

/** Provider-reported USD cost of a usage object (usage.cost.total).
 * Missing cost objects read as 0 — tokens still count. */
function usageCostTotal(usage: Record<string, unknown>): number {
	const cost = asRecord(usage.cost);
	const total = cost ? cost.total : undefined;
	if (typeof total !== "number" || !Number.isFinite(total)) return 0;
	return Math.max(0, total);
}

/** USD cost of an assistant message's single API request. */
export function assistantTurnCost(message: unknown): number {
	const raw = asRecord(message);
	if (!raw || raw.role !== "assistant") return 0;
	const usage = asRecord(raw.usage);
	if (!usage) return 0;
	return usageCostTotal(usage);
}

/** Four-channel token sum + cost of a tool_result event's reported usage
 * ("usage from the tool execution itself": subagent runs, codemode
 * models.classify/generateImages, future LLM-backed tools). Tools that
 * report no usage contribute nothing. */
export function toolExecutionUsage(event: unknown): { tokens: number; cost: number } | null {
	const raw = asRecord(event);
	if (!raw) return null;
	const usage = asRecord(raw.usage);
	if (!usage) return null;
	const tokens =
		usageChannelTokens(usage.input) +
		usageChannelTokens(usage.output) +
		usageChannelTokens(usage.cacheRead) +
		usageChannelTokens(usage.cacheWrite);
	const cost = usageCostTotal(usage);
	if (tokens === 0 && cost === 0) return null;
	return { tokens, cost };
}
