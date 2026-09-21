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
 *
 * `onInvalid` reports WHY the fallback was used, for callers that surfaced a
 * diagnostic in the pre-lib implementation (pm warns on malformed config).
 */
export function readJson<T extends object>(
	path: string,
	fallback: T,
	onInvalid?: (reason: "missing" | "empty" | "malformed" | "non-object") => void,
): T {
	try {
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
	} catch {
		onInvalid?.("malformed");
		return fallback;
	}
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
}

function basename(path: string): string {
	const idx = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
	return idx === -1 ? path : path.slice(idx + 1);
}
