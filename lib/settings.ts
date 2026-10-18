/**
 * Shared settings-JSON primitive (P0-LB-01).
 *
 * Single implementation replacing the four per-package copies
 * (pm config.ts / pi-effort effort.ts / pi-review config.ts / goal state).
 * Semantics merged from those implementations:
 *
 *   - read: returns the fallback for missing/empty/malformed/non-object
 *     input instead of throwing (pm's loadModelProfiles behavior; effort's
 *     callers caught and defaulted). A throwing `onInvalid` callback is the
 *     one exception — it propagates (see readJson doc).
 *   - write: atomic tmp+rename in the same directory, so a failed write can
 *     never corrupt the previous file. Concurrent writers resolve by
 *     last-rename-wins (same as the previous per-package copies).
 */

import {
	mkdirSync,
	readFileSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

/**
 * Read a JSON file. Returns `fallback` when the file is missing, empty,
 * unparsable, or not a JSON object.
 *
 * `onInvalid` reports WHY the fallback was used, for callers that surfaced a
 * diagnostic in the pre-lib implementation (pm warns on malformed config).
 * A callback that throws propagates out as-is (once, with the real reason) —
 * it is not swallowed into a second "malformed" report; callers may use a
 * throwing callback as a guard (e.g. refuse to overwrite a corrupt file).
 */
export function readJson<T extends object>(
	path: string,
	fallback: T,
	onInvalid?: (reason: "missing" | "empty" | "malformed" | "non-object") => void,
): T {
	let raw: string;
	try {
		raw = readFileSync(path, "utf-8");
	} catch {
		onInvalid?.("missing");
		return fallback;
	}
	raw = raw.trim();
	if (raw.length === 0) {
		onInvalid?.("empty");
		return fallback;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		onInvalid?.("malformed");
		return fallback;
	}
	if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
		return parsed as T;
	}
	onInvalid?.("non-object");
	return fallback;
}

/**
 * Atomically write `value` as pretty-printed JSON (2-space + trailing
 * newline, matching the historical on-disk format of all four packages).
 *
 * The temp file lives in the target directory (same filesystem → atomic
 * rename). On any failure the temp file is best-effort removed and the
 * original file is left untouched. `opts.mode` (e.g. pm's 0o600 for
 * model-profiles.json) is applied to the temp file so it survives the
 * rename — default keeps the process umask, like a plain writeFileSync.
 */
export function writeJsonAtomic(
	path: string,
	value: unknown,
	opts?: { mode?: number },
): void {
	const content = `${JSON.stringify(value, null, 2)}\n`;
	const dir = dirname(path);
	mkdirSync(dir, { recursive: true });
	const tmpPath = join(dir, `.${basename(path)}.tmp.${process.pid}.${randomUUID()}`);
	try {
		writeFileSync(tmpPath, content, {
			encoding: "utf-8",
			...(opts?.mode !== undefined ? { mode: opts.mode } : {}),
		});
		renameSync(tmpPath, path);
	} catch (error) {
		try {
			unlinkSync(tmpPath);
		} catch {
			// Best effort: the original write failure is the useful error.
		}
		throw error;
	}
	// Arch review 2026-10-18 C1: the write side of readJsonCached — a write is
	// the one event every mtime window could miss, so drop the entry by hand.
	cachedReads.delete(path);
}

function basename(path: string): string {
	const idx = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
	return idx === -1 ? path : path.slice(idx + 1);
}

// ─── Cached reads (arch review 2026-10-18 C1) ─────────────────────────────

/**
 * mtime-keyed cache behind `readJson` for hot paths that re-read the same
 * small settings file several times per turn (effort settings on every sync,
 * modes project permissions on every tool call, the goal auditor config).
 *
 * Shape follows the two proven in-repo precedents — modes' `configCache`
 * (mtimeMs key, shared read-only result) and memory's `scanMemoryDirCached`
 * (explicit invalidation on every internal write path) — collapsed into the
 * shared primitive so callers cannot forget the write side:
 *
 *   - `writeJsonAtomic` drops the cache entry for the path it writes, so
 *     same-millisecond rewrites cannot serve stale content to automation.
 *   - A missing file is a miss AND drops the entry (a delete is a change too).
 *   - The returned object is SHARED: callers treat it as read-only, same
 *     discipline as modes' configCache. Mutate-then-write call sites keep
 *     plain `readJson` and build their own object.
 *   - Reads that throw (a throwing `onInvalid` guard) are never cached, so
 *     a corrupt file re-reports on every call, exactly like today.
 */
const cachedReads = new Map<string, { mtimeMs: number; value: object }>();

export function readJsonCached<T extends object>(
	path: string,
	fallback: T,
	onInvalid?: (reason: "missing" | "empty" | "malformed" | "non-object") => void,
): T {
	let mtimeMs: number;
	try {
		mtimeMs = statSync(path).mtimeMs;
	} catch {
		cachedReads.delete(path);
		return readJson(path, fallback, onInvalid);
	}
	const cached = cachedReads.get(path);
	if (cached !== undefined && cached.mtimeMs === mtimeMs) {
		return cached.value as T;
	}
	const value = readJson(path, fallback, onInvalid);
	cachedReads.set(path, { mtimeMs, value });
	return value;
}

/** Test seam: drop every cached read (the write side is automatic). */
export function clearCachedReads(): void {
	cachedReads.clear();
}
