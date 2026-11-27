
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { isValidMemoryType, listMemoryFiles, slugify, splitFrontmatter } from "./memdir.ts";
import { removeDocument, reindex, serializeMemoryDocument, writeDocument } from "./writer.ts";
import { findSecret } from "./guard.ts";
import { DESCRIPTION_MAX, descriptionTooLong } from "./policy.ts";
export const DESCRIPTION_TOO_LONG_REASON = `description exceeds ${DESCRIPTION_MAX} characters — rewrite as a noun phrase with the topic keywords`;
export const DESCRIPTION_MULTILINE_REASON = "description must be a single line";
function badDescription(description: string | undefined): string | undefined {
	if (description === undefined) return undefined;
	if (description.includes("\n")) return DESCRIPTION_MULTILINE_REASON;
	if (descriptionTooLong(description)) return DESCRIPTION_TOO_LONG_REASON;
	return undefined;
}

export const MEMORY_FILE_BODY_MAX = 8 * 1024;
export const MEMORY_FILE_TOTAL_MAX = MEMORY_FILE_BODY_MAX + 2048;
export const MEMORY_FILES_MAX = 80;

export type MemoryLayer = "user" | "project";

export interface MemoryOp {
	action: "add" | "replace" | "remove";
	layer: MemoryLayer;
	file?: string;
	name?: string;
	description?: string;
	type?: string;
	body?: string;
	old_text?: string;
}

export interface OpsOutcome {
	applied: number;
	skipped: Array<{ file?: string; action?: string; reason: string }>;
	error?: string;
}

export function safeMemoryFileName(file: string): boolean {
	return /^[A-Za-z0-9][A-Za-z0-9._-]*\.md$/.test(file) && !file.startsWith(".") && file !== "MEMORY.md";
}

function renderFile(op: MemoryOp): string {
	return serializeMemoryDocument(op.body ?? "", {
		name: op.name ?? "",
		description: op.description ?? "",
		type: op.type ?? "project",
	});
}

function hoistLeadingFrontmatter(op: MemoryOp): MemoryOp {
	if (!op.body || !op.body.startsWith("---\n")) return op;
	const parsed = splitFrontmatter(`${op.body}\n`);
	if (!parsed || parsed.body.trim().length === 0) return op;
	return {
		...op,
		name: parsed.title || op.name,
		description: parsed.description || op.description,
		type: parsed.type || op.type,
		body: parsed.body,
	};
}

export function fileBytes(path: string): number {
	try {
		return statSync(path).size;
	} catch {
		return 0;
	}
}

export function atomicWriteFile(dir: string, file: string, content: string): void {
	writeDocument(dir, file, { kind: "raw", text: content });
}

function splitContent(content: string): { name: string; description: string; type: string; body: string } | null {
	const split = splitFrontmatter(content);
	if (!split) return null;
	return { name: split.title, description: split.description, type: split.type, body: split.body };
}

