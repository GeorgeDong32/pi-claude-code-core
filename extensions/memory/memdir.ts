/**
 * memory/memdir.ts — MEMORY.md index reconciler (P3-ME-02).
 *
 * The index is an implementation detail that converges: every reconcile
 * scans the memory dir and rewrites MEMORY.md from the VALID frontmatter
 * files (≤200 lines / 25KB, truncation appends a WARNING). mtime
 * short-circuit: if no .md file is newer than MEMORY.md, skip the scan.
 * Bad frontmatter files are excluded from the index and reported as
 * skipped by /memory.
 */

import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { MEMORY_INDEX_MAX } from "../../lib/context-budget.ts";

export interface MemoryEntry {
	file: string;
	title: string;
	description: string;
	type: string;
	/** frontmatter metadata.pinned — always-on injection (V2-D5 pin downgrade) */
	pinned?: boolean;
}

export interface ReconcileResult {
	entries: MemoryEntry[];
	skipped: number;
	rewrote: boolean;
}

const VALID_TYPES = new Set(["user", "feedback", "project", "reference"]);

/** True for a valid memory type frontmatter value. */
export function isValidMemoryType(type: string): boolean {
	return VALID_TYPES.has(type);
}

/** S1 (OPT-3): the ONE "what is a memory file" predicate — every scanner,
 * the ops engine and the consolidation tool consume this. Dot-prefix
 * entries (.tmp-* torn writes, .consolidate.lock) are never memory files. */
export function isMemoryFile(name: string): boolean {
	return name.endsWith(".md") && name !== "MEMORY.md" && !name.startsWith(".");
}

/** All memory file names in a dir (total: missing dir → empty). */
export function listMemoryFiles(dir: string): string[] {
	try {
		return readdirSync(dir).filter(isMemoryFile).sort();
	} catch {
		return [];
	}
}

/** Shared kebab-slug derivation (ops engine + hermes importer). */
export function slugify(name: string): string {
	return name.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "memory";
}

/** Split into frontmatter fields + body with ONE close-marker scan (K6);
 * null when the frontmatter is absent or invalid for indexing. */
export function splitFrontmatter(content: string): { title: string; description: string; type: string; pinned: boolean; body: string } | null {
	if (!content.startsWith("---")) return null;
	const lines = content.split("\n");
	let close = -1;
	for (let i = 1; i < lines.length; i++) {
		if (lines[i].trim() === "---") {
			close = i;
			break;
		}
	}
	if (close === -1) return null;
	const fm: Record<string, string> = {};
	for (let i = 1; i < close; i++) {
		const m = /^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/.exec(lines[i].trim());
		if (!m) return null;
		let v = m[2].trim();
		if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
		fm[m[1]] = v;
	}
	if (!fm.name || !fm.description || !VALID_TYPES.has(fm.type)) return null;
	return {
		title: fm.name,
		description: fm.description,
		type: fm.type,
		pinned: fm.pinned === "true",
		body: lines.slice(close + 1).join("\n").replace(/^\n+/, ""),
	};
}

/** Parse a memory file's frontmatter; null when invalid for indexing. */
export function parseMemoryFrontmatter(content: string): { title: string; description: string; type: string; pinned?: boolean } | null {
	const split = splitFrontmatter(content);
	if (!split) return null;
	return { title: split.title, description: split.description, type: split.type, pinned: split.pinned };
}

/** Scan the memory dir and classify files (valid entries + skipped count). */
export function scanMemoryDir(memoryDir: string): { entries: MemoryEntry[]; skipped: number } {
	const entries: MemoryEntry[] = [];
	let skipped = 0;
	const files = listMemoryFiles(memoryDir);
	for (const file of files) {
		try {
			const content = readFileSync(join(memoryDir, file), "utf-8");
			const fm = parseMemoryFrontmatter(content);
			if (!fm) {
				skipped++;
				continue;
			}
			entries.push({ file, title: fm.title, description: fm.description, type: fm.type, pinned: fm.pinned });
		} catch {
			skipped++;
		}
	}
	return { entries, skipped };
}

export const INDEX_MAX_LINES = 200;
// B2: derived from the single budget authority (lib/context-budget.ts) —
// the bus contextBudget channel publishes the same number, so a bump can
// never silently diverge from the actual clamp.
export const INDEX_MAX_BYTES = MEMORY_INDEX_MAX;

/** A memory file with its content — what per-turn injection consumes. */
export interface MemoryFile {
	entry: MemoryEntry;
	body: string;
	mtimeMs: number;
}

const bodyCache = new Map<string, { fingerprint: string; files: MemoryFile[]; skipped: number }>();

/** name:mtimeMs:size for every .md — any edit, add, delete, rename shows. */
function dirFingerprint(memoryDir: string, names: string[]): string {
	const parts: string[] = [];
	for (const f of names) {
		try {
			const st = statSync(join(memoryDir, f));
			parts.push(`${f}:${st.mtimeMs}:${st.size}`);
		} catch {
			parts.push(`${f}:-`);
		}
	}
	return parts.join("|");
}

/**
 * scanMemoryDir WITH bodies, fingerprint-cached per dir: one stat pass on
 * the hot path (every turn), full content re-read only when something
 * actually changed. This is what the injection hooks use — the old wiring
 * read every file's content three times per turn.
 */
