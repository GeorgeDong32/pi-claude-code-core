/*
 * Tool-path resolution for the fused tools (arch B6 — moved out of
 * file-queue.ts: this is path knowledge, not queue mechanics).
 * Ported from NVlabs/SoL-Pi (MIT).
 */
import { homedir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

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
