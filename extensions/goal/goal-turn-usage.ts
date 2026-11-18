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

function usageCostTotal(usage: Record<string, unknown>): number {
	const cost = asRecord(usage.cost);
	const total = cost ? cost.total : undefined;
	if (typeof total !== "number" || !Number.isFinite(total)) return 0;
	return Math.max(0, total);
}

export function assistantTurnCost(message: unknown): number {
	const raw = asRecord(message);
	if (!raw || raw.role !== "assistant") return 0;
	const usage = asRecord(raw.usage);
	if (!usage) return 0;
	return usageCostTotal(usage);
}

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