export function scanMemoryDirCached(memoryDir: string): { files: MemoryFile[]; skipped: number } {
	const names = listMemoryFiles(memoryDir);
	const fingerprint = dirFingerprint(memoryDir, names);
	const cached = bodyCache.get(memoryDir);
	if (cached && cached.fingerprint === fingerprint) {
		return { files: cached.files, skipped: cached.skipped };
	}
	const files: MemoryFile[] = [];
	let skipped = 0;
	for (const file of names) {
		try {
			const path = join(memoryDir, file);
			const st = statSync(path);
			const content = readFileSync(path, "utf-8");
			const fm = parseMemoryFrontmatter(content);
			if (!fm) {
				skipped++;
				continue;
			}
			files.push({
				entry: { file, title: fm.title, description: fm.description, type: fm.type, pinned: fm.pinned },
				body: content,
				mtimeMs: st.mtimeMs,
			});
		} catch {
			skipped++;
		}
	}
	bodyCache.set(memoryDir, { fingerprint, files, skipped });
	return { files, skipped };
}

/** Build the MEMORY.md body from entries (single-line rows). */
export function buildIndexBody(entries: MemoryEntry[]): string {
	return entries
		.slice(0, INDEX_MAX_LINES)
		.map((e) => `- [${e.title}](${e.file}) — ${e.description}`)
		.join("\n");
}

/** Reconcile MEMORY.md. mtime short-circuit BEFORE any content read
 * (review #18): stat the index and the .md files first; only when the
 * index is stale (or the previous scan had skips) do we read contents.
 * The cache is keyed by memoryDir and validated against the file-name
 * list, so deletions/renames (which don't bump any mtime) still
 * invalidate it — no permanently dead index rows. */
interface DirCache {
	skip: number;
	entries: MemoryEntry[] | null;
	namesKey: string;
}
const dirCache = new Map<string, DirCache>();

export function reconcileMemoryIndex(memoryDir: string): ReconcileResult {
	// cheap pass: names + mtimes only
	let indexMtime = -1;
	try {
		indexMtime = statSync(join(memoryDir, "MEMORY.md")).mtimeMs;
	} catch {
		/* missing index → rewrite */
	}
	let newestMd = -1;
	const names: string[] = [];
	try {
		for (const f of readdirSync(memoryDir)) {
			if (!isMemoryFile(f)) continue;
			names.push(f);
			try {
				newestMd = Math.max(newestMd, statSync(join(memoryDir, f)).mtimeMs);
			} catch {
				/* ignore */
			}
		}
	} catch {
		return { entries: [], skipped: 0, rewrote: false };
	}
	const namesKey = names.sort().join("\n");
	const cached = dirCache.get(memoryDir);
	if (
		indexMtime >= 0 && newestMd <= indexMtime &&
		cached && cached.skip === 0 && cached.entries !== null && cached.namesKey === namesKey
	) {
		// hot path: zero file-content reads — reuse the cached entry list
		return { entries: cached.entries, skipped: 0, rewrote: false };
	}

	const { entries, skipped } = scanMemoryDir(memoryDir);
	dirCache.set(memoryDir, { skip: skipped, entries, namesKey });

	// byte-cap: drop tail rows until it fits, then append WARNING
	let body = buildIndexBody(entries);
	if (entries.length > INDEX_MAX_LINES || Buffer.byteLength(body, "utf-8") > INDEX_MAX_BYTES) {
		while (Buffer.byteLength(body, "utf-8") > INDEX_MAX_BYTES && body.includes("\n")) {
			body = body.slice(0, body.lastIndexOf("\n"));
		}
		body += `\n\n<!-- WARNING: memory index exceeded ${INDEX_MAX_LINES} lines / ${INDEX_MAX_BYTES} bytes and was truncated; prune or split memory files -->`;
	}
	if (entries.length > 0 || skipped === 0) {
		try {
			writeFileSync(join(memoryDir, "MEMORY.md"), `${body}\n`, "utf-8");
		} catch {
			return { entries, skipped, rewrote: false };
		}
	}
	return { entries, skipped, rewrote: true };
}

/** Canonical recall-block key for a memory file (RV; the whereKey successor
 * from the deleted recall-session.ts — one home, next to the storage
 * engine, so wiring + diagnostics cannot drift on the format). */
export function memoryKey(layer: "user" | "project", file: string): string {
	return layer === "user" ? `user-memory/${file}` : `memory/${file}`;
}

/** The recall candidate set (RV-14): both layers, body-loaded via the
 * fingerprint cache, mapped onto selector candidates with absolute paths.
 * Newest-first so manifest rows front-load fresh memories (RV-12 ordering
 * happens here once; the selector just renders). R3 will layer `paths:`
 * scoping on top of this seam. */
export function eligibleMemories(userDir: string, projectDir: string): Array<import("./recall.ts").RecallFile> {
	const out: Array<import("./recall.ts").RecallFile> = [];
	for (const [layer, dir] of [["user", userDir], ["project", projectDir]] as const) {
		for (const f of scanMemoryDirCached(dir).files) {
			out.push({
				key: memoryKey(layer, f.entry.file),
				file: f.entry.file,
				title: f.entry.title,
				description: f.entry.description,
				type: f.entry.type,
				layer,
				mtimeMs: f.mtimeMs,
				absPath: join(dir, f.entry.file),
				body: f.body,
			});
		}
	}
	out.sort((a, b) => b.mtimeMs - a.mtimeMs);
	return out;
}
