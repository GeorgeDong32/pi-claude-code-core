
import { openSync, readSync, closeSync, fstatSync } from "node:fs";
import { open } from "node:fs/promises";
import { readdir } from "node:fs/promises";
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
	project?: string;
	since?: string;
	until?: string;
	limit?: number;
	home?: string;
	cwd?: string;
	deps?: RecallDeps;
}

export interface RecallResult {
	hits: RecallHit[];
	scannedFiles: number;
	skippedLines: number;
	truncatedSizeFiles: number;
	budgetExhausted: boolean;
	bytesScanned: number;
}

export const MAX_FILES_PER_QUERY = 200;
export const MAX_BYTES_PER_FILE = 1024 * 1024;
export const MAX_TOTAL_BYTES_PER_QUERY = 8 * 1024 * 1024;

export type BoundedLineReader = (
	path: string,
	byteCap: number,
) => AsyncGenerator<{ line: string; number: number }, { bytes: number; truncated: boolean }>;

export interface RecallDeps {
	listSessionFiles?: (dir: string) => Promise<string[]>;
	readLinesBounded?: BoundedLineReader;
}

export const READ_CHUNK = 256 * 1024;

function utf8SafeEnd(buf: Buffer, bytes: number): number {
	let back = 0;
	while (back < 4 && back < bytes) {
		const b = buf[bytes - 1 - back];
		if (b < 0x80) break;
		if (b >= 0xc0) {
			back++;
			break;
		}
		back++;
	}
	return bytes - back;
}

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
				position += valid;
			} else {
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

export const readLinesBounded: BoundedLineReader = async function* (path, byteCap) {
	let handle: Awaited<ReturnType<typeof open>>;
	try {
		handle = await open(path, "r");
	} catch {
		return { bytes: 0, truncated: false };
	}
	try {
		const chunk = Buffer.alloc(Math.min(READ_CHUNK, Math.max(1, byteCap)));
		let buffer = "";
		let lineNumber = 0;
		let position = 0;
		let total = 0;
		let truncated = false;
		while (true) {
			let toRead = Math.min(chunk.length, byteCap - total);
			if (toRead <= 0) {
				const probe = Buffer.alloc(1);
				const { bytesRead } = await handle.read(probe, 0, 1, position);
				truncated = bytesRead > 0;
				break;
			}
			const { bytesRead } = await handle.read(chunk, 0, toRead, position);
			if (bytesRead <= 0) break;
			const valid = utf8SafeEnd(chunk, bytesRead);
			if (valid > 0) {
				buffer += chunk.toString("utf-8", 0, valid);
				position += valid;
				total += valid;
			} else {
				buffer += chunk.toString("utf-8", 0, bytesRead);
				position += bytesRead;
				total += bytesRead;
			}
			let idx: number;
			while ((idx = buffer.indexOf("\n")) !== -1) {
				const line = buffer.slice(0, idx);
				buffer = buffer.slice(idx + 1);
				lineNumber++;
				yield { line, number: lineNumber };
			}
		}
		if (buffer.length > 0 && !truncated) {
			lineNumber++;
			yield { line: buffer, number: lineNumber };
		}
		return { bytes: total, truncated };
	} finally {
		await handle.close();
	}
};

async function defaultListSessionFiles(dir: string): Promise<string[]> {
	try {
		return (await readdir(dir)).filter((f) => f.endsWith(".jsonl")).sort().reverse();
	} catch {
		return [];
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

export async function sessionRecall(options: RecallOptions): Promise<RecallResult> {
	const home = options.home;
	const cwd = options.project ?? options.cwd ?? process.cwd();
	const dir = sessionsDirFor(cwd, home);
	const tokens = options.query.toLowerCase().split(/\s+/).filter(Boolean);
	const limit = Math.min(Math.max(options.limit ?? 20, 1), 50);
	const since = parseBound(options.since);
	const until = parseBound(options.until, true);
	const listFiles = options.deps?.listSessionFiles ?? defaultListSessionFiles;
	const reader = options.deps?.readLinesBounded ?? readLinesBounded;

	const result: RecallResult = {
		hits: [],
		scannedFiles: 0,
		skippedLines: 0,
		truncatedSizeFiles: 0,
		budgetExhausted: false,
		bytesScanned: 0,
	};
	const files = await listFiles(dir);

	let budget = MAX_TOTAL_BYTES_PER_QUERY;
	for (const file of files) {
		if (result.hits.length >= limit) break;
		if (result.scannedFiles >= MAX_FILES_PER_QUERY) {
			result.budgetExhausted = true;
			break;
		}
		if (budget <= 0) {
			result.budgetExhausted = true;
			break;
		}
		result.scannedFiles++;
		const path = join(dir, file);
		const perFile = Math.min(MAX_BYTES_PER_FILE, budget);
		const iterator = reader(path, perFile);
		let meta: { bytes: number; truncated: boolean } = { bytes: 0, truncated: false };
		let finished = false;
		try {
			while (true) {
				const next = await iterator.next();
				if (next.done) {
					meta = next.value;
					finished = true;
					break;
				}
				const { line, number } = next.value;
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
				if (!tokens.every((t) => haystack.includes(t))) continue;
				result.hits.push({ file, line: number, role: text.role, text: text.text, timestamp: text.timestamp });
				if (result.hits.length >= limit) break;
			}
		} finally {
			if (!finished) await iterator.return(undefined as never);
		}
		budget -= meta.bytes;
		result.bytesScanned += meta.bytes;
		if (meta.truncated) result.truncatedSizeFiles++;
	}
	return result;
}

export function recallTransparencyLine(result: RecallResult): string {
	const parts = [
		`scanned=${result.scannedFiles}`,
		`truncated_size=${result.truncatedSizeFiles}`,
		`budget=${result.budgetExhausted ? "exhausted" : "ok"}`,
		`bytes=${result.bytesScanned}/${MAX_TOTAL_BYTES_PER_QUERY}`,
	];
	const advice = result.budgetExhausted ? " (scan stopped early — narrow the query or time range to reach older sessions)" : "";
	return `[${parts.join(" ")}]${advice}`;
}
