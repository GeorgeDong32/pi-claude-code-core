/**
 * json-lift unit tests (arch review C4) — pin the ONE shared extraction:
 * candidate order, string-awareness (the old selector bug), repair, and
 * map-null-keeps-scanning semantics for the four consumers.
 */
import { describe, expect, it } from "vitest";
import { balancedObjectSpans, jsonCandidates, liftJson, repairJsonCandidate } from "../../lib/json-lift.ts";

describe("jsonCandidates order", () => {
	it("fences come last-first (the answer trails the preamble), then whole text, then the outermost slice", () => {
		const text = '```json\n{"a":1}\n```\nprose\n```json\n{"b":2}\n```';
		expect(jsonCandidates(text)).toEqual(['{"b":2}', '{"a":1}', text, '{"a":1}\n```\nprose\n```json\n{"b":2}']);
	});

	it("balanced spans follow in document order; a duplicate outermost slice dedupes away", () => {
		const text = 'noise {"outer":{"inner":1}} trailing';
		const cands = jsonCandidates(text);
		expect(cands[0]).toBe(text); // whole text (does not parse — fine, order is the pin)
		expect(cands[1]).toBe('{"outer":{"inner":1}}');
		expect(cands[2]).toBe('{"inner":1}');
		expect(cands).toHaveLength(3); // the outermost slice equals span #1 — deduped
	});

	it("dedupes identical candidates", () => {
		const text = '{"x":1}';
		expect(jsonCandidates(text)).toEqual([text]);
	});
});

describe("balancedObjectSpans string-awareness", () => {
	it("braces inside string values do not break spans (the old selector bug)", () => {
		const text = 'pre {"selected":["a}b","c{d"]} post';
		expect(balancedObjectSpans(text)).toEqual(['{"selected":["a}b","c{d"]}']);
	});

	it("escaped quotes inside strings are handled", () => {
		const text = '{"k":"she said \\"}\\" ok"}';
		expect(balancedObjectSpans(text)).toEqual([text]);
	});

	it("unbalanced text yields no spans (no throw)", () => {
		expect(balancedObjectSpans("}{ no objects here")).toEqual([]);
	});
});

describe("repairJsonCandidate", () => {
	it("strips a BOM and trailing commas", () => {
		expect(repairJsonCandidate('\uFEFF{"a":1,}')).toBe('{"a":1}');
		expect(repairJsonCandidate('{"a":[1,2,],}')).toBe('{"a":[1,2]}');
	});

	it("does not touch commas not followed by a closer", () => {
		expect(repairJsonCandidate('{"a":"x, y"}')).toBe('{"a":"x, y"}');
	});
});

describe("liftJson", () => {
	it("returns the first candidate whose map is non-null", () => {
		const text = 'noise {"selected":["a"]} noise';
		expect(liftJson(text, (v) => {
			const sel = (v as { selected?: unknown }).selected;
			return Array.isArray(sel) ? sel.map(String) : null;
		})).toEqual(["a"]);
	});

	it("map returning null keeps scanning (consumer payload validation)", () => {
		const text = '{"foo": 1} then {"operations": []}';
		expect(liftJson(text, (v) => (Array.isArray((v as { operations?: unknown }).operations) ? v : null))).toEqual({ operations: [] });
	});

	it("repairs trailing commas by default; repair:false keeps strict parsing", () => {
		const text = '{"a":1,}';
		expect(liftJson(text, () => "kept")).toBe("kept");
		expect(liftJson(text, () => "kept", { repair: false })).toBeNull();
	});

	it("accepts an empty array from the mapper (falsy-but-non-null wins)", () => {
		expect(liftJson('{"ops":[]}', (v) => (Array.isArray((v as { ops?: unknown }).ops) ? [] : null))).toEqual([]);
	});

	it("returns null for garbage", () => {
		expect(liftJson("total garbage", () => "x")).toBeNull();
	});
});
