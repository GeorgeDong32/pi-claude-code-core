/**
 * test/lib/live-jsonl.test.ts — [cherry-batch1 B2-1..9] the committed-prefix
 * reader's nine shapes (spec §B2 test matrix): normal / torn tail /
 * concurrent append / shrunk / symlink (ELOOP) / oversized / bad lines /
 * vanished / unstable.
 */
import { appendFileSync, mkdtempSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { prefixMatches, readCommittedLines } from "../../lib/live-jsonl.ts";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "live-jsonl-"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

const line = (obj: unknown) => `${JSON.stringify(obj)}\n`;

describe("readCommittedLines (B2)", () => {
	it("B2-1 normal read: complete lines parse; committedBytes counts the newline", () => {
		const p = join(dir, "a.jsonl");
		writeFileSync(p, line({ i: 1 }) + line({ i: 2 }) + line({ i: 3 }));
		const r = readCommittedLines(p);
		expect(r.lines).toEqual([{ i: 1 }, { i: 2 }, { i: 3 }]);
		expect(r.committedBytes).toBe(3 * line({ i: 1 }).length);
		expect(r.tornTailBytes).toBe(0);
		expect(r.badLines).toBe(0);
	});

	it("B2-2 torn tail: a half-line at EOF is dropped and counted, never thrown", () => {
		const p = join(dir, "b.jsonl");
		const full = line({ i: 1 });
		writeFileSync(p, full + '{"i":2,"partial":');
		const r = readCommittedLines(p);
		expect(r.lines).toEqual([{ i: 1 }]);
		expect(r.tornTailBytes).toBe('{"i":2,"partial":'.length);
	});

	it("B2-3 concurrent append: growth past committedBytes is tolerated (the prefix as of the read)", () => {
		const p = join(dir, "c.jsonl");
		writeFileSync(p, line({ i: 1 }));
		// simulate an append that lands between two reads is inherently racy;
		// the deterministic property we pin: a file that GREW after our first
		// read still yields a complete committed prefix (old or new, never torn)
		appendFileSync(p, line({ i: 2 }));
		const r = readCommittedLines(p);
		expect(r.lines).toEqual([{ i: 1 }, { i: 2 }]);
		expect(r.tornTailBytes).toBe(0);
	});

	it("B2-4 shrink window: a post-truncate file reads as its new self-consistent content (the mid-read guard is cross-process only)", () => {
		const p = join(dir, "d.jsonl");
		writeFileSync(p, line({ big: "x".repeat(200_000) }) + line({ i: 2 }));
		truncateSync(p, 10);
		const r = readCommittedLines(p);
		// Node reads are synchronous within one process — the shrunk guard can
		// only fire when ANOTHER process truncates between our two fstats.
		// What is deterministic here: the truncated file yields its new
		// self-consistent prefix (the first 10 bytes, torn tail dropped).
		expect(r.committedBytes).toBeLessThanOrEqual(10);
		expect(r.tornTailBytes + r.committedBytes).toBe(10);
	});

	it("B2-5 symlink: O_NOFOLLOW → ELOOP → {kind:'symlink'} (macOS & Linux)", () => {
		const target = join(dir, "real.jsonl");
		writeFileSync(target, line({ i: 1 }));
		const link = join(dir, "link.jsonl");
		symlinkSync(target, link);
		expect(() => readCommittedLines(link)).toThrowError(expect.objectContaining({ kind: "symlink" }));
	});

	it("B2-6 oversized: beyond maxBytes → {kind:'oversized'}", () => {
		const p = join(dir, "e.jsonl");
		writeFileSync(p, "x".repeat(1024));
		expect(() => readCommittedLines(p, { maxBytes: 512 })).toThrowError(
			expect.objectContaining({ kind: "oversized" }),
		);
	});

	it("B2-7 bad lines: JSON.parse failures are skipped and counted, never thrown", () => {
		const p = join(dir, "f.jsonl");
		writeFileSync(p, line({ i: 1 }) + "not json at all\n" + line({ i: 2 }));
		const r = readCommittedLines(p);
		expect(r.lines).toEqual([{ i: 1 }, { i: 2 }]);
		expect(r.badLines).toBe(1);
	});

	it("B2-8 vanished: ENOENT → {kind:'vanished'} (thrown; the consumer maps to empty)", () => {
		expect(() => readCommittedLines(join(dir, "missing.jsonl"))).toThrowError(
			expect.objectContaining({ kind: "vanished" }),
		);
	});

	it("B2-3b prefix two-state pin (R1 P1-1 / R2 P2-A): append tolerated, rewrite rejected — reverting to whole-buffer compare turns this red", () => {
		const a = Buffer.from(line({ i: 1 }));
		const appended = Buffer.concat([a, Buffer.from(line({ i: 2 }))]); // concurrent append: longer, same prefix
		const rewritten = Buffer.concat([Buffer.from(line({ i: 9 })), a.subarray(line({ i: 1 }).length)]); // same span, different bytes
		expect(prefixMatches(a, appended)).toBe(true); // tolerated — never unstable
		expect(prefixMatches(a, rewritten)).toBe(false); // rejected — unstable path
		expect(prefixMatches(a, a)).toBe(true);
		expect(prefixMatches(appended, a)).toBe(false); // second shorter than first: fail (shrunk window labels as unstable — recorded P3-A)
	});

	it("B2-9 stable double-read: an untouched file passes the byte comparison (the common path)", () => {
		const p = join(dir, "g.jsonl");
		writeFileSync(p, line({ i: 1 }) + line({ i: 2 }));
		const r = readCommittedLines(p);
		expect(r.lines).toEqual([{ i: 1 }, { i: 2 }]);
		expect(r.badLines).toBe(0);
		expect(r.tornTailBytes).toBe(0);
	});

	it("B2-9b rewrite-between-calls: an in-place rewrite yields the NEW self-consistent content (the unstable guard's cross-process window is documented, not single-process-simulatable)", () => {
		const p = join(dir, "h.jsonl");
		writeFileSync(p, line({ i: 1 }));
		writeFileSync(p, line({ i: 9 })); // same length, different bytes
		const r = readCommittedLines(p);
		expect(r.lines).toEqual([{ i: 9 }]);
	});
});
