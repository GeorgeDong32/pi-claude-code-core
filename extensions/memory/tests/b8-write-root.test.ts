/**
 * B8 (cherry-batch2 spec): isMemoryWritePath realpath tightening + the
 * guard-layer lexical conservatism pin. The carve-out is an ALLOWANCE —
 * an alias symlink pointing outside a write root must NOT ride it; a
 * real inside write (and a not-yet-existing new file under a real root)
 * must keep the carve-out (no regression to approval prompts).
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { isMemoryWritePath, memoryWriteRoots } from "../paths.ts";

const dir = mkdtempSync(join(tmpdir(), "b8-"));
after(() => rmSync(dir, { recursive: true, force: true }));

describe("B8 isMemoryWritePath realpath tightening", () => {
	it("B8-2: an alias INSIDE a write root pointing OUTSIDE does not ride the carve-out (fail-closed)", () => {
		const home = join(dir, "home");
		const userRoot = join(home, ".pi", "agent", "memory");
		mkdirSync(userRoot, { recursive: true });
		const outside = join(dir, "outside");
		mkdirSync(outside, { recursive: true });
		const alias = join(userRoot, "escape.md");
		symlinkSync(join(outside, "target.md"), alias);
		// lexical match says inside; realpath says outside → carve-out denied
		assert.equal(isMemoryWritePath(alias, join(dir, "project"), home), false);
	});

	it("B8-2b: an alias with an EXISTING outside target is also denied (the real escape shape)", () => {
		const home = join(dir, "home5");
		const userRoot = join(home, ".pi", "agent", "memory");
		mkdirSync(userRoot, { recursive: true });
		const outside = join(dir, "outside5");
		mkdirSync(outside, { recursive: true });
		const target = join(outside, "target.md");
		writeFileSync(target, "x");
		const alias = join(userRoot, "escape5.md");
		symlinkSync(target, alias);
		assert.equal(isMemoryWritePath(alias, join(dir, "project5"), home), false);
	});

	it("B8-3a: a real file inside the user root keeps the carve-out", () => {
		const home = join(dir, "home2");
		const userRoot = join(home, ".pi", "agent", "memory");
		mkdirSync(userRoot, { recursive: true });
		const real = join(userRoot, "note.md");
		writeFileSync(real, "x");
		assert.equal(isMemoryWritePath(real, join(dir, "project2"), home), true);
	});

	it("B8-3b: a NOT-YET-EXISTING new memory file resolves via its nearest existing ancestor (no approval regression)", () => {
		const home = join(dir, "home3");
		const userRoot = join(home, ".pi", "agent", "memory");
		mkdirSync(userRoot, { recursive: true });
		const fresh = join(userRoot, "brand-new.md");
		assert.equal(isMemoryWritePath(fresh, join(dir, "project3"), home), true);
	});

	it("B8-3c: an unresolvable path (root gone) falls back to the approval path", () => {
		const home = join(dir, "home4");
		const userRoot = join(home, ".pi", "agent", "memory");
		mkdirSync(userRoot, { recursive: true });
		const ghost = join(userRoot, "ghost");
		symlinkSync(join(dir, "nowhere"), ghost); // dangling alias
		assert.equal(isMemoryWritePath(ghost, join(dir, "project4"), home), false);
	});

	it("roots helper sanity: both layers surface", () => {
		const roots = memoryWriteRoots(join(dir, "proj"), join(dir, "h"));
		assert.equal(roots.length, 2);
	});
});
