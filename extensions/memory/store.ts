/**
 * memory/store.ts — structured memory operations engine (V2-D2/V2-C).
 *
 * NOT an LLM tool: this is the shared validation + persistence core used by
 * (a) the side-channel automation (review / correction / flush, P3) and
 * (b) the memory_consolidate tool (P2). One validation truth for every
 * writer, interactive or automatic.
 *
 * Semantics:
 *   - per-op preflight: invalid ops are skipped (reason recorded) while
 *     valid ops in the same batch still apply — one hallucinated op must
 *     not discard a whole LLM capture batch (skip-invalid, hermes-equivalent
 *     semantics). Two gates ARE batch-fatal (nothing written): >200 ops and
 *     a layer file-count cap breach.
 *   - per-file writes are tmp+rename; a mid-batch IO failure leaves the
 *     already-written files in place and the index converges on the next
 *     reconcile
 *   - frontmatter / type / secret / size / count caps enforced here
 *   - replace/remove take an optional `old_text` anchor inside the current
 *     file: when provided and absent, the op is skipped as stale (the model
 *     or a sibling session changed the file since it was read)
 *   - every mutation ends with reconcileMemoryIndex so MEMORY.md converges
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { parseMemoryFrontmatter, reconcileMemoryIndex } from "./memdir.js";
import { findSecret } from "./guard.js";
import { MEMORY_FILE_BODY_MAX, MEMORY_FILES_MAX } from "./constants.js";

export type MemoryLayer = "user" | "project";

export interface MemoryOp {
	action: "add" | "replace" | "remove";
	layer: MemoryLayer;
	/** target file name within the layer (basename, .md); for `add` derived from name when omitted */
	file?: string;
	/** add: frontmatter fields */
	name?: string;
	description?: string;
	type?: string;
	/** add/replace: the new body (below the frontmatter block) */
	body?: string;
	/** optional stale-anchor: must appear in the CURRENT file body or the op is skipped */
	old_text?: string;
}

export interface OpsOutcome {
	applied: number;
	skipped: Array<{ file?: string; action?: string; reason: string }>;
	/** fatal validation error — nothing was written */
	error?: string;
}

const VALID_TYPES = new Set(["user", "feedback", "project", "reference"]);

function slugify(name: string): string {
	return name.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "memory";
}

function safeFileName(file: string): boolean {
	return /^[A-Za-z0-9][A-Za-z0-9._-]*\.md$/.test(file) && !file.startsWith(".") && file !== "MEMORY.md";
}

function renderFile(op: MemoryOp): string {
	const type = op.type ?? (op.layer === "user" ? "user" : "project");
	return `---\nname: ${op.name}\ndescription: ${op.description}\nmetadata:\n  type: ${type}\n---\n\n${op.body}\n`;
}

function listMemoryFiles(dir: string): string[] {
	try {
		return readdirSync(dir).filter((f) => f.endsWith(".md") && f !== "MEMORY.md" && !f.startsWith("."));
	} catch {
		return [];
	}
}

function fileBytes(path: string): number {
	try {
		return statSync(path).size;
	} catch {
		return 0;
	}
}

/** Split a memory file into frontmatter fields + body; null when invalid. */
function splitContent(content: string): { name: string; description: string; type: string; body: string } | null {
	const parsed = parseMemoryFrontmatter(content);
	if (!parsed) return null;
	const lines = content.split("\n");
	let close = -1;
	for (let i = 1; i < lines.length; i++) {
		if (lines[i].trim() === "---") {
			close = i;
			break;
		}
	}
	if (close === -1) return null;
	return { name: parsed.title, description: parsed.description, type: parsed.type, body: lines.slice(close + 1).join("\n").replace(/^\n+/, "") };
}

/** Validate + apply a batch against the two layer dirs. Total function:
 * every failure path returns an outcome, never throws into a hook. */
