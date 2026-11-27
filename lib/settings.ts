import {
	chmodSync,
	mkdirSync,
	readFileSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

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
		if (opts?.mode === undefined) {
			try {
				chmodSync(tmpPath, statSync(path).mode & 0o777);
			} catch {
			}
		}
		renameSync(tmpPath, path);
	} catch (error) {
		try {
			unlinkSync(tmpPath);
		} catch {
		}
		throw error;
	}
	cachedReads.delete(path);
}

function basename(path: string): string {
	const idx = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
	return idx === -1 ? path : path.slice(idx + 1);
}


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

export function clearCachedReads(): void {
	cachedReads.clear();
}
