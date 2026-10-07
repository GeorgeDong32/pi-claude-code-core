/**
 * memory-writer.test.ts — SPEC 2026-10-07 P2-3 §5 acceptance: the document
 * write engine (write/remove/reindex) and the W4 project-identity split.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	removeDocument,
	reindex,
	serializeMemoryDocument,
	writeDocument,
} from "../../extensions/memory/writer.ts";
import { invalidateMemDirCache, parseMemoryFrontmatter, scanMemoryDirCached } from "../../extensions/memory/memdir.ts";
import { fullProjectKey, friendlyProjectHint } from "../../extensions/memory/paths.ts";
import { projectKeyForDir } from "../../extensions/memory/automation.ts";
import { projectKeyOf } from "../../extensions/memory/importers.ts";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "p23-writer-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("writer.write / remove / reindex (W-T1..T4)", () => {
	it("W-T1: remove makes the file invisible to scanMemoryDirCached IMMEDIATELY (no TTL wait)", () => {
		writeDocument(dir, "a.md", { kind: "memory", body: "body", meta: { name: "a", description: "d" } });
		expect(scanMemoryDirCached(dir).files.map((f) => f.entry.file)).toContain("a.md");
		removeDocument(dir, "a.md");
		const files = scanMemoryDirCached(dir).files.map((f) => f.entry.file);
		expect(files).not.toContain("a.md");
		// ENOENT idempotent
		expect(() => removeDocument(dir, "a.md")).not.toThrow();
	});

	it("W-T2: a write whose rename fails leaves no partial file at the target and no tmp residue", () => {
		// make the rename target occupied by a DIRECTORY — rename throws
		// (EISDIR/ENOTEMPTY) after the tmp content is written
		mkdirSync(join(dir, "b.md"));
		try {
			expect(() => writeDocument(dir, "b.md", { kind: "raw", text: "half-written" })).toThrow();
			// no tmp residue — the failed write cleaned up
			expect(readdirSync(dir).filter((f) => f.startsWith(".tmp-"))).toEqual([]);
			// the target is still the directory — never a half-written file
			const st = readdirSync(join(dir, "b.md"));
			expect(st).toEqual([]);
		} finally {
			rmSync(join(dir, "b.md"), { recursive: true, force: true });
		}
	});

	it("W-T3: a reindex failing to write keeps the OLD MEMORY.md and reports rewrote:false", () => {
		writeDocument(dir, "c.md", { kind: "memory", body: "x", meta: { name: "c", description: "d" } });
		expect(reindex(dir).rewrote).toBe(true);
		const oldIndex = readFileSync(join(dir, "MEMORY.md"), "utf-8");
		// make the index unwritable: replace MEMORY.md with a DIRECTORY
		rmSync(join(dir, "MEMORY.md"));
		mkdirSync(join(dir, "MEMORY.md"));
		const result = reindex(dir);
		expect(result.rewrote).toBe(false);
		rmSync(join(dir, "MEMORY.md"), { recursive: true });
		// after healing, the next reindex writes again (never cached as success)
		writeDocument(dir, "MEMORY.md", { kind: "raw", text: oldIndex });
		rmSync(join(dir, "MEMORY.md"));
		const healed = reindex(dir);
		expect(healed.rewrote).toBe(true);
	});

	it("W-T4: structured meta survives serialize→parse byte-faithfully; raw copies are byte-identical", () => {
		const meta = { name: "Title with-dash", description: 'has "quotes" and: colons', type: "feedback" };
		const body = "line1\nline2 with unicode 中文 🎉\n";
		const text = serializeMemoryDocument(body, meta);
		const parsed = parseMemoryFrontmatter(text)!;
		expect(parsed.title).toBe(meta.name);
		expect(parsed.description).toBe(meta.description);
		expect(parsed.type).toBe(meta.type);
		// body round-trip (trailing newline is the serializer's own)
		expect(text).toContain(body);
		// raw: byte-for-byte, unknown frontmatter fields preserved
		const exotic = "---\nname: x\nunknown_field: keep me\ndescription: d\nmetadata:\n  type: user\n---\n\nbody\n";
		writeDocument(dir, "exotic.md", { kind: "raw", text: exotic });
		expect(readFileSync(join(dir, "exotic.md"), "utf-8")).toBe(exotic);
	});
});

describe("project identity split (W-T5)", () => {
	it("fullProjectKey vs friendlyProjectHint produce the documented different results on synthetic paths", () => {
		const cases: Array<[string, string, string]> = [
			["/home/u/.pi/agent/projects/-Users-u-Coding-my-repo/memory", "-Users-u-Coding-my-repo", "repo"],
			["/home/u/.pi/agent/projects/-Users-u-Coding-my-repo", "-Users-u-Coding-my-repo", "repo"],
			["/h/.pi/agent/projects/short/memory", "short", "short"],
		];
		for (const [input, full, hint] of cases) {
			expect(fullProjectKey(input)).toBe(full);
			expect(friendlyProjectHint(input)).toBe(hint);
		}
	});

	it("fullProjectKey normalizes windows backslashes (raw string — no escaping chain)", () => {
		const win = String.raw`C:\u\projects\win-app\memory`;
		expect(fullProjectKey(win)).toBe("win-app");
	});

	it("the two legacy entry points keep their original results (equivalence pin)", () => {
		const dirs = [
			"/home/u/.pi/agent/projects/-Users-u-Coding-pi-extension-pi-claude-code-core/memory",
			"/x/.pi/agent/projects/my-repo/memory",
			"/x/.pi/agent/projects/ab/memory", // tail < 3 → projectKeyForDir undefined
		];
		expect(projectKeyForDir(dirs[0]!)).toBe("core");
		expect(projectKeyForDir(dirs[1]!)).toBe("repo");
		expect(projectKeyForDir(dirs[2]!)).toBeUndefined();
		expect(projectKeyOf(dirs[0]!)).toBe("-Users-u-Coding-pi-extension-pi-claude-code-core");
	});
});

describe("invalidateMemDirCache source discipline (W-T6)", () => {
	it("direct invalidateMemDirCache( calls appear only in writer and memdir", () => {
		const { execFileSync } = require("node:child_process") as typeof import("node:child_process");
		const out = execFileSync("grep", [
			"-rn", "invalidateMemDirCache(",
			"extensions/",
		], { encoding: "utf-8" });
		const offenders = out
			.split("\n")
			.filter(Boolean)
			.filter((line) => {
				const [file, , text] = line.split(":");
				if (file === "extensions/memory/writer.ts" || file === "extensions/memory/memdir.ts") return false;
				// comment-only mention: the call sits inside a comment
				const before = text.slice(0, text.indexOf("invalidateMemDirCache("));
				return !before.includes("//");
			});
		expect(offenders).toEqual([]);
	});
});
