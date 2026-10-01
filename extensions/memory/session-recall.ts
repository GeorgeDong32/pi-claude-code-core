/**
 * memory/session-recall.ts — the module's ONLY tool (P3-ME-07).
 *
 * Read-only search over pi session JSONL files for a cwd: AND-matched query
 * tokens against user/assistant TEXT blocks only (toolResult payloads are
 * excluded — huge and noisy). Streaming line reader: never loads a whole
 * session into memory; malformed lines are counted and skipped.
 */

import { openSync, readSync, closeSync, fstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { sessionsDirFor } from "./paths.ts";

export interface RecallHit {
	file: string;
	line: number;
	role: "user" | "assistant";
	text: string;
	timestamp?: string;
}

export interface RecallOptions {
	query: string;
	/** Defaults to the current cwd. */
	project?: string;
	/** ISO date or -Nd (N days ago). */
	since?: string;
	until?: string;
	limit?: number;
	home?: string;
	cwd?: string;
}

export interface RecallResult {
	hits: RecallHit[];
	scannedFiles: number;
	skippedLines: number;
}

export const READ_CHUNK = 256 * 1024;

/** Withhold a trailing incomplete UTF-8 sequence so a chunk boundary can
 * never split a multi-byte char into replacement characters. The scan may
 * look back 4 bytes: a 4-byte sequence (emoji) whose lead sits exactly at
 * bytes-4 must be seen whole or withheld whole — capping at 3 stranded it. */
function utf8SafeEnd(buf: Buffer, bytes: number): number {
	let back = 0;
	while (back < 4 && back < bytes) {
		const b = buf[bytes - 1 - back];
		if (b < 0x80) break; // ascii: everything before it is complete
		if (b >= 0xc0) {
			back++; // lead byte: its sequence does not fit in this chunk
			break;
		}
		back++; // continuation byte
	}
	return bytes - back;
}

/** Stream a file line by line without loading it whole. */
export function* readLines(path: string): Generator<{ line: string; number: number }> {
	let fd: number;
	try {
		fd = openSync(path, "r");
	} catch {
		return;
	}
	try {
		let buffer = "";
		let lineNumber = 0;
		let position = 0;
		const size = fstatSync(fd).size;
		const chunk = Buffer.alloc(READ_CHUNK);
		while (position < size) {
			const toRead = Math.min(READ_CHUNK, size - position);
			const bytes = readSync(fd, chunk, 0, toRead, position);
			if (bytes <= 0) break;
			const valid = utf8SafeEnd(chunk, bytes);
			if (valid > 0) {
				buffer += chunk.toString("utf-8", 0, valid);
				// advance only past the decoded bytes — the withheld tail is
				// re-read at the head of the next round and completes there
				position += valid;
			} else {
				// truncated sequence shorter than itself (malformed file
				// tail): decode as replacement chars and move on
				buffer += chunk.toString("utf-8", 0, bytes);
				position += bytes;
			}
			let idx: number;
			while ((idx = buffer.indexOf("\n")) !== -1) {
				const line = buffer.slice(0, idx);
				buffer = buffer.slice(idx + 1);
				lineNumber++;
				yield { line, number: lineNumber };
			}
		}
		if (buffer.length > 0) {
			lineNumber++;
			yield { line: buffer, number: lineNumber };
		}
	} finally {
		closeSync(fd);
	}
}

function parseBound(value: string | undefined, endOfDay = false): number | undefined {
	if (!value) return undefined;
	const rel = /^-(\d+)d$/.exec(value);
	let date: Date;
	if (rel) {
		date = new Date(Date.now() - Number(rel[1]) * 24 * 60 * 60 * 1000);
	} else {
		date = new Date(value);
		if (Number.isNaN(date.getTime())) return undefined;
	}
	if (endOfDay && !rel) date = new Date(date.getTime() + 24 * 60 * 60 * 1000 - 1);
	return date.getTime();
}

/** Extract searchable text blocks from one session entry (or null). */
function extractText(entry: Record<string, unknown>): { role: "user" | "assistant"; text: string; timestamp?: string } | null {
	if (entry.type !== "message") return null;
	const message = entry.message as Record<string, unknown> | undefined;
	if (!message) return null;
	const role = message.role;
	if (role !== "user" && role !== "assistant") return null;
	if (role === "user" && typeof message.content === "string") {
		return { role, text: message.content, timestamp: typeof entry.timestamp === "string" ? entry.timestamp : undefined };
	}
	if (!Array.isArray(message.content)) return null;
	const texts: string[] = [];
	for (const part of message.content as Array<Record<string, unknown>>) {
		if (part && part.type === "text" && typeof part.text === "string") {
			texts.push(part.text);
		}
	}
	if (texts.length === 0) return null;
	return { role, text: texts.join("\n"), timestamp: typeof entry.timestamp === "string" ? entry.timestamp : undefined };
}

/** Search sessions for the cwd. Total function: missing dir → friendly empty. */
export function sessionRecall(options: RecallOptions): RecallResult {
	const home = options.home;
	const cwd = options.project ?? options.cwd ?? process.cwd();
	const dir = sessionsDirFor(cwd, home);
	const tokens = options.query.toLowerCase().split(/\s+/).filter(Boolean);
	const limit = Math.min(Math.max(options.limit ?? 20, 1), 50);
	const since = parseBound(options.since);
	const until = parseBound(options.until, true);

	const result: RecallResult = { hits: [], scannedFiles: 0, skippedLines: 0 };
	let files: string[];
	try {
		files = readdirSync(dir).filter((f) => f.endsWith(".jsonl")).sort().reverse();
	} catch {
		return result; // missing sessions dir → friendly empty
	}

	for (const file of files) {
		if (result.hits.length >= limit) break;
		result.scannedFiles++;
		const path = join(dir, file);
		for (const { line, number } of readLines(path)) {
			if (!line.trim()) continue;
			let entry: Record<string, unknown>;
			try {
				entry = JSON.parse(line) as Record<string, unknown>;
			} catch {
				result.skippedLines++;
				continue;
			}
			const text = extractText(entry);
			if (!text) continue;
			const ts = text.timestamp ? new Date(text.timestamp).getTime() : undefined;
			if (since !== undefined && (ts === undefined || ts < since)) continue;
			if (until !== undefined && (ts === undefined || ts > until)) continue;
			const haystack = text.text.toLowerCase();
			// naive per-token AND `includes` — grep-style, NOT selection.ts's
			// tokenize/bigram engine (that one governs memory-recall qualification;
			// this governs session-history search — see the note there, B2)
			if (!tokens.every((t) => haystack.includes(t))) continue;
			result.hits.push({ file, line: number, role: text.role, text: text.text, timestamp: text.timestamp });
			if (result.hits.length >= limit) break;
		}
	}
	return result;
}
