import { closeSync, constants as fsConstants, fstatSync, openSync, readSync } from "node:fs";

export interface CommittedLines {
	lines: unknown[];
	committedBytes: number;
	tornTailBytes: number;
	badLines: number;
}

export type LiveReadError =
	| { kind: "vanished" }
	| { kind: "symlink" }
	| { kind: "shrunk" }
	| { kind: "oversized" }
	| { kind: "unstable" };

export const LIVE_JSONL_MAX_BYTES = 8 * 1024 * 1024;

export function readCommittedLines(path: string, opts?: { maxBytes?: number }): CommittedLines {
	const maxBytes = opts?.maxBytes ?? LIVE_JSONL_MAX_BYTES;
	let fd: number;
	try {
		// O_NOFOLLOW guards the FINAL path component; errno ELOOP (macOS &
		// Linux) maps to the symlink kind.
		fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
	} catch (err) {
		throw mapOpenError(err);
	}
	try {
		return readFromFd(fd, maxBytes);
	} finally {
		try {
			closeSync(fd);
		} catch {
		}
	}
}

function mapOpenError(err: unknown): LiveReadError {
	const code = (err as { code?: string }).code;
	if (code === "ELOOP" || code === "EMLINK") return { kind: "symlink" };
	if (code === "ENOENT") return { kind: "vanished" };
	throw err instanceof Error ? err : new Error(`live-jsonl open failed: ${String(err)}`);
}

function readFromFd(fd: number, maxBytes: number): CommittedLines {
	const before = fstatSync(fd);
	if (!before.isFile()) throw { kind: "symlink" } satisfies LiveReadError;
	if (before.size > maxBytes) throw { kind: "oversized" } satisfies LiveReadError;

	const first = readAll(fd, maxBytes);
	const after = fstatSync(fd);
	if (after.dev !== before.dev || after.ino !== before.ino) {
		throw { kind: "unstable" } satisfies LiveReadError;
	}
	if (after.size < before.size) {
		throw { kind: "shrunk" } satisfies LiveReadError;
	}
	const second = readAll(fd, maxBytes);
	if (!prefixMatches(first, second)) {
		const retry = readAll(fd, maxBytes);
		if (!prefixMatches(first, retry)) {
			throw { kind: "unstable" } satisfies LiveReadError;
		}
	}

	const buf = first;
	const lastNewline = buf.lastIndexOf(0x0a);
	const committedBytes = lastNewline < 0 ? 0 : lastNewline + 1;
	const tornTailBytes = buf.length - committedBytes;

	const lines: unknown[] = [];
	let badLines = 0;
	if (committedBytes > 0) {
		const text = buf.subarray(0, committedBytes).toString("utf8");
		for (const line of text.split("\n")) {
			if (line.trim().length === 0) continue;
			try {
				lines.push(JSON.parse(line.trim()));
			} catch {
				badLines += 1;
			}
		}
	}
	return { lines, committedBytes, tornTailBytes, badLines };
}

function readAll(fd: number, maxBytes: number): Buffer {
	const chunks: Buffer[] = [];
	let total = 0;
	const chunk = Buffer.allocUnsafe(64 * 1024);
	for (;;) {
		const n = readSync(fd, chunk, 0, chunk.length, total);
		if (n <= 0) break;
		chunks.push(Buffer.from(chunk.subarray(0, n)));
		total += n;
		if (total > maxBytes) {
			throw { kind: "oversized" } satisfies LiveReadError;
		}
	}
	return Buffer.concat(chunks, total);
}

export function prefixMatches(a: Buffer, b: Buffer): boolean {
	return b.length >= a.length && b.subarray(0, a.length).equals(a);
}
