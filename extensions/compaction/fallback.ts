/*
 * Smart Compaction — native fallback leg (SPEC SC §5.8 FB-01…08, task W4).
 *
 * The `session_before_compact` supply leg. The controller NEVER cancels
 * (FB-06), never writes pi's compaction settings, and never supplies a
 * result that fails the hard capacity gate V8a — the overflow reason uses
 * the stricter overflowFitRatio (H13: exactly one recovery chance, better to
 * hand back to native than supply something that might not fit).
 *
 * Pure decision helpers live here (unit-tested with a fake clock); the
 * wait/deadline orchestration (single Promise.race, ONE deadline timer — the
 * INV-2 exception) lives in index.ts.
 */

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
	/** /compact <instructions> → always native (D6). */
	hasCustomInstructions: boolean;
	hasComputingSnapshot: boolean;
	hasReadySnapshot: boolean;
	/** V1–V6 + V9 verdict for the ready snapshot (V7/V8b n/a on this path). */
	snapshotGatesPassed: boolean;
	/** V8a verdict for the ready snapshot under this reason's ratio. */
	snapshotHardFitPassed: boolean;
}

/** §5.8 table as a pure function. */
export function decideFallback(input: FallbackDecisionInput): FallbackAction {
	if (input.hasCustomInstructions) return { action: "native" };
	if (input.hasReadySnapshot && input.snapshotGatesPassed) {
		if (input.snapshotHardFitPassed) return { action: "supply-snapshot" };
		// Oversized/stale snapshot: do NOT supply it; fall through to
		// regenerate-or-native (BLK-3).
	}
	if (input.reason === "manual") {
		// No synchronous generation for manual compaction (D6).
		return input.hasReadySnapshot && input.snapshotGatesPassed && input.snapshotHardFitPassed
			? { action: "supply-snapshot" }
			: { action: "native" };
	}
	if (input.hasComputingSnapshot) return { action: "wait-for-ready" };
	return { action: "regenerate" };
}

/** The V8a limit for a reason (INV-12: overflow is stricter). */
export function hardFitLimitFor(reason: "manual" | "threshold" | "overflow", settings: CompactionSettings, tn: number): number {
	const ratio = reason === "overflow" ? settings.overflowFitRatio : settings.hardFitRatio;
	return ratio * tn;
}

/** FB-04: the {compaction} supply shape pi adopts verbatim (H6/H13). */
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

/**
 * FB-08: audit a NATIVE summary (fromExtension falsy) with SUM-04's
 * assembled layer ⑤–⑦. The result is only ever telemetry + one notify —
 * the native entry is never rewritten (H10).
 */
export function auditNativeSummary(summary: string, thresholds: {
	minNarrativeChars: number;
	minPrefixChars: number;
	maxSummaryChars: number;
}): { valid: boolean; failures: string[] } {
	const verdict = validateAssembled(
		{ summary, isSplitTurn: false, hasHistory: true, subCalls: [{ kind: "history", stopReason: "stop", narrativeText: summary, hasToolCall: false }] },
		{ ...thresholds, minNarrativeChars: thresholds.minNarrativeChars, maxSummaryChars: thresholds.maxSummaryChars },
	);
	// ⑧/⑨ don't apply to a native whole summary; ⑤–⑦ do.
	const relevant = verdict.failures.filter((f) => f.startsWith("assembled:"));
	return { valid: relevant.length === 0, failures: relevant };
}
