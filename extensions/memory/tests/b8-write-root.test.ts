import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { isMemoryWritePath, memoryWriteRoots } from "../paths.ts";

const dir = mkdtempSync(join(tmpdir(), "b8-"));
after(() => rmSync(dir, { recursive: true, force: true }));

function projectRoot(home: string, cwd: string): string {
	return join(home, ".pi", "agent", "projects", cwd.replace(/[/\\]/g, "-"), "memory");
}

describe("B8 isMemoryWritePath realpath tightening", () => {
	it("B8-2: an alias INSIDE a write root pointing OUTSIDE does not ride the carve-out (fail-closed)", () => {
		const home = join(dir, "home");
		const root = projectRoot(home, join(dir, "project"));
		mkdirSync(root, { recursive: true });
		const outside = join(dir, "outside");
		mkdirSync(outside, { recursive: true });
		const alias = join(root, "escape.md");
		symlinkSync(join(outside, "target.md"), alias);
		assert.equal(isMemoryWritePath(alias, join(dir, "project"), home), false);
	});

	it("B8-2b: an alias with an EXISTING outside target is also denied (the real escape shape)", () => {
		const home = join(dir, "home5");
		const root = projectRoot(home, join(dir, "project5"));
		mkdirSync(root, { recursive: true });
		const outside = join(dir, "outside5");
		mkdirSync(outside, { recursive: true });
		const target = join(outside, "target.md");
		writeFileSync(target, "x");
		const alias = join(root, "escape5.md");
		symlinkSync(target, alias);
		assert.equal(isMemoryWritePath(alias, join(dir, "project5"), home), false);
	});

	it("B8-3a: a real file inside the project root keeps the carve-out", () => {
		const home = join(dir, "home2");
		const root = projectRoot(home, join(dir, "project2"));
		mkdirSync(root, { recursive: true });
		const real = join(root, "note.md");
		writeFileSync(real, "x");
		assert.equal(isMemoryWritePath(real, join(dir, "project2"), home), true);
	});

	it("B8-3b: a NOT-YET-EXISTING new memory file resolves via its nearest existing ancestor (no approval regression)", () => {
		const home = join(dir, "home3");
		const root = projectRoot(home, join(dir, "project3"));
		mkdirSync(root, { recursive: true });
		const fresh = join(root, "brand-new.md");
		assert.equal(isMemoryWritePath(fresh, join(dir, "project3"), home), true);
	});

	it("B8-3c: an unresolvable path (root gone) falls back to the approval path", () => {
		const home = join(dir, "home4");
		const root = projectRoot(home, join(dir, "project4"));
		mkdirSync(root, { recursive: true });
		const ghost = join(root, "ghost");
		symlinkSync(join(dir, "nowhere"), ghost);
		assert.equal(isMemoryWritePath(ghost, join(dir, "project4"), home), false);
	});

	it("roots helper sanity: only the project layer surfaces (the retired user dir is not a write root)", () => {
		const roots = memoryWriteRoots(join(dir, "proj"), join(dir, "h"));
		assert.equal(roots.length, 1);
		assert.equal(roots[0], projectRoot(join(dir, "h"), join(dir, "proj")));
	});
});
