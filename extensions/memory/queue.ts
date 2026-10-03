/**
 * memory/queue.ts — the pending-extraction queue (spec 2026-10-03-memory-exit-flush).
 *
 * The shutdown path must never run an LLM call (the measured root cause of
 * the ~10s exit stall: the host awaits every session_shutdown handler
 * serially with no host-side timeout). Instead of the old awaited flush,
 * the shutdown handler stages the unextracted conversation tail as ONE
 * JSON record here; the NEXT session_start for the same project drains it
 * in the background through the usual ops lane.
 *
 * Disk layout (P0-CT-09 registered):
 *   ~/.pi/agent/memory-queue/<sessionId[:8]>-<epoch-ms>.json
 *     { v, sessionId, projectsDir, projectKey, cwd, savedAt, attempts, parts }
 *
 * Records are a plaintext second copy of the session tail (global dir,
 * ≤7 days old, ≤2MB total) — disclosed in /memory diagnostics. All writes
 * are atomic (tmp + rename in the same directory); a SIGKILL can only
 * leave .tmp orphans, which readers ignore and the size GC reaps.
 */

import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { ConversationPart } from "./automation.ts";

export const QUEUE_V = 1;

/** Records older than this are expired, not drained. */
export const QUEUE_MAX_AGE_MS = 7 * 24 * 3600_000;
/** Whole-directory byte budget; oldest files are evicted past it. */
export const QUEUE_DIR_MAX_BYTES = 2 * 1024 * 1024;
/** One record carries at most the last 60 parts × 2000 chars each. */
export const QUEUE_MAX_PARTS = 60;
export const QUEUE_PART_CHAR_CAP = 2000;

export interface QueueRecord {
	v: number;
	/** Full session id — the merge key (exact field match, NEVER the
	 * filename prefix: uuidv7's first 8 hex chars span ~65s of wall clock
	 * and collide across sessions). */
	sessionId: string;
	/** Routing key: `resolveMemoryPaths().projectsDir` of the session that
	 * staged the record. Drain only consumes exact matches. */
	projectsDir: string;
	/** Project key for the ops prompt guidance (diagnostic only). */
	projectKey?: string;
	cwd: string;
	savedAt: number;
	attempts: number;
	parts: ConversationPart[];
}

export interface StagedRecord {
	/** Filename within the queue dir (basename only). */
	file: string;
	record: QueueRecord;
}

export function queueDir(agentDir: string): string {
	return join(agentDir, "memory-queue");
}

/** Suffix-60 clamp (A2): the LAST parts are the unextracted tail — taking
 * the first 60 would silently drop the newest window. */
export function clampQueueParts(parts: ConversationPart[]): ConversationPart[] {
	return parts.slice(-QUEUE_MAX_PARTS).map((p) => ({
		role: p.role,
		text: p.text.length > QUEUE_PART_CHAR_CAP ? `${p.text.slice(0, QUEUE_PART_CHAR_CAP)}…` : p.text,
	}));
}

function listQueueFiles(dir: string): string[] {
	try {
		return readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
	} catch {
		return []; // missing dir / unreadable — treated as empty
	}
}

function readRecord(dir: string, file: string): QueueRecord | null {
	try {
		const parsed = JSON.parse(readFileSync(join(dir, file), "utf-8")) as QueueRecord;
		if (typeof parsed !== "object" || parsed === null || typeof parsed.sessionId !== "string" || !Array.isArray(parsed.parts)) return null;
		return parsed;
	} catch {
		return null;
	}
}

function removeQuiet(dir: string, file: string): void {
	try {
		unlinkSync(join(dir, file));
	} catch {
		/* absent / unwritable — the size GC and age cap eventually reap */
	}
}

function atomicWrite(dir: string, file: string, text: string): void {
	const tmp = join(dir, `${file}.${process.pid}.tmp`);
	writeFileSync(tmp, text);
	renameSync(tmp, join(dir, file));
}

