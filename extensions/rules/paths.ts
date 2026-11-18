
export function extractToolPaths(input: unknown): string[] {
	if (!input || typeof input !== "object") return [];
	const record = input as Record<string, unknown>;
	const out: string[] = [];
	const candidate = record.path ?? record.file_path ?? record.filePath;
	if (typeof candidate === "string" && candidate.length > 0) {
		out.push(candidate);
	}
	return out;
}
