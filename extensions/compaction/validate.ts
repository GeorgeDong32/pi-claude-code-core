/*
 * Smart Compaction — summary validation gates (SPEC SC §5.5 SUM-04/SUM-09,
 * task W1). Pure functions; every gate id is stable so tests (and BLK-4) pin
 * exactly which check fired.
 *
 * Two layers, BOTH must pass before any propose/supply (INV-5):
 *   per-sub-call  ① stopReason not length/error/aborted (defensive — pi's
 *                    getSummarizationFailure already throws on those)
 *                 ② narrative length ≥ kind threshold
 *                 ③ reasoning-only detection (usage.reasoning ≥ 0.9·output
 *                    with short/empty narrative, or empty narrative)
 *                 ④ no toolCall blocks
 *   assembled     ⑤ narrative (without <read-files>/<modified-files>) ≥
 *                    minNarrativeChars AND ≥ 2 markdown headings
 *                 ⑥ total ≤ maxSummaryChars
 *                 ⑦ non-empty, not a pure file listing (E3 fixture shape)
 *                 ⑧ split-turn ⇒ contains the turn-prefix section with ≥
 *                    minPrefixChars of body
 *                 ⑨ sub-call count/kinds match the preparation expectation
 *
 * SUM-09 classification keys off pi's internal prompt shapes —
 * "<conversation>" (history) vs "# Conversation" (turn-prefix) — pinned by
 * contract SC-HOST-09. "unknown" never passes ⑨; the runtime (W3/W4)
 * additionally degrades to shadow on unknown shapes.
 */

import type { SubCallKind, SubCallRecord, ValidationVerdict } from "./types.ts";

export interface ValidationThresholds {
	minNarrativeChars: number;
	minPrefixChars: number;
	maxSummaryChars: number;
}

/** pi's fixed split-turn merge separator (H14; contract SC-HOST-09). */
export const TURN_PREFIX_SEPARATOR = "\n\n---\n\n**Turn Context (split turn):**\n\n";

/** Classify one logical call by its prompt's opening shape (SUM-09). */
export function classifySubCall(promptStartsWith: string): SubCallKind {
	if (promptStartsWith.startsWith("<conversation>")) return "history";
	if (promptStartsWith.startsWith("# Conversation")) return "turn-prefix";
	return "unknown";
}

function subThreshold(kind: SubCallKind, t: ValidationThresholds): number {
	return kind === "turn-prefix" ? t.minPrefixChars : t.minNarrativeChars;
}

/** Layer 1: validate ONE logical sub-call. Gate ids: "sub:*". */
export function validateSubCall(record: SubCallRecord, thresholds: ValidationThresholds): ValidationVerdict {
	const failures: string[] = [];
	if (record.stopReason === "length" || record.stopReason === "error" || record.stopReason === "aborted") {
		failures.push("sub:stopReason");
	}
	const threshold = subThreshold(record.kind, thresholds);
	const narrative = record.narrativeText.trim();
	if (narrative.length < threshold) failures.push("sub:narrative");
	const usage = record.usage;
	const reasoning =
		usage?.reasoning !== undefined && usage.output !== undefined && usage.output > 0
			? usage.reasoning >= 0.9 * usage.output
			: false;
	if (narrative.length === 0 || (reasoning && narrative.length < threshold)) {
		failures.push("sub:reasoning-only");
	}
	if (record.hasToolCall) failures.push("sub:toolCall");
	return { ok: failures.length === 0, failures };
}

/** Strip the file-list sections pi appends to summaries (assembled layer). */
export function stripFileSections(summary: string): string {
	return summary
		.replace(/<read-files>[\s\S]*?<\/read-files>/g, "")
		.replace(/<modified-files>[\s\S]*?<\/modified-files>/g, "")
		.trim();
}

function countHeadings(text: string): number {
	// Language-independent: ATX headings at line starts.
	return (text.match(/^#{1,6}\s+\S/gm) ?? []).length;
}

/** True for the E3 shape: nothing but file listings / separators / blanks. */
export function isPureFileListing(summary: string): boolean {
	return stripFileSections(summary).length === 0;
}

export interface AssembledInput {
	summary: string;
	isSplitTurn: boolean;
	/** Whether the preparation had history messages to summarize. */
	hasHistory: boolean;
	/** Observed logical sub-calls (post-retry, one record per logical call). */
	subCalls: SubCallRecord[];
}

/** Layer 2: validate the assembled result. Gate ids: "assembled:*". */
export function validateAssembled(input: AssembledInput, thresholds: ValidationThresholds): ValidationVerdict {
	const failures: string[] = [];
	const summary = input.summary.trim();
	const narrative = stripFileSections(summary);

	if (narrative.length < thresholds.minNarrativeChars) failures.push("assembled:narrative");
	if (countHeadings(narrative) < 2) failures.push("assembled:headings");
	if (summary.length > thresholds.maxSummaryChars) failures.push("assembled:max-length");
	if (summary.length === 0 || isPureFileListing(summary)) failures.push("assembled:file-listing-only");

	if (input.isSplitTurn) {
		const separatorIndex = summary.indexOf(TURN_PREFIX_SEPARATOR);
		if (separatorIndex === -1) {
			failures.push("assembled:split-missing-section");
		} else {
			const prefixBody = summary.slice(separatorIndex + TURN_PREFIX_SEPARATOR.length);
			if (stripFileSections(prefixBody).trim().length < thresholds.minPrefixChars) {
				failures.push("assembled:split-prefix-body");
			}
		}
	}

	// ⑨ expected kinds: history when there is history, turn-prefix on split.
	const expected: SubCallKind[] = [];
	if (input.hasHistory) expected.push("history");
	if (input.isSplitTurn) expected.push("turn-prefix");
	const observed = [...input.subCalls].sort((a, b) => a.kind.localeCompare(b.kind));
	const expectedSorted = [...expected].sort((a, b) => a.localeCompare(b));
	if (
		observed.length !== expectedSorted.length ||
		observed.some((call, i) => call.kind !== expectedSorted[i])
	) {
		failures.push("assembled:call-set");
	}
	return { ok: failures.length === 0, failures };
}

/**
 * Narrative-only view of the assembled summary for the ledger splitter
 * (LED-02b) and SUM-01 previousSummary handling: drops the cc-core ledger
 * block and the file sections.
 */
export function stripLedgerBlock(summary: string): string {
	return summary
		.replace(/<cc-core-ledger v="1">[\s\S]*?<\/cc-core-ledger>\s*/g, "")
		.trim();
}
