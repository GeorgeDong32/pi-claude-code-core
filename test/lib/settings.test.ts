/**
 * P0-LB-01 / P0-LB-04 — lib/settings.ts unit tests.
 * Equivalence cases compare against the old per-package implementations
 * (pi-effort readSettingsObject / writeSettingsObject format) plus
 * boundary cases for the merged never-throw read contract.
 *
 * The retired source package moved to ../archive/repos (2026-09-30); the
 * live old-implementation import became a frozen golden — the concrete
 * expectations below already encode its behaviour.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readJson, writeJsonAtomic } from "../../lib/settings.ts";
let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "core-lib-settings-"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("P0-LB-01 readJson", () => {
	it("returns fallback for a missing file (golden: effort readSettingsObject → {})", () => {
		const p = join(dir, "missing.json");
		expect(readJson(p, { a: 1 })).toEqual({ a: 1 });
	});

	it("parses a valid object file identically to the old implementation", () => {
		const p = join(dir, "settings.json");
		writeFileSync(p, JSON.stringify({ "pi-effort": { fastMode: true }, n: 3 }, null, 2));
		expect(readJson<{ "pi-effort"?: { fastMode?: boolean }; n?: number }>(p, {})).toEqual({
			"pi-effort": { fastMode: true },
			n: 3,
		});
	});

	it("returns fallback for an empty file", () => {
		const p = join(dir, "empty.json");
		writeFileSync(p, "   \n");
		expect(readJson(p, { fallback: true })).toEqual({ fallback: true });
	});

	it("returns fallback for malformed JSON (never throws)", () => {
		const p = join(dir, "bad.json");
		writeFileSync(p, "{ not json");
		expect(readJson(p, { fallback: true })).toEqual({ fallback: true });
	});

	it("returns fallback for non-object JSON (array / string / null)", () => {
		for (const content of ["[1,2]", '"str"', "null"]) {
			const p = join(dir, `arr-${content.length}.json`);
			writeFileSync(p, content);
			expect(readJson(p, { fallback: true })).toEqual({ fallback: true });
		}
	});
});

describe("P0-LB-01 writeJsonAtomic", () => {
	it("writes pretty JSON with 2-space indent and trailing newline (old format equivalence)", () => {
		const p = join(dir, "settings.json");
		writeJsonAtomic(p, { b: 2, a: { c: 1 } });
		expect(readFileSync(p, "utf-8")).toBe(`${JSON.stringify({ b: 2, a: { c: 1 } }, null, 2)}\n`);
	});

	it("round-trips through readJson", () => {
		const p = join(dir, "settings.json");
		writeJsonAtomic(p, { "pi-effort": { fastMode: true } });
		expect(readJson<{ "pi-effort"?: { fastMode?: boolean } }>(p, {})).toEqual({
			"pi-effort": { fastMode: true },
		});
	});

	it("creates missing parent directories", () => {
		const p = join(dir, "nested", "deep", "settings.json");
		writeJsonAtomic(p, { ok: true });
		expect(existsSync(p)).toBe(true);
	});

	it("leaves the original file untouched and removes the temp file when the write fails", () => {
		const p = join(dir, "settings.json");
		writeJsonAtomic(p, { original: true });
		// Make the target path a directory: rename onto it must fail.
		rmSync(p);
		mkdirSync(p);
		expect(() => writeJsonAtomic(p, { broken: true })).toThrow();
		const leftovers = readdirSync(dir).filter((f) => f.includes(".tmp."));
		expect(leftovers).toEqual([]);
		rmSync(p, { recursive: true });
		writeJsonAtomic(p, { original: true });
		expect(readJson(p, {})).toEqual({ original: true });
	});
});
