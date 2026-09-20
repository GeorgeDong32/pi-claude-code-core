/**
 * Shared settings-JSON primitive (P0-LB-01).
 *
 * Single implementation replacing the four per-package copies
 * (pm config.ts / pi-effort effort.ts / pi-review config.ts / goal state).
 * Semantics merged from those implementations:
 *
 *   - read: never throws. Missing file, empty file, malformed JSON, or a
 *     non-object value yields the caller-supplied fallback (pm's
 *     loadModelProfiles behavior; effort's callers caught and defaulted).
 *   - write: atomic tmp+rename in the same directory, so a failed write can
 *     never corrupt the previous file. Concurrent writers resolve by
 *     last-rename-wins (same as the previous per-package copies).
 */

import {
	mkdirSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

/**
 * Read a JSON file. Returns `fallback` when the file is missing, empty,
 * unparsable, or not a JSON object. Never throws.
 */
export function readJson<T extends object>(path: string, fallback: T): T {
	try {
		const raw = readFileSync(path, "utf-8").trim();
		if (raw.length === 0) return fallback;
		const parsed: unknown = JSON.parse(raw);
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			return parsed as T;
		}
		return fallback;
	} catch {
		return fallback;
	}
}

/**
 * Atomically write `value` as pretty-printed JSON (2-space + trailing
 * newline, matching the historical on-disk format of all four packages).
 *
 * The temp file lives in the target directory (same filesystem → atomic
 * rename). On any failure the temp file is best-effort removed and the
 * original file is left untouched.
 */
export function writeJsonAtomic(path: string, value: unknown): void {
	const content = `${JSON.stringify(value, null, 2)}\n`;
	const dir = dirname(path);
	mkdirSync(dir, { recursive: true });
	const tmpPath = join(dir, `.${basename(path)}.tmp.${process.pid}.${randomUUID()}`);
	try {
		writeFileSync(tmpPath, content, "utf-8");
		renameSync(tmpPath, path);
	} catch (error) {
		try {
			unlinkSync(tmpPath);
		} catch {
			// Best effort: the original write failure is the useful error.
		}
		throw error;
	}
}

function basename(path: string): string {
	const idx = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
	return idx === -1 ? path : path.slice(idx + 1);
}
