import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import * as fs from "node:fs";import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	clearCachedReads,
	readJson,
	readJsonCached,
	writeJsonAtomic,
} from "../../lib/settings";

// C1 (arch review 2026-10-18): the mtime-keyed cached read primitive.
// Contract pinned here:
//   1. same-mtime re-reads share one object (no second readFileSync)
//   2. an mtime change is a miss
//   3. writeJsonAtomic drops the entry (same-millisecond rewrites)
//   4. a missing file returns the fallback and drops any stale entry
//   5. throwing onInvalid guards re-report on every call (never cached)
//   6. plain readJson stays uncached

let dir: string;
let path: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "settings-cache-"));
	path = join(dir, "settings.json");
	clearCachedReads();
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
	clearCachedReads();
	vi.restoreAllMocks();
});

describe("readJsonCached", () => {
	it("serves repeated reads of an unchanged file from the cache — mtime is the key", () => {
		writeJsonAtomic(path, { a: 1 });
		// APFS keeps nanosecond mtimes; utimesSync only restores whole
		// milliseconds — normalize first so the restore below is exact.
		const t0 = new Date(Math.floor(fs.statSync(path).mtimeMs));
		utimesSync(path, t0, t0);
		const st = fs.statSync(path);
		const first = readJsonCached<{ a: number }>(path, { a: 0 });
		// rewrite the CONTENT but restore the exact mtime: a pure mtime-keyed
		// cache must keep serving the cached object (pins the key semantics
		// without spying on the frozen node:fs namespace)
		writeFileSync(path, JSON.stringify({ a: 99 }));
		utimesSync(path, st.atime, st.mtime);
		expect(readJsonCached<{ a: number }>(path, { a: 0 })).toBe(first);
		// and once the mtime moves, the new content shows up
		const later = new Date(st.mtimeMs + 2000);
		utimesSync(path, later, later);
		expect(readJsonCached<{ a: number }>(path, { a: 0 }).a).toBe(99);
	});

	it("re-reads when the mtime changes", async () => {
		writeJsonAtomic(path, { a: 1 });
		expect(readJsonCached<{ a: number }>(path, { a: 0 }).a).toBe(1);
		writeJsonAtomic(path, { a: 2 });
		expect(readJsonCached<{ a: number }>(path, { a: 0 }).a).toBe(2);
	});

	it("writeJsonAtomic invalidates even within the same mtime millisecond", () => {
		writeJsonAtomic(path, { a: 1 });
		const before = readJsonCached<{ a: number }>(path, { a: 0 });
		writeJsonAtomic(path, { a: 2 }); // same ms is the norm on fast disks
		const after = readJsonCached<{ a: number }>(path, { a: 0 });
		expect(after).not.toBe(before);
		expect(after.a).toBe(2);
	});

	it("falls back and drops the entry when the file disappears", () => {
		writeJsonAtomic(path, { a: 1 });
		readJsonCached<{ a: number }>(path, { a: 0 });
		rmSync(path);
		expect(readJsonCached<{ a: number }>(path, { a: 0 }).a).toBe(0);
	});

	it("never caches a throwing onInvalid guard — it re-reports every call", () => {
		writeFileSync(path, "not json");
		const guard = (reason: string) => {
			if (reason === "malformed") throw new Error("corrupt");
		};
		expect(() => readJsonCached(path, { a: 0 }, guard)).toThrow("corrupt");
		expect(() => readJsonCached(path, { a: 0 }, guard)).toThrow("corrupt");
	});

	it("plain readJson stays uncached", () => {
		writeJsonAtomic(path, { a: 1 });
		const a = readJson<{ a: number }>(path, { a: 0 });
		const b = readJson<{ a: number }>(path, { a: 0 });
		expect(b).not.toBe(a); // fresh object every time, as before
	});
});
