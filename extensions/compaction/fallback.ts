
import { validateAssembled } from "./validate.ts";
import type { CompactionSettings } from "./settings.ts";
import type { PrecomputedSnapshot } from "./types.ts";

export type FallbackAction =
	| { action: "supply-snapshot" }
	| { action: "wait-for-ready" }
	| { action: "regenerate" }
	| { action: "native" };

export interface FallbackDecisionInput {
	reason: "manual" | "threshold" | "overflow";
	hasCustomInstructions: boolean;
	hasComputingSnapshot: boolean;
	hasReadySnapshot: boolean;
	snapshotGatesPassed: boolean;
	snapshotHardFitPassed: boolean;
}

export function decideFallback(input: FallbackDecisionInput): FallbackAction {
	if (input.hasCustomInstructions) return { action: "native" };
	if (input.hasReadySnapshot && input.snapshotGatesPassed) {
		if (input.snapshotHardFitPassed) return { action: "supply-snapshot" };
	}
	if (input.reason === "manual") {
		return input.hasReadySnapshot && input.snapshotGatesPassed && input.snapshotHardFitPassed
			? { action: "supply-snapshot" }
			: { action: "native" };
	}
	if (input.hasComputingSnapshot) return { action: "wait-for-ready" };
	return { action: "regenerate" };
}

export function hardFitLimitFor(reason: "manual" | "threshold" | "overflow", settings: CompactionSettings, tn: number): number {
	const ratio = reason === "overflow" ? settings.overflowFitRatio : settings.hardFitRatio;
	return ratio * tn;
}

export interface SupplyCompaction {
	compaction: {
		summary: string;
		firstKeptEntryId: string;
		tokensBefore: number;
		details: {
			readFiles: string[];
			modifiedFiles: string[];
			ccCore: { v: 1; origin: "native-backfill"; proposalId: string };
		};
		usage?: unknown;
	};
}

export function buildSupplyCompaction(args: {
	snapshot: PrecomputedSnapshot;
	summary: string;
	tokensBefore: number;
	readFiles: string[];
	modifiedFiles: string[];
	proposalId: string;
	usage?: unknown;
}): SupplyCompaction {
	return {
		compaction: {
			summary: args.summary,
			firstKeptEntryId: args.snapshot.cut.firstKeptEntryId,
			tokensBefore: args.tokensBefore,
			details: {
				readFiles: args.readFiles,
				modifiedFiles: args.modifiedFiles,
				ccCore: { v: 1, origin: "native-backfill", proposalId: args.proposalId },
			},
			...(args.usage !== undefined ? { usage: args.usage } : {}),
		},
	};
}

export function auditNativeSummary(summary: string, thresholds: {
	minNarrativeChars: number;
	minPrefixChars: number;
	maxSummaryChars: number;
}): { valid: boolean; failures: string[] } {
	const verdict = validateAssembled(
		{ summary, isSplitTurn: false, hasHistory: true, subCalls: [{ kind: "history", stopReason: "stop", narrativeText: summary, hasToolCall: false }] },
		{ ...thresholds, minNarrativeChars: thresholds.minNarrativeChars, maxSummaryChars: thresholds.maxSummaryChars },
	);
	const relevant = verdict.failures.filter((f) => f.startsWith("assembled:"));
	return { valid: relevant.length === 0, failures: relevant };
}
