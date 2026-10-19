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

import { globMatches } from "../../lib/glob.ts";
import { homedir } from "node:os";

export interface MemoryEntry {
	file: string;
	title: string;
	description: string;
	type: string;
	/** frontmatter metadata.pinned — always-on injection (V2-D5 pin downgrade) */
	pinned?: boolean;
	/** RV-14: user-layer scoping globs (inline list or comma-separated,
	 * `~` expanded at match time). Absent = global (visible everywhere). */
	paths?: string[];
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

/**
 * Why a file is NOT indexable — null when it IS indexable. The SAME steps
 * as splitFrontmatter, named for the guard (entropy-control G1-C1): the
 * guard must block the write at tool-call time with the specific problem,
 * using the index's own judgment as the single source of truth.
 */
export function diagnoseFrontmatter(content: string): string | null {
	if (!content.startsWith("---")) return "no frontmatter block: a memory file must start with a '---' line";
	const lines = content.split("\n");
	let close = -1;
	for (let i = 1; i < lines.length; i++) {
		if (lines[i].trim() === "---") {
			close = i;
			break;
		}
	}
	if (close === -1) return "frontmatter not closed: missing the closing '---' line";
	const fm: Record<string, string> = {};
	for (let i = 1; i < close; i++) {
		const m = /^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/.exec(lines[i].trim());
		if (!m) return `invalid frontmatter line ${i + 1}: "${lines[i].trim().slice(0, 40)}" is not a key: value pair`;
		let v = m[2].trim();
		if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
		fm[m[1]] = v;
	}
	const missing = ["name", "description"].filter((k) => !fm[k]);
	if (missing.length > 0) return `missing required field(s): ${missing.join(", ")}`;
	if (!VALID_TYPES.has(fm.type)) {
		return `invalid metadata.type: ${fm.type ?? "(absent)"} — must be one of ${[...VALID_TYPES].join(", ")}`;
	}
	return null;
}

/** Text-level frontmatter field read (G2-C12/C13) — no reparse, no reorder. */
export function readFrontmatterField(content: string, key: string): string | undefined {
	if (!content.startsWith("---")) return undefined;
	const lines = content.split("\n");
	for (let i = 1; i < lines.length; i++) {
		if (lines[i]!.trim() === "---") break;
		const m = new RegExp(`^${key}:\\s*(\\S.*)$`).exec(lines[i]!.trim());
		if (m) return m[1]!.trim().replace(/^(["'])(.*)\1$/, "$2");
	}
	return undefined;
}

/** Tolerance for "file mtime ≤ consolidated_at" (G2-C13): consolidation
 * stamps then writes within the same second; a few seconds of slack keeps
 * filesystem timestamp granularity from flipping the branch. */
export const AGE_TOLERANCE_MS = 5_000;

/**
 * G2-C13 — the ONE age rule shared by manifest display and staleness hints:
 * `created` wins when present AND the file's mtime does not postdate its
 * `consolidated_at` (within tolerance) — a hand edit after consolidation
 * bumps mtime past the stamp, and content currency falls back to mtime.
 * Legacy files without created simply use mtime. Sort order stays mtime.
 */
export function effectiveAgeMs(content: string, mtimeMs: number, now = Date.now()): number {
	const created = readFrontmatterField(content, "created");
	const consolidatedAt = readFrontmatterField(content, "consolidated_at");
	if (created !== undefined && consolidatedAt !== undefined) {
		const createdMs = Date.parse(created);
		const stampedMs = Date.parse(consolidatedAt);
		if (Number.isFinite(createdMs) && Number.isFinite(stampedMs) && mtimeMs <= stampedMs + AGE_TOLERANCE_MS) {
			return now - createdMs;
		}
	}
	return now - mtimeMs;
}

/** Split into frontmatter fields + body with ONE close-marker scan (K6);
 * null when the frontmatter is absent or invalid for indexing. Same-source
 * with diagnoseFrontmatter (G1-C1): the validity verdict below is exactly
 * diagnoseFrontmatter === null. */
export function splitFrontmatter(content: string): { title: string; description: string; type: string; pinned: boolean; paths?: string[]; body: string } | null {
	if (diagnoseFrontmatter(content) !== null) return null;
	const lines = content.split("\n");
	let close = -1;
	for (let i = 1; i < lines.length; i++) {
		if (lines[i].trim() === "---") {
			close = i;
			break;
		}
	}
	const fm: Record<string, string> = {};
	for (let i = 1; i < close; i++) {
		const m = /^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/.exec(lines[i].trim());
		let v = m![2].trim();
		if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
		fm[m![1]] = v;
	}
	return {
		title: fm.name,
		description: fm.description,
		type: fm.type,
		pinned: fm.pinned === "true",
		paths: parsePathsValue(fm.paths),
		body: lines.slice(close + 1).join("\n").replace(/^\n+/, ""),
	};
}

/** RV-14: parse a `paths:` frontmatter value — inline JSON array
 * (`paths: ["~/A/**", "~/B"]`), comma-separated (`paths: ~/A/**, ~/B`) or a
 * single glob. Empty/unparsable → undefined (treated as global). NOTE:
 * block-list lines (`  - foo`) never reach here — the strict key:value scan
 * rejects them whole-file, which is why ONLY the inline forms are legal. */
export function parsePathsValue(raw: string | undefined): string[] | undefined {
	if (!raw || !raw.trim()) return undefined;
	const text = raw.trim();
	if (text.startsWith("[")) {
		try {
			const parsed: unknown = JSON.parse(text);
			if (Array.isArray(parsed) && parsed.every((v) => typeof v === "string") && parsed.length > 0) return parsed as string[];
		} catch {
			/* fall through to comma form */
		}
	}
	const items = text.split(",").map((s) => s.trim().replace(/^(["'])(.*)\1$/, "$2")).filter(Boolean);
	return items.length > 0 ? items : undefined;
}

/** Parse a memory file's frontmatter; null when invalid for indexing. */
export function parseMemoryFrontmatter(content: string): { title: string; description: string; type: string; pinned?: boolean; paths?: string[] } | null {
	const split = splitFrontmatter(content);
	if (!split) return null;
	return { title: split.title, description: split.description, type: split.type, pinned: split.pinned, paths: split.paths };
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
			entries.push({ file, title: fm.title, description: fm.description, type: fm.type, pinned: fm.pinned, ...(fm.paths ? { paths: fm.paths } : {}) });
		} catch {
			skipped++;
		}
	}
	return { entries, skipped };
}

/** A memory file with its content — what per-turn injection consumes. */
export interface MemoryFile {
	entry: MemoryEntry;
	body: string;
	mtimeMs: number;
}

const bodyCache = new Map<string, { fingerprint: string; files: MemoryFile[]; skipped: number; at: number }>();

/** C7 (arch review 2026-10-03): fresh-window TTL — within this window a hit
 * skips even the fingerprint stat pass. External edits (outside pi) are
 * invisible for at most this long; every internal write path invalidates
 * explicitly (store.ts atomicWriteFile / applyMemoryOps deletes,
 * consolidate.ts, importers.ts) so automation never reads its own stale
 * writes. */
export const MEMDIR_TTL_MS = 1000;

/** Drop the cached scan for one dir — called by every internal write path
 * after mutating the layer (see MEMDIR_TTL_MS). */
export function invalidateMemDirCache(memoryDir: string): void {
	bodyCache.delete(memoryDir);
}

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
	// C7: fresh-window hit — no readdir, no stat pass (the second and later
	// calls in the same turn were re-fingerprinting the whole dir).
	const cached = bodyCache.get(memoryDir);
	if (cached && Date.now() - cached.at < MEMDIR_TTL_MS) {
		return { files: cached.files, skipped: cached.skipped };
	}
	const names = listMemoryFiles(memoryDir);
	const fingerprint = dirFingerprint(memoryDir, names);
	if (cached && cached.fingerprint === fingerprint) {
		cached.at = Date.now();
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
				entry: { file, title: fm.title, description: fm.description, type: fm.type, pinned: fm.pinned, ...(fm.paths ? { paths: fm.paths } : {}) },
				body: content,
				mtimeMs: st.mtimeMs,
			});
		} catch {
			skipped++;
		}
	}
	bodyCache.set(memoryDir, { fingerprint, files, skipped, at: Date.now() });
	return { files, skipped };
}

// buildIndexBody / reconcileMemoryIndex / DirCache moved to writer.ts
// (SPEC 2026-10-07 P2-3 W1/W2: index WRITE orchestration lives with the
// write engine; scanning/parsing stay here).

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
export function eligibleMemories(userDir: string, projectDir: string, projectRoot?: string): Array<import("./recall.ts").RecallFile> {
	const out: Array<import("./recall.ts").RecallFile> = [];
	for (const [layer, dir] of [["user", userDir], ["project", projectDir]] as const) {
		for (const f of scanMemoryDirCached(dir).files) {
			// RV-14: user-layer entries with `paths:` only surface when the
			// session's git canonical root matches (no paths = global)
			if (layer === "user" && f.entry.paths && !scopeMatches(projectRoot, f.entry.paths)) continue;
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

/** RV-14: does the session root match any scoping glob (~ expanded)? A
 * missing root never matches a scoped entry (conservative: hide). Each
 * pattern is tried against the root AND a synthetic child path — the rules
 * glob engine (deliberately) does not match a directory against its own
 * `dir/**` pattern, but scoping means "this project", root included. */
export function scopeMatches(projectRoot: string | undefined, patterns: readonly string[]): boolean {
	if (!projectRoot) return false;
	const expanded = patterns.map((p) => (p.startsWith("~/") ? p.replace(/^~/, homedir()) : p));
	return globMatches(projectRoot, expanded) || globMatches(`${projectRoot}/__scope_child__`, expanded);
}
