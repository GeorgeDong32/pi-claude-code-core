
import type { SubCallKind, SubCallRecord, ValidationVerdict } from "./types.ts";

export interface ValidationThresholds {
	minNarrativeChars: number;
	minPrefixChars: number;
	maxSummaryChars: number;
}

export const TURN_PREFIX_SEPARATOR = "\n\n---\n\n**Turn Context (split turn):**\n\n";

export function classifySubCall(promptStartsWith: string): SubCallKind {
	if (promptStartsWith.startsWith("<conversation>")) return "history";
	if (promptStartsWith.startsWith("# Conversation")) return "turn-prefix";
	return "unknown";
}

function subThreshold(kind: SubCallKind, t: ValidationThresholds): number {
	return kind === "turn-prefix" ? t.minPrefixChars : t.minNarrativeChars;
}

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

export function stripFileSections(summary: string): string {
	return summary
		.replace(/<read-files>[\s\S]*?<\/read-files>/g, "")
		.replace(/<modified-files>[\s\S]*?<\/modified-files>/g, "")
		.trim();
}

function countHeadings(text: string): number {
	return (text.match(/^#{1,6}\s+\S/gm) ?? []).length;
}

export function isPureFileListing(summary: string): boolean {
	return stripFileSections(summary).length === 0;
}

export interface AssembledInput {
	summary: string;
	isSplitTurn: boolean;
	hasHistory: boolean;
	subCalls: SubCallRecord[];
}

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

export function stripLedgerBlock(summary: string): string {
	return summary
		.replace(/<cc-core-ledger v="[^"]*">[\s\S]*?<\/cc-core-ledger>\s*/g, "")
		.trim();
}