/** Stage one record; same-session records are replaced (exact sessionId
 * match — the new tail always ⊇ the old one after the suffix-60 clamp,
 * so replacing is lossless). */
export function writeQueueRecord(agentDir: string, record: QueueRecord): void {
	const dir = queueDir(agentDir);
	mkdirSync(dir, { recursive: true });
	for (const f of listQueueFiles(dir)) {
		const existing = readRecord(dir, f);
		if (existing?.sessionId === record.sessionId) removeQuiet(dir, f);
	}
	atomicWrite(dir, `${record.sessionId.slice(0, 8)}-${record.savedAt}.json`, JSON.stringify(record));
	enforceBudget(dir);
}

/** Read all records, oldest first. Drops unparsable files and applies the
 * age cap + size budget (the global GC: an active project's records can
 * evict a quiet project's — disclosed, bounded at 2MB). */
export function loadQueue(agentDir: string): StagedRecord[] {
	const dir = queueDir(agentDir);
	const out: StagedRecord[] = [];
	for (const f of listQueueFiles(dir)) {
		const record = readRecord(dir, f);
		if (record === null) {
			removeQuiet(dir, f); // corrupted record — unrecoverable, drop
			continue;
		}
		if (Date.now() - record.savedAt > QUEUE_MAX_AGE_MS || record.parts.length === 0) {
			removeQuiet(dir, f);
			continue;
		}
		out.push({ file: f, record });
	}
	out.sort((a, b) => a.record.savedAt - b.record.savedAt);
	enforceBudget(dir);
	return out;
}

/** Persist an incremented attempt counter BEFORE the LLM call, so a
 * SIGKILL mid-call still counts the attempt. Returns false when the write
 * failed (caller blacklists the record for this session). */
export function bumpAttempts(agentDir: string, staged: StagedRecord): boolean {
	const dir = queueDir(agentDir);
	const next = { ...staged.record, attempts: staged.record.attempts + 1 };
	try {
		atomicWrite(dir, staged.file, JSON.stringify(next));
		staged.record.attempts = next.attempts;
		return true;
	} catch {
		return false;
	}
}

export function removeRecord(agentDir: string, file: string): void {
	removeQuiet(queueDir(agentDir), file);
}

/** Read-only inventory for the /memory panel: record count + bytes +
 * oldest age (no JSON parsing — the panel must stay cheap). Null when the
 * queue dir does not exist yet. */
export function queueInventory(agentDir: string): { records: number; bytes: number; oldestSavedAt?: number } | null {
	try {
		const dir = queueDir(agentDir);
		const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
		if (files.length === 0) return null;
		let bytes = 0;
		let oldest: number | undefined;
		for (const f of files) {
			try {
				const st = statSync(join(dir, f));
				bytes += st.size;
				const savedAt = Number(f.match(/-(\d+)\.json$/)?.[1]);
				if (savedAt > 0 && (oldest === undefined || savedAt < oldest)) oldest = savedAt;
			} catch {
				/* raced away — skip */
			}
		}
		return { records: files.length, bytes, oldestSavedAt: oldest };
	} catch {
		return null;
	}
}

/** Cap the directory at QUEUE_DIR_MAX_BYTES by evicting oldest-mtime
 * files (records and .tmp orphans alike). */
function enforceBudget(dir: string): void {
	try {
		const files = readdirSync(dir)
			.map((f) => {
				try {
					const st = statSync(join(dir, f));
					return { f, size: st.size, mtime: st.mtimeMs };
				} catch {
					return null;
				}
			})
			.filter((x): x is { f: string; size: number; mtime: number } => x !== null);
		let total = files.reduce((acc, x) => acc + x.size, 0);
		if (total <= QUEUE_DIR_MAX_BYTES) return;
		files.sort((a, b) => a.mtime - b.mtime);
		for (const x of files) {
			if (total <= QUEUE_DIR_MAX_BYTES) break;
			removeQuiet(dir, x.f);
			total -= x.size;
		}
	} catch {
		/* never let GC break the queue */
	}
}
