/**
 * BH-R2 (spec 2026-11-14-backtest-hardening) — the secret probe is a
 * MEMORY-layer guard, not a global one:
 *
 *   - it runs ONLY when the target path is inside one of the memory layers
 *     (the 1618f89 G1 rewrite had dropped that limit — 12 false blocks in
 *     backtests, and models bypassed the block via bash);
 *   - an edit scans ONLY the incoming `edits[].newText` — a memory file
 *     whose EXISTING content contains secret-looking text must not block
 *     a clean edit (the whole-file `resultingContent` scan is C1/C3's
 *     business, not the probe's);
 *   - a write scans its content.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { guardMemoryToolCall, type MemoryGuardEnv } from "../guard.ts";

const home = mkdtempSync(join(tmpdir(), "bh-r2-home-"));
const project = mkdtempSync(join(tmpdir(), "bh-r2-proj-"));
after(() => {
	rmSync(home, { recursive: true, force: true });
	rmSync(project, { recursive: true, force: true });
});

const userDir = join(home, ".pi", "agent", "memory");
const projectDir = join(project, "memory");

const env = (over: Partial<MemoryGuardEnv> = {}): MemoryGuardEnv => ({
	projectDir,
	userDir,
	childSession: false,
	...over,
});

const SECRET = "api_key = sk-abcdef123456abcdef123456";

/** A valid, indexable memory document whose body carries the secret. */
const memoryWithSecret = `---\nname: leak\ndescription: d\nmetadata:\n  type: project\n---\n\nnote line\n${SECRET}\n`;
/** Same shape, clean body. */
const memoryClean = `---\nname: clean\ndescription: d\nmetadata:\n  type: project\n---\n\nnote line\n`;

describe("BH-R2: the secret probe only guards memory-layer targets", () => {
	it("a write with secret-looking content OUTSIDE the memory layers is not blocked", () => {
		mkdirSync(join(project, "src"), { recursive: true });
		const verdict = guardMemoryToolCall("write", { path: join(project, "src", "config.txt"), content: SECRET }, env());
		assert.equal(verdict.block, false);
	});

	it("an edit with a secret-bearing newText OUTSIDE the memory layers is not blocked", () => {
		const file = join(project, "src", "notes.txt");
		writeFileSync(file, "plain\n");
		const verdict = guardMemoryToolCall("edit", { path: file, edits: [{ oldText: "plain", newText: SECRET }] }, env());
		assert.equal(verdict.block, false);
	});

	it("an ordinary secret-bearing file outside the layers keeps passing (C2 unaffected: not memory-shaped)", () => {
		const verdict = guardMemoryToolCall("write", { path: join(project, "report.md"), content: SECRET }, env());
		assert.equal(verdict.block, false);
	});

	it("a write with secret-looking content INTO a memory file is still blocked", () => {
		const verdict = guardMemoryToolCall("write", { path: join(projectDir, "leak.md"), content: memoryWithSecret }, env());
		assert.equal(verdict.block, true);
		assert.match(verdict.reason ?? "", /looks like a/);
	});

	it("an edit whose newText carries a secret into a memory file is still blocked", () => {
		mkdirSync(projectDir, { recursive: true });
		const file = join(projectDir, "edit-leak.md");
		writeFileSync(file, memoryClean);
		const verdict = guardMemoryToolCall("edit", {
			path: file,
			edits: [{ oldText: "note line", newText: `note line\n${SECRET}` }],
		}, env());
		assert.equal(verdict.block, true);
		assert.match(verdict.reason ?? "", /looks like a/);
	});
});

describe("BH-R2: edits scan only newText, not the whole resulting file", () => {
	it("a memory file whose EXISTING content contains a secret passes a clean edit", () => {
		mkdirSync(projectDir, { recursive: true });
		const file = join(projectDir, "preexisting.md");
		writeFileSync(file, memoryWithSecret);
		const verdict = guardMemoryToolCall("edit", {
			path: file,
			edits: [{ oldText: "note line", newText: "note line, clarified" }],
		}, env());
		assert.equal(verdict.block, false, `clean edit of a secret-bearing file must pass, got: ${verdict.reason ?? ""}`);
	});

	it("a clean memory write still passes (control)", () => {
		const verdict = guardMemoryToolCall("write", { path: join(projectDir, "ok.md"), content: memoryClean }, env());
		assert.equal(verdict.block, false);
	});
});
