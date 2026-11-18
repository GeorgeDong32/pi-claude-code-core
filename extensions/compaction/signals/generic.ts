
import type { ProjectedEntry } from "../types.ts";

export interface SignalContext {
	entries: ProjectedEntry[];
	index: number;
	idleGapMs: number;
}

export interface BoundarySignal {
	name: string;
	weight: (ctx: SignalContext) => number;
}

export function safeSignalWeight(signal: BoundarySignal, ctx: SignalContext): number {
	try {
		const value = signal.weight(ctx);
		return Number.isFinite(value) && value > 0 ? value : 0;
	} catch {
		return 0;
	}
}

function firstRole(entry: ProjectedEntry): string | undefined {
	return entry.messages.length > 0 ? entry.messages[0].role : undefined;
}

function entryRole(entry: ProjectedEntry): string | undefined {
	for (const message of entry.messages) {
		if (message.role !== "toolResult") return message.role;
	}
	return undefined;
}

export const userSignal: BoundarySignal = {
	name: "user",
	weight: (ctx) => (entryRole(ctx.entries[ctx.index]) === "user" ? 1 : 0),
};

export const plainTurnSignal: BoundarySignal = {
	name: "plain-turn",
	weight: (ctx) => {
		const entry = ctx.entries[ctx.index];
		if (firstRole(entry) !== "assistant") return 0;
		const hasToolCall = entry.messages.some((message) =>
			Array.isArray((message as { content?: unknown }).content)
				? ((message as { content: Array<{ type?: string }> }).content).some(
						(block) => block.type === "toolCall",
					)
				: false,
		);
		return hasToolCall ? 0 : 1;
	},
};

export const toolTurnSignal: BoundarySignal = {
	name: "tool-turn",
	weight: (ctx) => {
		const entry = ctx.entries[ctx.index];
		if (firstRole(entry) !== "assistant") return 0;
		return entry.messages.some((message) =>
			Array.isArray((message as { content?: unknown }).content)
				? ((message as { content: Array<{ type?: string }> }).content).some(
						(block) => block.type === "toolCall",
					)
				: false,
		)
			? 1
			: 0;
	},
};

export const idleGapSignal: BoundarySignal = {
	name: "idle-gap",
	weight: (ctx) => {
		const current = ctx.entries[ctx.index];
		const next = ctx.entries[ctx.index + 1];
		if (!next) return 0;
		const a = Date.parse(current.sourceEntry.timestamp);
		const b = Date.parse(next.sourceEntry.timestamp);
		if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return 0;
		return b - a >= ctx.idleGapMs ? 1 : 0;
	},
};

export const GENERIC_SIGNALS: readonly BoundarySignal[] = [
	userSignal,
	plainTurnSignal,
	toolTurnSignal,
	idleGapSignal,
];

export function bestBoundarySignal(
	signals: readonly BoundarySignal[],
	ctx: SignalContext,
	weights: Readonly<Record<string, number>>,
): { name: string; weight: number } {
	let best = { name: "none", weight: 0 };
	for (const signal of signals) {
		const fires = safeSignalWeight(signal, ctx);
		if (!fires) continue;
		const weight = weights[signal.name] ?? 0;
		if (weight > best.weight) best = { name: signal.name, weight };
	}
	return best;
}
