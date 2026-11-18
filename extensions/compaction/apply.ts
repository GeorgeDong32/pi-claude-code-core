/*
 * Smart Compaction — apply path (SPEC SC §5.7 APP-01…08, task W3).
 *
 * Pure decision core for the synchronous proposal path:
 *
 *   runPrechecks  V1–V10 (first failure wins; V10 = HOLD, not discard: the
 *                 snapshot stays ready for the next boundary)
 *   buildDraft    APP-01 entry shape with the reconciliation nonce
 *   reconcile     APP-08 — scan the branch for OUR nonce on a compaction
 *                 entry (INV-13: "returned a draft" ≠ "compaction
 *                 happened"; entry_appended is invisible to extensions, H3)
 *   auditConflictEdits  V4' — post-commit context_edit targeting the
 *                 compressed region; counted, never blocked (H15)
 *
 * All functions are synchronous and total: a proposal-path bug must return
 * "don't propose" (INV-1), never throw into pi.
 */

import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { DiscardReason } from "./types.ts";

export type PrecheckOutcome =
	| { action: "propose" }
	| { action: "discard"; reason: DiscardReason }
	| { action: "hold" };

export interface PrecheckInput {
	snapshotPathIds: string[];
	branchEntries: SessionEntry[];
	firstKeptEntryId: string;
	firstKeptStillLegal: boolean;
	compressedRegionIds: Set<string>;
	tnAtSnapshot: number;
	tnNow: number;
	summaryValidated: boolean;
	applySafe: boolean;
	estimatePostTokens: number;
	hardFitLimit: number;
	efficiencyLimit?: number;
	degraded: boolean;
	signalAborted: boolean;
	sameBoundaryEntries: Array<Record<string, unknown>>;
}

function idsOf(entries: SessionEntry[]): string[] {
	return entries.map((entry) => (entry as { id?: string }).id ?? "");
}

export function targetsCompressedRegion(
	entries: Array<Pick<SessionEntry, "type"> & Record<string, unknown>>,
	compressedRegionIds: Set<string>,
): boolean {
	for (const entry of entries) {
		if (entry.type !== "context_edit") continue;
		const targetId = entry.targetId;
		if (typeof targetId === "string" && compressedRegionIds.has(targetId)) return true;
	}
	return false;
}

export function runPrechecks(input: PrecheckInput): PrecheckOutcome {
	const currentIds = idsOf(input.branchEntries);

	const prefixOk =
		input.snapshotPathIds.length <= currentIds.length &&
		input.snapshotPathIds.every((id, i) => currentIds[i] === id);
	if (!prefixOk) return { action: "discard", reason: "v1-branch-prefix" };

	const appended = input.branchEntries.slice(input.snapshotPathIds.length);
	if (appended.some((entry) => (entry as { type?: string }).type === "compaction")) {
		return { action: "discard", reason: "v2-new-compaction" };
	}

	if (!currentIds.includes(input.firstKeptEntryId) || !input.firstKeptStillLegal) {
		return { action: "discard", reason: "v3-cut-invalid" };
	}

	if (targetsCompressedRegion(appended as never, input.compressedRegionIds)) {
		return { action: "discard", reason: "v4-conflict-edit" };
	}

	const drift = input.tnAtSnapshot > 0 ? Math.abs(input.tnNow - input.tnAtSnapshot) / input.tnAtSnapshot : 0;
	if (drift > 0.1) return { action: "discard", reason: "v5-window-shift" };

	if (!input.summaryValidated) return { action: "discard", reason: "v6-summary-invalid" };

	if (!input.applySafe) return { action: "discard", reason: "v7-unsafe-boundary" };

	if (input.estimatePostTokens > input.hardFitLimit) {
		return { action: "discard", reason: "v8a-hard-fit" };
	}

	if (input.efficiencyLimit !== undefined && input.estimatePostTokens > input.efficiencyLimit) {
		return { action: "discard", reason: "v8b-efficiency" };
	}

	if (input.degraded || input.signalAborted) return { action: "discard", reason: "v9-degraded" };

	for (const entry of input.sameBoundaryEntries) {
		if (entry.type === "compaction") return { action: "hold" };
	}
	if (targetsCompressedRegion(input.sameBoundaryEntries as never, input.compressedRegionIds)) {
		return { action: "hold" };
	}

	return { action: "propose" };
}


export interface DraftCcCore {
	v: 1;
	origin: "precompute";
	proposalId: string;
	cutClass: string;
	providers: string[];
}

export interface CompactionDraftEntry {
	type: "compaction";
	summary: string;
	firstKeptEntryId: string;
	details: {
		readFiles: string[];
		modifiedFiles: string[];
		ccCore: DraftCcCore;
	};
	usage?: unknown;
}

export function buildDraft(args: {
	summary: string;
	firstKeptEntryId: string;
	readFiles: string[];
	modifiedFiles: string[];
	proposalId: string;
	cutClass: string;
	providers: string[];
	usage?: unknown;
}): CompactionDraftEntry {
	return {
		type: "compaction",
		summary: args.summary,
		firstKeptEntryId: args.firstKeptEntryId,
		details: {
			readFiles: args.readFiles,
			modifiedFiles: args.modifiedFiles,
			ccCore: {
				v: 1,
				origin: "precompute",
				proposalId: args.proposalId,
				cutClass: args.cutClass,
				providers: args.providers,
			},
		},
		usage: args.usage,
	};
}

export function mergeDraftEntries(eventEntries: unknown[], draft: CompactionDraftEntry): { entries: unknown[] } {
	return { entries: [...eventEntries, draft] };
}


export interface ReconcileResult {
	status: "committed" | "lost";
	entryId?: string;
	conflictEdits?: number;
	lostReason?: "overridden" | "dropped" | "branch-changed";
}

function ccCoreProposalId(entry: SessionEntry): string | undefined {
	const details = (entry as { details?: { ccCore?: { proposalId?: unknown } } }).details;
	const id = details?.ccCore?.proposalId;
	return typeof id === "string" ? id : undefined;
}

export function reconcile(
	branchEntries: SessionEntry[],
	proposalId: string,
	scanMax: number,
	sessionTreeSinceProposal: boolean,
	compressedRegionIds: Set<string>,
): ReconcileResult {
	const limit = Math.max(0, Math.min(branchEntries.length, scanMax));
	for (let i = branchEntries.length - 1; i >= branchEntries.length - limit; i -= 1) {
		const entry = branchEntries[i];
		if ((entry as { type?: string }).type !== "compaction") continue;
		if (ccCoreProposalId(entry) !== proposalId) continue;
		let conflictEdits = 0;
		for (let j = i + 1; j < branchEntries.length; j += 1) {
			const later = branchEntries[j] as { type?: string; targetId?: unknown };
			if (later.type === "context_edit" && typeof later.targetId === "string" && compressedRegionIds.has(later.targetId)) {
				conflictEdits += 1;
			}
		}
		return {
			status: "committed",
			entryId: (entry as { id?: string }).id,
			conflictEdits,
		};
	}
	return {
		status: "lost",
		lostReason: sessionTreeSinceProposal ? "branch-changed" : "overridden",
	};
}
