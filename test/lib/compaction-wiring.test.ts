/**
 * Wiring & invariant scans (SPEC SC §5.10 ST-06, INV-2/3, FB-06, APP-04③;
 * task W4).
 *
 * Requirement → test map:
 *   ST-06  → assembly line contains compactionController between memory and
 *            the ccPanels/economy block (source-order scan of index.ts)
 *   INV-2  → no setInterval / recursive setTimeout in extensions/compaction
 *            (the ONE fallback deadline timer is a single non-recursive
 *            setTimeout, whitelisted by pattern)
 *   INV-3  → compaction never calls setThinkingLevel
 *   FB-06  → no "cancel" return anywhere in the compaction module
 *   APP-04③→ no other core module produces compaction/context_edit boundary
 *            drafts (source scan outside extensions/compaction)
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const root = join(__dirname, "..", "..");

function collectTsFiles(dir: string, out: string[] = []): string[] {
	for (const name of readdirSync(dir)) {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) {
			if (name === "tests" || name === "node_modules") continue;
			collectTsFiles(path, out);
		} else if (name.endsWith(".ts")) {
			out.push(path);
		}
	}
	return out;
}

const compactionFiles = collectTsFiles(join(root, "extensions", "compaction"));

describe("ST-06 assembly", () => {
	it("compactionController sits after memory and before ccPanels/economy", () => {
		const source = readFileSync(join(root, "extensions", "index.ts"), "utf-8");
		const memoryAt = source.indexOf("memoryExtension,");
		const compactionAt = source.indexOf("compactionController,");
		const panelsAt = source.indexOf("function ccPanels");
		const economyAt = source.indexOf("function economy");
		expect(compactionAt).toBeGreaterThan(memoryAt);
		expect(compactionAt).toBeLessThan(panelsAt);
		expect(compactionAt).toBeLessThan(economyAt);
	});
});

describe("INV-2 no timers/polling", () => {
	it("extensions/compaction has no setInterval and no recursive setTimeout", () => {
		for (const file of compactionFiles) {
			const source = readFileSync(file, "utf-8");
			expect(source, `${file}: setInterval`).not.toContain("setInterval");
			// The two one-shot fallback deadline timers (wait + regenerate) —
			// C6 (2026-11-10 review): exactly 2 setTimeout CALLS in index.ts,
			// zero elsewhere; both are cleared after their race (C1).
			const timerUses = source.match(/setTimeout\(/g) ?? [];
			const recursive = /setTimeout\([^)]*\)\s*[;)].*setTimeout/s.test(source);
			expect(recursive, `${file}: recursive setTimeout`).toBe(false);
			if (timerUses.length > 0) {
				expect(file.endsWith("index.ts"), `${file}: timers only allowed in the fallback wiring`).toBe(true);
				expect(timerUses.length, `${file}: expected exactly 2 setTimeout calls`).toBe(2);
			}
		}
	});
});

describe("INV-3 thinking ownership", () => {
	it("the compaction module never calls setThinkingLevel", () => {
		for (const file of compactionFiles) {
			const source = readFileSync(file, "utf-8");
			expect(source, `${file}`).not.toMatch(/\.setThinkingLevel\(/);
		}
	});
});

describe("FB-06 no cancel path", () => {
	it("extensions/compaction contains no cancel return", () => {
		for (const file of compactionFiles) {
			const source = readFileSync(file, "utf-8");
			// Comments may say "never cancels"; the RETURN SHAPE may not exist.
			expect(/\{\s*cancel|cancel\s*:/.test(source), `${file}: cancel return shape`).toBe(false);
		}
	});
});

describe("APP-04③ core-wide draft exclusivity", () => {
	it("no module outside extensions/compaction produces compaction/context_edit boundary drafts", () => {
		const scanned: Array<[string, string]> = [];
		for (const dir of ["extensions", "lib"]) {
			for (const file of collectTsFiles(join(root, dir))) {
				if (file.includes(join("extensions", "compaction"))) continue;
				if (file.endsWith(".test.ts")) continue;
				scanned.push([file, readFileSync(file, "utf-8")]);
			}
		}
		for (const [file, source] of scanned) {
			// A boundary DRAFT would be a returned object with
			// type:"compaction" or type:"context_edit" — the seam/types
			// mentions are fine; string literals in handler returns are not.
			expect(source, `${file}: compaction draft`).not.toMatch(/type:\s*"compaction"/);
			expect(source, `${file}: context_edit draft`).not.toMatch(/type:\s*"context_edit"/);
		}
	});
});
