import { THEN_RUN_FAILED, THEN_RUN_SKIPPED, THEN_RUN_SUCCEEDED } from "./then-run.ts";

export type ThenRunOutcome = "succeeded" | "failed" | "skipped";

const LEGACY_OK_MARKER = "[then_run:ok]";

function textBlocks(result: { content?: unknown }): string[] {
	if (!Array.isArray(result.content)) return [];
	return (result.content as Array<{ type?: string; text?: string }>)
		.filter((block) => block?.type === "text" && typeof block.text === "string")
		.map((block) => block.text!);
}

function carriesMarker(blocks: readonly string[], marker: string): boolean {
	for (const block of blocks) {
		if (block.startsWith(marker)) return true;
		for (const line of block.split("\n")) {
			if (line.trimStart().startsWith(marker)) return true;
		}
	}
	return false;
}

export function interpretThenRunResult(result: { content?: unknown; details?: unknown }): ThenRunOutcome | null {
	const structured = (result.details as { thenRun?: unknown } | undefined)?.thenRun;
	if (structured === "succeeded") return "succeeded";
	const blocks = textBlocks(result);
	if (carriesMarker(blocks, THEN_RUN_FAILED)) return "failed";
	if (carriesMarker(blocks, THEN_RUN_SKIPPED)) return "skipped";
	if (carriesMarker(blocks, THEN_RUN_SUCCEEDED) || carriesMarker(blocks, LEGACY_OK_MARKER)) return "succeeded";
	return null;
}
