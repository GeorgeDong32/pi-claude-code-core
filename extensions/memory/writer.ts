/**
 * memory/writer.ts — the document write engine (SPEC 2026-10-07 P2-3 W1/W2).
 *
 * write / remove / reindex are the ONLY paths that mutate memory documents
 * and MEMORY.md; every success invalidates the memdir scan cache IMMEDIATELY
 * (C7 — callers never read their own stale layer back within the TTL).
 *
 * Dependency direction (one-way): store / consolidate / importers → writer
 * → memdir. memdir must never import writer back. Ops preflight, routing
 * and the consolidation lock stay in store/consolidate — the writer does not
 * re-acquire them.
 *
 * "Atomic" means single-file visibility (unique tmp + same-dir rename); a
 * failed write cleans its tmp and keeps the original content. Multi-file
 * batches keep their existing preflight / partial-failure semantics — this
 * is NOT a transaction promise.
 */

import { mkdirSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { invalidateMemDirCache, isMemoryFile, scanMemoryDir, type MemoryEntry } from "./memdir.ts";
import { MEMORY_INDEX_MAX } from "../../lib/context-budget.ts";

export type MemoryWriteContent =
	/** Byte-faithful copy/replace — migration imports and raw rewrites.
	 * NEVER re-serialized: unknown frontmatter fields survive verbatim. */
	| { kind: "raw"; text: string }
	/** Structured add: the ONE serializer below renders the document. */
	| { kind: "memory"; body: string; meta: MemoryDocMeta };

export interface MemoryDocMeta {
	name: string;
	description: string;
	type?: string;
}

/** The ONE frontmatter serializer (was store.ts#renderFile + the importers'
 *  inline template — two encodings that could drift). */
export function serializeMemoryDocument(body: string, meta: MemoryDocMeta): string {
	const type = meta.type ?? "reference";
	return `---\nname: ${meta.name}\ndescription: ${meta.description}\nmetadata:\n  type: ${type}\n---\n\n${body}\n`;
}

/** Atomic document write (unique tmp + same-dir rename). Throws on IO
 *  error with the tmp cleaned up and the original content untouched. */
export function writeDocument(dir: string, name: string, content: MemoryWriteContent): void {
	const text = content.kind === "raw" ? content.text : serializeMemoryDocument(content.body, content.meta);
	atomicWriteText(dir, name, text);
	invalidateMemDirCache(dir);
}

/** The shared atomic primitive. `invalidate: false` is for MEMORY.md itself
 *  (not a memory file — the reconciler's own dirCache just got the fresh
 *  entry list, and dropping the scan cache here would force one full
 *  re-read after EVERY reconcile). */
function atomicWriteText(dir: string, name: string, text: string, opts: { invalidate?: boolean } = {}): void {
	mkdirSync(dir, { recursive: true });
	const tmp = join(dir, `.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}.md`);
	try {
		writeFileSync(tmp, text, "utf-8");
		renameSync(tmp, join(dir, name));
	} catch (err) {
		try {
			unlinkSync(tmp);
		} catch {
			/* nothing landed */
		}
		throw err;
	}
	if (opts.invalidate !== false) invalidateMemDirCache(dir);
}

/** Remove one document. ENOENT is idempotent (still drops a possibly-stale
 *  cache entry); any other error propagates to the caller's handling. */
export function removeDocument(dir: string, name: string): void {
	try {
		unlinkSync(join(dir, name));
	} catch (err) {
		if ((err as { code?: string }).code !== "ENOENT") throw err;
	}
	invalidateMemDirCache(dir);
}

// ─── index reconcile (moved from memdir — the WRITE orchestration lives
//     with the writer; scanning/parsing stay in memdir) ───

export const INDEX_MAX_LINES = 200;
// B2: derived from the single budget authority (lib/context-budget.ts) —
// the bus contextBudget channel publishes the same number, so a bump can
// never silently diverge from the actual clamp.
export const INDEX_MAX_BYTES = MEMORY_INDEX_MAX;

export interface ReconcileResult {
	entries: MemoryEntry[];
	skipped: number;
	rewrote: boolean;
}

/** Build the MEMORY.md body from entries (single-line rows). */
export function buildIndexBody(entries: MemoryEntry[]): string {
	return entries
		.slice(0, INDEX_MAX_LINES)
		.map((e) => `- [${e.title}](${e.file}) — ${e.description}`)
		.join("\n");
}

/** Reconcile MEMORY.md. mtime short-circuit BEFORE any content read
 *  (review #18): stat the index and the .md files first; only when the
 *  index is stale (or the previous scan had skips) do we read contents.
 *  The cache is keyed by memoryDir and validated against the file-name
 *  list, so deletions/renames (which don't bump any mtime) still
 *  invalidate it — no permanently dead index rows. A FAILED index write
 *  keeps the old MEMORY.md and reports rewrote:false (never cached as a
 *  successful write). */
interface DirCache {
	skip: number;
	entries: MemoryEntry[] | null;
	namesKey: string;
}
const dirCache = new Map<string, DirCache>();

export function reindex(memoryDir: string): ReconcileResult {
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
			atomicWriteText(memoryDir, "MEMORY.md", `${body}\n`, { invalidate: false });
		} catch {
			return { entries, skipped, rewrote: false };
		}
	}
	return { entries, skipped, rewrote: true };
}