export function applyMemoryOps(
	ops: MemoryOp[],
	dirs: { user: string; project: string },
): OpsOutcome {
	const outcome: OpsOutcome = { applied: 0, skipped: [] };
	if (ops.length === 0) return outcome;
	if (ops.length > 200) return { applied: 0, skipped: [], error: "batch too large (>200 ops)" };

	const dirFor = (layer: MemoryLayer): string => (layer === "user" ? dirs.user : dirs.project);

	// ---- preflight: validate every op, collect planned writes/deletes ----
	type Planned = { kind: "write"; file: string; dir: string; content: string } | { kind: "delete"; file: string; dir: string };
	const planned: Planned[] = [];
	const postFileCount = new Map<string, number>();
	for (const d of [dirs.user, dirs.project]) postFileCount.set(d, listMemoryFiles(d).length);

	for (const op of ops) {
		const dir = dirFor(op.layer);
		const existing = listMemoryFiles(dir);

		if (op.action === "add") {
			if (!op.name || !op.description) {
				outcome.skipped.push({ file: op.file, action: op.action, reason: "add requires name + description" });
				continue;
			}
			if (op.type && !VALID_TYPES.has(op.type)) {
				outcome.skipped.push({ file: op.file, action: op.action, reason: `invalid type "${op.type}"` });
				continue;
			}
			if (!op.body || op.body.trim().length === 0) {
				outcome.skipped.push({ file: op.file, action: op.action, reason: "add requires a body" });
				continue;
			}
			const file = op.file ?? `${slugify(op.name)}.md`;
			if (!safeFileName(file)) {
				outcome.skipped.push({ file: op.file, action: op.action, reason: `unsafe file name "${file}"` });
				continue;
			}
			if (existsSync(join(dir, file))) {
				outcome.skipped.push({ file: op.file, action: op.action, reason: `${file} already exists (use replace)` });
				continue;
			}
			const content = renderFile(op);
			const secret = findSecret(content);
			if (secret) {
				outcome.skipped.push({ file: op.file, action: op.action, reason: `looks like a ${secret}` });
				continue;
			}
			if (Buffer.byteLength(content, "utf8") > MEMORY_FILE_BODY_MAX + 2048) {
				outcome.skipped.push({ file: op.file, action: op.action, reason: `file exceeds ${MEMORY_FILE_BODY_MAX + 2048} bytes` });
				continue;
			}
			planned.push({ kind: "write", file, dir, content });
			postFileCount.set(dir, (postFileCount.get(dir) ?? 0) + 1);
		} else if (op.action === "replace") {
			const file = op.file ?? "";
			if (!safeFileName(file) || !existsSync(join(dir, file))) {
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
			if (Buffer.byteLength(content, "utf8") > MEMORY_FILE_BODY_MAX + 2048) {
				outcome.skipped.push({ file: op.file, action: op.action, reason: `file exceeds ${MEMORY_FILE_BODY_MAX + 2048} bytes` });
				continue;
			}
			planned.push({ kind: "write", file, dir, content });
		} else if (op.action === "remove") {
			const file = op.file ?? "";
			if (!safeFileName(file) || !existsSync(join(dir, file))) {
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
			postFileCount.set(dir, (postFileCount.get(dir) ?? 0) - 1);
		} else {
			outcome.skipped.push({ file: op.file, action: op.action, reason: `unknown action "${String((op as MemoryOp).action)}"` });
		}
	}

	if (planned.length === 0) return outcome;
	for (const [dir, count] of postFileCount) {
		if (count > MEMORY_FILES_MAX) {
			return { applied: 0, skipped: outcome.skipped, error: `layer ${dir} would hold ${count} files (max ${MEMORY_FILES_MAX}) — consolidate first` };
		}
	}

	// ---- apply: per-file tmp+rename (atomic), deletes plain unlink ----
	const touched = new Set<string>();
	for (const step of planned) {
		try {
			if (step.kind === "write") {
				mkdirSync(step.dir, { recursive: true });
				const tmp = join(step.dir, `.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}.md`);
				writeFileSync(tmp, step.content, "utf-8");
				renameSync(tmp, join(step.dir, step.file));
			} else {
				unlinkSync(join(step.dir, step.file));
			}
			outcome.applied++;
			touched.add(step.dir);
		} catch (err) {
			outcome.skipped.push({ file: step.file, action: step.kind, reason: `io error: ${err instanceof Error ? err.message : String(err)}` });
		}
	}
	for (const dir of touched) {
		try {
			reconcileMemoryIndex(dir);
		} catch {
			/* index converges on next session_start */
		}
	}
	return outcome;
}

// ─── cross-process consolidation lock (V2-C) ───

export const LOCK_TTL_MS = 10 * 60_000;

export interface LayerLock {
	dir: string;
	release: () => void;
}

/** mkdir-based atomic lock. Steals entries older than ttl (a crashed holder
 * must not wedge consolidation forever). Null = someone else holds it. */
export function acquireLayerLock(dir: string, ttlMs = LOCK_TTL_MS, now = Date.now()): LayerLock | null {
	const lockPath = join(dir, ".consolidate.lock");
	try {
		mkdirSync(lockPath, { recursive: false });
	} catch {
		// exists: stale?
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
		/* lock metadata is diagnostic only */
	}
	return {
		dir,
		release: () => {
			try {
				rmSync(lockPath, { recursive: true, force: true });
			} catch {
				/* best effort */
			}
		},
	};
}

/** Layer stats for consolidation decisions and /memory diagnostics. */
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
		/* no index yet */
	}
	return { dir, files: files.length, totalBytes, indexBytes, indexTruncated };
}
