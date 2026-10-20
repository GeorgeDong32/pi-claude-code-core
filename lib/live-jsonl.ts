/**
 * lib/live-jsonl.ts — [cherry-batch1 B2] committed-prefix reads of live
 * append-only JSONL files (spec docs/{en,zh}/cherry-batch1-spec.md).
 *
 * Cherry-derived (readForkPrefix lineage), Node form. A live JSONL (the
 * goal ledger is the production consumer) can be appended to by another
 * process while we read: the guarantee is "the complete committed prefix
 * as of the read" — torn half-lines are DROPPED and counted (fail-open),
 * never thrown; what upstream tolerates, we count, never silently drop.
 *
 * Fail-closed surfaces (closed error kind): symlink targets (path
 * injection — errno ELOOP on macOS and Linux alike for O_NOFOLLOW),
 * oversized files, mid-read shrink, and an unstable double-read (same
 * inode truncated + rewritten longer between the two reads — invisible
 * to fstat, caught only by the byte comparison).
 */

import { closeSync, constants as fsConstants, fstatSync, openSync, readSync } from "node:fs";

export interface CommittedLines {
	/** Complete lines, each JSON.parse re-validated; bad lines skipped (see badLines). */
	lines: unknown[];
	/** Bytes before the last complete newline that were consumed. */
	committedBytes: number;
	/** Dropped half-line bytes at the tail (counted, not thrown). */
	tornTailBytes: number;
	/** Lines whose JSON.parse failed — skipped and counted, never thrown. */
	badLines: number;
}

export type LiveReadError =
	| { kind: "vanished" }
	| { kind: "symlink" }
	| { kind: "shrunk" }
	| { kind: "oversized" }
	| { kind: "unstable" };

/** Default read cap: 8 MB — the goal ledger is far below this; a runaway
 *  file is a bug we want surfaced, not buffered. */
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
			/* best effort */
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
	// Bytes double-read TOCTOU re-check: same-inode truncate-and-rewrite-longer
	// keeps dev/ino and can grow size — only the byte comparison catches it.
	// PREFIX comparison (spec): a concurrent append is TOLERATED — the second
	// read may be longer; what must match is the first read's own span. Only
	// when the same bytes were rewritten in place (prefix mismatch) do we
	// retry once and then throw unstable.
	const second = readAll(fd, maxBytes);
	if (!prefixMatches(first, second)) {
		const retry = readAll(fd, maxBytes);
		if (!prefixMatches(first, retry)) {
			throw { kind: "unstable" } satisfies LiveReadError;
		}
	}

	// Committed prefix: up to (not including) the last complete newline.
	const buf = first;
	const lastNewline = buf.lastIndexOf(0x0a);
	const committedBytes = lastNewline < 0 ? 0 : lastNewline + 1;
	const tornTailBytes = buf.length - committedBytes;

	const lines: unknown[] = [];
	let badLines = 0;
	if (committedBytes > 0) {
		const text = buf.subarray(0, committedBytes).toString("utf8");
		for (const line of text.split("\n")) {
			if (line.trim().length === 0) continue; // whitespace-only lines: skip, not malformed
			try {
				// trim before parse: a hand-edited first line may carry a BOM (U+FEFF)
				lines.push(JSON.parse(line.trim()));
			} catch {
				badLines += 1;
			}
		}
	}
	return { lines, committedBytes, tornTailBytes, badLines };
}

/** Reads the file from absolute offset 0 to EOF (explicit positions — the
 *  fd's own position may be anywhere after a prior pass). The maxBytes cap
 *  also guards the read loop: a file that grows past the cap mid-read (the
 *  pre-read fstat gate is already behind us) throws oversized instead of
 *  buffering without bound. */
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

/** True when `b` starts with exactly the bytes of `a` (a concurrent append
 *  makes b longer — tolerated; a rewrite of the same span makes it differ).
 *  Exported for the two-state regression pin (R2 P2-A): reverting the
 *  prefix compare to a whole-buffer equals must turn tests red. */
export function prefixMatches(a: Buffer, b: Buffer): boolean {
	return b.length >= a.length && b.subarray(0, a.length).equals(a);
}
