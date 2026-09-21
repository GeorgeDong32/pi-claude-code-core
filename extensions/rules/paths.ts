/**
 * rules/paths.ts — target-path extraction from tool_call inputs (P3-RU-07).
 *
 * pi 0.85 builtins (read/edit/write) and common extension tools carry the
 * target in `input.path` (verified against the 0.85.1 tool schemas and pm's
 * gate, which has used `input.path` since 2.x). Unknown shapes yield [].
 */

/** Extract plausible filesystem target paths from a tool_call input. */
export function extractToolPaths(toolName: string, input: unknown): string[] {
	if (!input || typeof input !== "object") return [];
	const record = input as Record<string, unknown>;
	const out: string[] = [];
	const candidate = record.path ?? record.file_path ?? record.filePath;
	if (typeof candidate === "string" && candidate.length > 0) {
		out.push(candidate);
	}
	// bash heredoc-style writes are out of scope for activation (no path arg)
	void toolName;
	return out;
}
