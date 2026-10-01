/*
 * Fallback per-file serialization when the host does not export the official
 * withFileMutationQueue (SPEC FUS-03 adapter #2).
 * Ported from NVlabs/SoL-Pi (MIT) @ src/sol-pi/extensions/action-fusion/file-queue.ts.
 * B6: path normalization/resolution moved to tool-path.ts — this file is
 * queue mechanics only.
 */
import { realpath } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

const queueTails = new Map<string, Promise<void>>();

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

/**
 * Concurrent calls for the same unresolved path share ONE key computation, so
 * their synchronous read-and-set of the tail map resumes in call order.
 * Without this, two racing realpath() resolutions can settle out of order and
 * the queue stops serializing (found by the FUS-10 concurrency test).
 */
const inflightKeys = new Map<string, Promise<string>>();
function canonicalQueueKeyShared(filePath: string): Promise<string> {
	const pending = inflightKeys.get(filePath);
	if (pending) return pending;
	const computed = canonicalQueueKey(filePath).finally(() => {
		if (inflightKeys.get(filePath) === computed) inflightKeys.delete(filePath);
	});
	inflightKeys.set(filePath, computed);
	return computed;
}

/** Serialize fused operations for one canonical file path. */
export async function withFusedFileQueue<T>(filePath: string, work: () => Promise<T>): Promise<T> {
	const key = await canonicalQueueKeyShared(filePath);
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
