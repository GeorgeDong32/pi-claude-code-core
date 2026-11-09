/*
 * Smart Compaction — generic boundary signals (SPEC SC §5.4/§5.1, task W1).
 *
 * A signal fires on "boundary AFTER entries[index]" and returns its weight,
 * or 0. The contract (CUT-07): every signal is a pure function over the
 * injected view, registered through one interface; a throwing signal counts
 * as 0 and never affects the others (safeSignalWeight). long-task.ts (W8)
 * and rex-flow.ts (W7) plug into the same shape.
 *
 * Roles follow the host's own projection vocabulary (user / assistant /
 * toolResult / bashExecution / custom / branchSummary / compactionSummary —
 * session-manager.js isCutPointMessage), so "user" here means exactly what
 * the host would let us cut at, never a tool result wearing a user hat.
 */

import type { ProjectedEntry } from "../types.ts";

/** Read-only view a signal may inspect (index = the boundary entry). */
export interface SignalContext {
	entries: ProjectedEntry[];
	/** The entry the boundary sits AFTER (its messages end the block). */
	index: number;
	/** Timestamps of the neighbor entries (idle-gap needs the next one). */
	idleGapMs: number;
}

export interface BoundarySignal {
	name: string;
	/** Weight when the boundary fires after entries[index]; 0 otherwise. */
	weight: (ctx: SignalContext) => number;
}

/** CUT-07: a throwing signal is worth 0 — isolation, not propagation. */
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
	// An entry projects to 0..n messages; the first non-toolResult role is the
	// entry's conversational role (tool results always trail their call).
	for (const message of entry.messages) {
		if (message.role !== "toolResult") return message.role;
	}
	return undefined;
}

/** user: a human user message entry ends a block (weight 80 default). */
export const userSignal: BoundarySignal = {
	name: "user",
	weight: (ctx) => (entryRole(ctx.entries[ctx.index]) === "user" ? 1 : 0),
};

/**
 * plain-turn: assistant message without tool calls completes a turn — a
 * natural boundary (weight 30 default).
 */
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

/** tool-turn: assistant message WITH tool calls — weakest boundary (10). */
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

/**
 * idle-gap: the NEXT entry arrives ≥ idleGapMs after this one — the user was
 * away; resuming afterwards starts a fresh block (weight 50 default).
 */
export const idleGapSignal: BoundarySignal = {
	name: "idle-gap",
	weight: (ctx) => {
		const current = ctx.entries[ctx.index];
		const next = ctx.entries[ctx.index + 1];
		if (!next) return 0; // trailing boundary: no gap to measure
		const a = Date.parse(current.sourceEntry.timestamp);
		const b = Date.parse(next.sourceEntry.timestamp);
		if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return 0;
		return b - a >= ctx.idleGapMs ? 1 : 0;
	},
};

/**
 * Generic registry, ORDERED by §5.4 class precedence for readability — the
 * cutpoint scorer takes the max weight across signals, order is cosmetic.
 * Weights themselves come from settings (SignalWeights), NOT hardcoded here:
 * these signals return 0/1 and the scorer maps name → weight.
 */
export const GENERIC_SIGNALS: readonly BoundarySignal[] = [
	userSignal,
	plainTurnSignal,
	toolTurnSignal,
	idleGapSignal,
];

/**
 * Evaluate every signal at a boundary and return the best (name, weight)
 * using the caller's weight table. A name missing from the table scores 0
 * (forward-compat: W7/W8 register new names before settings know them).
 */
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
