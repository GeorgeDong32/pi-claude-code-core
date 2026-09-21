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

export interface MemoryEntry {
	file: string;
	title: string;
	description: string;
	type: string;
}

export interface ReconcileResult {
	entries: MemoryEntry[];
	skipped: number;
	rewrote: boolean;
}

const VALID_TYPES = new Set(["user", "feedback", "project", "reference"]);

/** Parse a memory file's frontmatter; null when invalid for indexing. */
export function parseMemoryFrontmatter(content: string): { title: string; description: string; type: string } | null {
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
	return { title: fm.name, description: fm.description, type: fm.type };
}

/** Scan the memory dir and classify files (valid entries + skipped count). */
export function scanMemoryDir(memoryDir: string): { entries: MemoryEntry[]; skipped: number } {
	const entries: MemoryEntry[] = [];
	let skipped = 0;
	let files: string[];
	try {
		files = readdirSync(memoryDir).filter((f) => f.endsWith(".md") && f !== "MEMORY.md").sort();
	} catch {
		return { entries, skipped };
	}
	for (const file of files) {
		try {
			const content = readFileSync(join(memoryDir, file), "utf-8");
			const fm = parseMemoryFrontmatter(content);
			if (!fm) {
				skipped++;
				continue;
			}
			entries.push({ file, title: fm.title, description: fm.description, type: fm.type });
		} catch {
			skipped++;
		}
	}
	return { entries, skipped };
}

export const INDEX_MAX_LINES = 200;
export const INDEX_MAX_BYTES = 25_000;

/** Build the MEMORY.md body from entries (single-line rows). */
export function buildIndexBody(entries: MemoryEntry[]): string {
	return entries
		.slice(0, INDEX_MAX_LINES)
		.map((e) => `- [${e.title}](${e.file}) — ${e.description}`)
		.join("\n");
}

/** Reconcile MEMORY.md. mtime short-circuit BEFORE any content read
 * (review #18): stat the index and the .md files first; only when the
 * index is stale (or the previous scan had skips) do we read contents. */
let lastSkipCount = 0;
let lastEntries: MemoryEntry[] | null = null;

export function reconcileMemoryIndex(memoryDir: string): ReconcileResult {
	// cheap pass: names + mtimes only
	let indexMtime = -1;
	try {
		indexMtime = statSync(join(memoryDir, "MEMORY.md")).mtimeMs;
	} catch {
		/* missing index → rewrite */
	}
	let newestMd = -1;
	let mdCount = 0;
	try {
		for (const f of readdirSync(memoryDir)) {
			if (!f.endsWith(".md") || f === "MEMORY.md") continue;
			mdCount++;
			try {
				newestMd = Math.max(newestMd, statSync(join(memoryDir, f)).mtimeMs);
			} catch {
				/* ignore */
			}
		}
	} catch {
		return { entries: [], skipped: 0, rewrote: false };
	}
	if (indexMtime >= 0 && newestMd <= indexMtime && lastSkipCount === 0 && lastEntries !== null) {
		// hot path: zero file-content reads — reuse the cached entry list
		return { entries: lastEntries, skipped: 0, rewrote: false };
	}

	const { entries, skipped } = scanMemoryDir(memoryDir);
	lastSkipCount = skipped;
	lastEntries = entries;

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
