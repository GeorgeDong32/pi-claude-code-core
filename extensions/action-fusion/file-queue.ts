/*
 * Fallback per-file serialization when the host does not export the official
 * withFileMutationQueue (SPEC FUS-03 adapter #2).
 * Ported from NVlabs/SoL-Pi (MIT) @ src/sol-pi/extensions/action-fusion/file-queue.ts.
 */
import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const queueTails = new Map<string, Promise<void>>();
const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/gu;

function normalizeToolPath(filePath: string): string {
	const normalized = filePath.replace(UNICODE_SPACES, " ");
	return normalized.startsWith("@") ? normalized.slice(1) : normalized;
}

export function resolveToolPath(cwd: string, filePath: string): string {
	const stripped = normalizeToolPath(filePath);
	// Pi accepts file URLs; the queue and hash guard must use the same target.
	const expanded = stripped.startsWith("file://") ? fileURLToPath(stripped) : stripped;
	if (expanded === "~") return homedir();
	if (expanded.startsWith("~/")) return resolve(homedir(), expanded.slice(2));
	return resolve(cwd, expanded);
}

function isMissingPathError(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		((error as { code?: string }).code === "ENOENT" || (error as { code?: string }).code === "ENOTDIR")
	);
}

async function canonicalQueueKey(filePath: string): Promise<string> {
	const resolvedPath = resolve(filePath);
	let current = resolvedPath;
	const missingSegments: string[] = [];

	while (true) {
		try {
			return resolve(await realpath(current), ...missingSegments);
		} catch (error) {
			if (!isMissingPathError(error)) throw error;
			const parent = dirname(current);
			if (parent === current) return resolvedPath;
			missingSegments.unshift(basename(current));
			current = parent;
		}
	}
}

/** Serialize fused operations for one canonical file path. */
export async function withFusedFileQueue<T>(filePath: string, work: () => Promise<T>): Promise<T> {
	const key = await canonicalQueueKey(filePath);
	const previous = queueTails.get(key) ?? Promise.resolve();
	let release!: () => void;
	const owned = new Promise<void>((resolveOwned) => {
		release = resolveOwned;
	});
	const tail = previous.then(() => owned);
	queueTails.set(key, tail);

	await previous;
	try {
		return await work();
	} finally {
		release();
		if (queueTails.get(key) === tail) queueTails.delete(key);
	}
}
