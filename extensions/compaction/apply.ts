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
	| { action: "hold" }; // V10: same-boundary conflict — snapshot stays ready

export interface PrecheckInput {
	/** Branch entry-id path at snapshot time (oldest → newest). */
	snapshotPathIds: string[];
	/** Current branch entries (oldest → newest, leaf last). */
	branchEntries: SessionEntry[];
	/** Snapshot's firstKeptEntryId — must still be on the branch and legal. */
	firstKeptEntryId: string;
	/** Cutpoint legality re-run result for firstKeptEntryId (V3). */
	firstKeptStillLegal: boolean;
	/** Ids of the compressed region (everything before the cut). */
	compressedRegionIds: Set<string>;
	/** T_n at snapshot vs now (V5, ±10%). */
	tnAtSnapshot: number;
	tnNow: number;
	/** SUM-04 verdict of the snapshot summary (V6). */
	summaryValidated: boolean;
	/** POL-07 predicate result at this apply point (V7). */
	applySafe: boolean;
	/** estimatePost of (final summary + current tail) vs limits (V8a/V8b). */
	estimatePostTokens: number;
	hardFitLimit: number;
	/** Draft path only; undefined on the fallback leg (V8b n/a there). */
	efficiencyLimit?: number;
	/** Session degraded / signal aborted (V9). */
	degraded: boolean;
	signalAborted: boolean;
	/** Same-boundary entries proposed by earlier handlers (V10). */
	sameBoundaryEntries: Array<Record<string, unknown>>;
}

function idsOf(entries: SessionEntry[]): string[] {
	return entries.map((entry) => (entry as { id?: string }).id ?? "");
}

/** V4 helper: any context_edit (draft or committed) aimed at the compressed region. */
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

/** V1–V10, in order. */
export function runPrechecks(input: PrecheckInput): PrecheckOutcome {
	const currentIds = idsOf(input.branchEntries);

	// V1 — snapshot path must still be a prefix of the current branch.
	const prefixOk =
		input.snapshotPathIds.length <= currentIds.length &&
		input.snapshotPathIds.every((id, i) => currentIds[i] === id);
	if (!prefixOk) return { action: "discard", reason: "v1-branch-prefix" };

	// V2 — no new compaction appended after the snapshot.
	const appended = input.branchEntries.slice(input.snapshotPathIds.length);
	if (appended.some((entry) => (entry as { type?: string }).type === "compaction")) {
		return { action: "discard", reason: "v2-new-compaction" };
	}

	// V3 — firstKeptEntryId still on the branch and still a legal cut point.
	if (!currentIds.includes(input.firstKeptEntryId) || !input.firstKeptStillLegal) {
		return { action: "discard", reason: "v3-cut-invalid" };
	}

	// V4 — post-snapshot context_edit targeting the compressed region.
	if (targetsCompressedRegion(appended as never, input.compressedRegionIds)) {
		return { action: "discard", reason: "v4-conflict-edit" };
	}

	// V5 — window/threshold drift beyond 10%.
	const drift = input.tnAtSnapshot > 0 ? Math.abs(input.tnNow - input.tnAtSnapshot) / input.tnAtSnapshot : 0;
	if (drift > 0.1) return { action: "discard", reason: "v5-window-shift" };

	// V6 — summary passed SUM-04.
	if (!input.summaryValidated) return { action: "discard", reason: "v6-summary-invalid" };

	// V7 — POL-07 apply-point safety (both apply points check).
	if (!input.applySafe) return { action: "discard", reason: "v7-unsafe-boundary" };

	// V8a — hard capacity gate (all paths, INV-12; never widened).
	if (input.estimatePostTokens > input.hardFitLimit) {
		return { action: "discard", reason: "v8a-hard-fit" };
	}

	// V8b — efficiency gate (draft path only).
	if (input.efficiencyLimit !== undefined && input.estimatePostTokens > input.efficiencyLimit) {
		return { action: "discard", reason: "v8b-efficiency" };
	}

	// V9 — degraded or aborted.
	if (input.degraded || input.signalAborted) return { action: "discard", reason: "v9-degraded" };

	// V10 — same-boundary conflict: another handler already proposed a
	// compaction, or a context_edit draft touching the compressed region.
	// HOLD, not discard — the snapshot stays ready (§5.7 V10).
	for (const entry of input.sameBoundaryEntries) {
		if (entry.type === "compaction") return { action: "hold" };
	}
	if (targetsCompressedRegion(input.sameBoundaryEntries as never, input.compressedRegionIds)) {
		return { action: "hold" };
	}

	return { action: "propose" };
}

// ─── APP-01: the draft entry ────────────────────────────────────────────────

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

/** `[...event.entries, draft]` — append, never replace (H5(a), APP-04①). */
export function mergeDraftEntries(eventEntries: unknown[], draft: CompactionDraftEntry): { entries: unknown[] } {
	return { entries: [...eventEntries, draft] };
}

// ─── APP-08: reconciliation ─────────────────────────────────────────────────

export interface ReconcileResult {
	status: "committed" | "lost";
	entryId?: string;
	/** V4' audit: post-commit context_edits targeting the compressed region. */
	conflictEdits?: number;
	lostReason?: "overridden" | "dropped" | "branch-changed";
}

function ccCoreProposalId(entry: SessionEntry): string | undefined {
	const details = (entry as { details?: { ccCore?: { proposalId?: unknown } } }).details;
	const id = details?.ccCore?.proposalId;
	return typeof id === "string" ? id : undefined;
}

/**
 * Scan the branch from the leaf backward (≤ scanMax entries) for the latest
 * compaction carrying OUR proposalId nonce. Hit → committed (with the real
 * entryId + V4' audit). Miss → lost; `sessionTreeSinceProposal` selects the
 * branch-changed code, otherwise overridden is the default (a same-boundary
 * later handler replacing entries is the dominant loss mode, H5(b)).
 */
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
		// Committed. V4' audit: later context_edits aimed at the region we
		// just compressed (irreversible — count only, APP-08).
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
