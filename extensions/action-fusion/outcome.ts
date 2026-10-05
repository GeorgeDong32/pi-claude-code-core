/*
 * action-fusion/outcome.ts — the single authority for interpreting a fused
 * write/edit result for DISPLAY (AR1005-FU-01, spec 2026-10-05 §6).
 *
 * Priority:
 *   1. The structured outcome on the merged details (`thenRun: "succeeded"`,
 *      stamped by executeMutationThenRun — B6). It is the FIRST authority: a
 *      contradictory marker inside the command's log output can never flip a
 *      known-structured success. Unknown field values are NOT coerced to
 *      success (only "succeeded" is; production writes nothing else today —
 *      failed/skipped throw instead).
 *   2. Text compatibility — for legacy replays without metadata and for the
 *      thrown failed/skipped error results. Recognition is LINE-ANCHORED: a
 *      protocol line (a line starting with the marker) or a production text
 *      block STARTING with the marker. Never a mid-line global substring:
 *      prose merely containing the token text does not count.
 *
 * Pure interpretation only: this module never rewrites content/details and
 * never changes execution return values or throw behavior. The protocol
 * tokens stay byte-identical (FUS-04); renderers hold no second copy of
 * marker constants or priority — they consume ThenRunOutcome from here.
 */
import { THEN_RUN_FAILED, THEN_RUN_SKIPPED, THEN_RUN_SUCCEEDED } from "./then-run.ts";

export type ThenRunOutcome = "succeeded" | "failed" | "skipped";

/** Legacy display alias used before the port standardized on `succeeded`
 * (allowed for history replay only — never written by production). */
const LEGACY_OK_MARKER = "[then_run:ok]";

function textBlocks(result: { content?: unknown }): string[] {
	if (!Array.isArray(result.content)) return [];
	return (result.content as Array<{ type?: string; text?: string }>)
		.filter((block) => block?.type === "text" && typeof block.text === "string")
		.map((block) => block.text!);
}

/** Line-anchored marker recognition (FU-02): a protocol line starting with
 * the marker, or a text block that starts with it (the production success
 * append shape). Mid-line substrings in prose never match. */
function carriesMarker(blocks: readonly string[], marker: string): boolean {
	for (const block of blocks) {
		if (block.startsWith(marker)) return true;
		for (const line of block.split("\n")) {
			if (line.trimStart().startsWith(marker)) return true;
		}
	}
	return false;
}

/** Interpret a fused result for display. null = no then_run outcome present
 * (plain write/edit — nothing to show). */
export function interpretThenRunResult(result: { content?: unknown; details?: unknown }): ThenRunOutcome | null {
	const structured = (result.details as { thenRun?: unknown } | undefined)?.thenRun;
	if (structured === "succeeded") return "succeeded"; // first authority — text cannot override
	const blocks = textBlocks(result);
	if (carriesMarker(blocks, THEN_RUN_FAILED)) return "failed";
	if (carriesMarker(blocks, THEN_RUN_SKIPPED)) return "skipped";
	if (carriesMarker(blocks, THEN_RUN_SUCCEEDED) || carriesMarker(blocks, LEGACY_OK_MARKER)) return "succeeded";
	return null;
}