export function applyMemoryOps(
	ops: MemoryOp[],
	dirs: { project: string },
): OpsOutcome {
	const outcome: OpsOutcome = { applied: 0, skipped: [] };
	if (ops.length === 0) return outcome;
	if (ops.length > 200) return { applied: 0, skipped: [], error: "batch too large (>200 ops)" };

	const dir = dirs.project;

	type Planned = { kind: "write"; file: string; dir: string; content: string } | { kind: "delete"; file: string; dir: string };
	const planned: Planned[] = [];
	let postFileCount = listMemoryFiles(dir).length;
	const plannedAdds = new Set<string>();

	for (const rawOp of ops) {
		const op = hoistLeadingFrontmatter(rawOp);

		if (op.layer === "user") {
			outcome.skipped.push({ file: op.file, action: op.action, reason: "user layer retired — project memories only" });
			continue;
		}

		if (op.action === "add") {
			if (!op.name || !op.description) {
				outcome.skipped.push({ file: op.file, action: op.action, reason: "add requires name + description" });
				continue;
			}
			if (op.type && !isValidMemoryType(op.type)) {
				outcome.skipped.push({ file: op.file, action: op.action, reason: `invalid type "${op.type}"` });
				continue;
			}
			const why = badDescription(op.description);
			if (why) {
				outcome.skipped.push({ file: op.file, action: op.action, reason: why });
				continue;
			}
			if (!op.body || op.body.trim().length === 0) {
				outcome.skipped.push({ file: op.file, action: op.action, reason: "add requires a body" });
				continue;
			}
			const file = op.file ?? `${slugify(op.name)}.md`;
			if (!safeMemoryFileName(file)) {
				outcome.skipped.push({ file: op.file, action: op.action, reason: `unsafe file name "${file}"` });
				continue;
			}
			if (plannedAdds.has(file)) {
				outcome.skipped.push({ file: op.file, action: op.action, reason: `${file} already added in this batch (duplicate)` });
				continue;
			}
			if (existsSync(join(dir, file))) {
				outcome.skipped.push({ file: op.file, action: op.action, reason: `${file} already exists (use replace)` });
				continue;
			}
			plannedAdds.add(file);
			const content = renderFile(op);
			const secret = findSecret(content);
			if (secret) {
				outcome.skipped.push({ file: op.file, action: op.action, reason: `looks like a ${secret}` });
				continue;
			}
			if (Buffer.byteLength(content, "utf8") > MEMORY_FILE_TOTAL_MAX) {
				outcome.skipped.push({ file: op.file, action: op.action, reason: `file exceeds ${MEMORY_FILE_TOTAL_MAX} bytes` });
				continue;
			}
			planned.push({ kind: "write", file, dir, content });
			postFileCount++;
		} else if (op.action === "replace") {
			const file = op.file ?? "";
			if (!safeMemoryFileName(file) || !existsSync(join(dir, file))) {
				outcome.skipped.push({ file: op.file, action: op.action, reason: `replace target "${file}" not found` });
				continue;
			}
			if (!op.body || op.body.trim().length === 0) {
				outcome.skipped.push({ file: op.file, action: op.action, reason: "replace requires a body" });
				continue;
			}
			const current = readFileSync(join(dir, file), "utf-8");
			const parts = splitContent(current);
			if (!parts) {
				outcome.skipped.push({ file: op.file, action: op.action, reason: `${file} has invalid frontmatter (fix manually first)` });
				continue;
			}
			if (op.old_text !== undefined && !current.includes(op.old_text)) {
				outcome.skipped.push({ file: op.file, action: op.action, reason: "stale anchor: old_text not in current file" });
				continue;
			}
			const why = badDescription(op.description);
			if (why) {
				outcome.skipped.push({ file: op.file, action: op.action, reason: why });
				continue;
			}
			const merged: MemoryOp = {
				...op,
				name: parts.name,
				description: op.description ?? parts.description,
				type: op.type ?? parts.type,
			};
			const content = renderFile(merged);
			const secret = findSecret(content);
			if (secret) {
				outcome.skipped.push({ file: op.file, action: op.action, reason: `looks like a ${secret}` });
				continue;
			}
			if (Buffer.byteLength(content, "utf8") > MEMORY_FILE_TOTAL_MAX) {
				outcome.skipped.push({ file: op.file, action: op.action, reason: `file exceeds ${MEMORY_FILE_TOTAL_MAX} bytes` });
				continue;
			}
			planned.push({ kind: "write", file, dir, content });
		} else if (op.action === "remove") {
			const file = op.file ?? "";
			if (!safeMemoryFileName(file) || !existsSync(join(dir, file))) {
				outcome.skipped.push({ file: op.file, action: op.action, reason: `remove target "${file}" not found` });
				continue;
			}
			if (op.old_text !== undefined) {
				const current = readFileSync(join(dir, file), "utf-8");
				if (!current.includes(op.old_text)) {
					outcome.skipped.push({ file: op.file, action: op.action, reason: "stale anchor: old_text not in current file" });
					continue;
				}
			}
			planned.push({ kind: "delete", file, dir });
			postFileCount--;
		} else {
			outcome.skipped.push({ file: op.file, action: op.action, reason: `unknown action "${String((op as MemoryOp).action)}"` });
		}
	}

	if (planned.length === 0) return outcome;
	if (postFileCount > MEMORY_FILES_MAX) {
		return { applied: 0, skipped: outcome.skipped, error: `layer ${dir} would hold ${postFileCount} files (max ${MEMORY_FILES_MAX}) — consolidate first` };
	}

	const touched = new Set<string>();
	for (const step of planned) {
		try {
			if (step.kind === "write") atomicWriteFile(step.dir, step.file, step.content);
			else removeDocument(step.dir, step.file);
			outcome.applied++;
			touched.add(step.dir);
		} catch (err) {
			outcome.skipped.push({ file: step.file, action: step.kind, reason: `io error: ${err instanceof Error ? err.message : String(err)}` });
		}
	}
	for (const dir of touched) {
		try {
			reindex(dir);
		} catch {
		}
	}
	return outcome;
}


export const LOCK_TTL_MS = 10 * 60_000;

export interface LayerLock {
	dir: string;
	release: () => void;
}

export function acquireLayerLock(dir: string, ttlMs = LOCK_TTL_MS, now = Date.now()): LayerLock | null {
	const lockPath = join(dir, ".consolidate.lock");
	try {
		mkdirSync(lockPath, { recursive: false });
	} catch {
		try {
			const age = now - statSync(lockPath).mtimeMs;
			if (age <= ttlMs) return null;
			rmSync(lockPath, { recursive: true, force: true });
			mkdirSync(lockPath, { recursive: false });
		} catch {
			return null;
		}
	}
	try {
		writeFileSync(join(lockPath, "info"), `${process.pid} ${new Date(now).toISOString()}`, "utf-8");
	} catch {
	}
	return {
		dir,
		release: () => {
			try {
				rmSync(lockPath, { recursive: true, force: true });
			} catch {
			}
		},
	};
}

export interface LayerStats {
	dir: string;
	files: number;
	totalBytes: number;
	indexBytes: number;
	indexTruncated: boolean;
}

export function layerStats(dir: string): LayerStats {
	const files = listMemoryFiles(dir);
	let totalBytes = 0;
	for (const f of files) totalBytes += fileBytes(join(dir, f));
	let indexBytes = 0;
	let indexTruncated = false;
	try {
		const index = readFileSync(join(dir, "MEMORY.md"), "utf-8");
		indexBytes = Buffer.byteLength(index, "utf-8");
		indexTruncated = index.includes("WARNING: memory index exceeded");
	} catch {
	}
	return { dir, files: files.length, totalBytes, indexBytes, indexTruncated };
}
