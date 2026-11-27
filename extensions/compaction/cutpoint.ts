import {
	estimateTokens,
	findCutPoint,
	findTurnStartIndex,
	type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { bestBoundarySignal, GENERIC_SIGNALS, type BoundarySignal, type SignalContext } from "./signals/generic.ts";
import type { Feasibility } from "./policy.ts";
import type { BoundaryClass, CutpointResult, CutSelection, ProjectedEntry } from "./types.ts";

export interface CutpointParams {
	keepRecentTokens: number;
	keepSlackTokens: number;
	feasibility: Feasibility;
	weights: Readonly<Record<string, number>>;
	lambda: number;
	idleGapMs: number;
	signals?: readonly BoundarySignal[];
}

const CUT_POINT_ROLES = new Set([
	"user",
	"assistant",
	"bashExecution",
	"custom",
	"branchSummary",
	"compactionSummary",
]);

function isLegalCut(entries: ProjectedEntry[], i: number): boolean {
	const entry = entries[i];
	if (entry.sourceEntry.type === "compaction") return false;
	return entry.messages.some((message) => CUT_POINT_ROLES.has(message.role));
}

export function suffixTokenSums(entries: ProjectedEntry[]): number[] {
	const suffix: number[] = new Array(entries.length + 1).fill(0);
	for (let i = entries.length - 1; i >= 0; i--) {
		let tokens = 0;
		for (const message of entries[i].messages) tokens += estimateTokens(message as never);
		suffix[i] = suffix[i + 1] + tokens;
	}
	return suffix;
}

function classOfSignal(name: string): BoundaryClass {
	switch (name) {
		case "run-closed":
		case "goal-step":
		case "user":
		case "git-commit":
		case "verified":
		case "idle-gap":
		case "plain-turn":
		case "tool-turn":
			return name;
		default:
			return "plain-turn";
	}
}

export function selectCut(entries: ProjectedEntry[], params: CutpointParams): CutpointResult {
	const n = entries.length;
	if (n === 0) return { status: "infeasible", reason: "empty projection" };

	const { keepRecentTokens: keep, feasibility } = params;
	const tailMax = feasibility.tailMax;
	if (tailMax < keep) {
		return {
			status: "infeasible",
			reason: `tailMax ${Math.round(tailMax)} < keep ${keep}`,
			neededTn: Number.isFinite(feasibility.neededTn) ? Math.ceil(feasibility.neededTn) : undefined,
		};
	}
	const cap = Math.min(keep + params.keepSlackTokens, tailMax);

	const suffix = suffixTokenSums(entries);
	const sourceEntries: SessionEntry[] = entries.map((entry) => entry.sourceEntry);

	const native = findCutPoint(sourceEntries, 0, n, keep);
	const nativeTail = suffix[native.firstKeptEntryIndex] ?? suffix[0];
	const lower = keep;

	const signals = [...GENERIC_SIGNALS, ...(params.signals ?? [])];

	let best: { index: number; score: number; tail: number; distance: number; className: BoundaryClass } | undefined;
	for (let i = 0; i < n; i++) {
		if (!isLegalCut(entries, i)) continue;
		const tail = suffix[i];
		if (tail < lower || tail > cap) continue;
		const ctx: SignalContext = { entries, index: i - 1, idleGapMs: params.idleGapMs };
		const fired = i > 0 ? bestBoundarySignal(signals, ctx, params.weights) : { name: "none", weight: 0 };
		const distance = Math.abs(tail - nativeTail);
		const slack = params.keepSlackTokens > 0 ? params.keepSlackTokens : 1;
		const score = fired.weight - params.lambda * (distance / slack);
		if (
			best === undefined ||
			score > best.score ||
			(score === best.score && (distance < best.distance || (distance === best.distance && i < best.index)))
		) {
			best = { index: i, score, tail, distance, className: classOfSignal(fired.name) };
		}
	}

	if (best === undefined) {
		const index = Math.max(0, Math.min(native.firstKeptEntryIndex, n - 1));
		const cut = describeCut(entries, index, suffix, "native-equivalent", 0);
		return { status: "native-equivalent", cut };
	}

	const cut = describeCut(entries, best.index, suffix, best.className, best.score);
	return { status: "ok", cut };
}

function describeCut(
	entries: ProjectedEntry[],
	index: number,
	suffix: number[],
	className: BoundaryClass,
	score: number,
): CutSelection {
	const sourceEntries: SessionEntry[] = entries.map((entry) => entry.sourceEntry);
	const turnStartIndex = findTurnStartIndex(sourceEntries, index, 0);
	const startsTurn = turnStartIndex === index;
	const isSplitTurn = !startsTurn && turnStartIndex !== -1;
	return {
		firstKeptEntryId: entries[index].sourceEntry.id,
		firstKeptEntryIndex: index,
		isSplitTurn,
		turnStartIndex: isSplitTurn ? turnStartIndex : -1,
		tailTokens: suffix[index],
		boundaryClass: className,
		score,
	};
}

export function estimateMessageTokens(messages: AgentMessage[]): number {
	let sum = 0;
	for (const message of messages) sum += estimateTokens(message as never);
	return sum;
}
