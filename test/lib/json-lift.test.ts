/**
 * json-lift unit tests (arch review C4) — pin the ONE shared extraction:
 * candidate order, string-awareness (the old selector bug), repair, and
 * map-null-keeps-scanning semantics for the four consumers.
 */
import { describe, expect, it } from "vitest";
import {
	_spanScanCountForTests,
	_resetSpanScanCountForTests,
	balancedObjectSpans,
	jsonCandidates,
	liftJson,
	repairJsonCandidate,
} from "../../lib/json-lift.ts";

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

	// AR1005-JS-01 / JS-T01: the old comma regex did not recognize strings, so a
	// real trailing comma authorized it to rewrite string bodies too.
	it("JS-T01: real trailing commas repaired while ,} / ,] inside strings stay verbatim", () => {
		expect(repairJsonCandidate('{"note":"literal ,} sequence","tags":["a ,] b",],"nums":[1,2,3,]}'))
			.toBe('{"note":"literal ,} sequence","tags":["a ,] b"],"nums":[1,2,3]}');
		const out = liftJson('{"note":"literal ,} sequence","nums":[1,2,3,]}', (v) =>
			(v as { note?: string; nums?: number[] }).note ? (v as { note: string; nums: number[] }) : null);
		expect(out).toEqual({ note: "literal ,} sequence", nums: [1, 2, 3] });
	});

	// AR1005-JS-01 / JS-T02: escape-aware scan — quoted closers, odd/even
	// backslashes, unicode and nested arrays pass through byte-identical.
	it("JS-T02: escaped quotes, backslash runs, unicode and nested arrays survive repair unchanged", () => {
		const input = '{"k":"she said \\"} ,] \\\\ ok 中文 ✅","tail":"after\\\\","nested":[[1,],[2,],]}';
		expect(repairJsonCandidate(input))
			.toBe('{"k":"she said \\"} ,] \\\\ ok 中文 ✅","tail":"after\\\\","nested":[[1],[2]]}');
		const out = liftJson(input, (v) => (v as { k?: string }).k ? (v as { k: string; nested: number[][] }) : null);
		expect(out?.k).toBe('she said "} ,] \\ ok 中文 ✅');
		expect(out?.nested).toEqual([[1], [2]]);
	});

	// JS-T03: already-valid text, BOM-only input and repair:false keep baseline semantics.
	it("JS-T03: valid JSON and BOM handling unchanged; repair:false stays strict", () => {
		expect(repairJsonCandidate('\uFEFF{"a":1}')).toBe('{"a":1}');
		expect(repairJsonCandidate('{"a":1}')).toBe('{"a":1}');
		expect(liftJson('\uFEFF{"a":1,}', () => "x")).toBe("x");
		expect(liftJson('{"a":1,}', () => "x", { repair: false })).toBeNull();
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

	// JS-T04: canonical order across fences, duplicates and mapper rejection.
	it("JS-T04: outer candidates rejected by the mapper keep scanning to inner ones, in baseline order", () => {
		const text = 'head ```json\n{"ops":"outer"}\n``` mid {"ops":[1]} tail';
		const seen: string[] = [];
		const out = liftJson(text, (v) => {
			const ops = (v as { ops?: unknown }).ops;
			seen.push(JSON.stringify(v));
			return Array.isArray(ops) ? ops : null;
		});
		expect(out).toEqual([1]);
		// raw then repaired variant per candidate; the whole-text candidate does not parse;
		// the outer span dedupes against the fence candidate (baseline order).
		expect(seen).toEqual(['{"ops":"outer"}', '{"ops":"outer"}', '{"ops":[1]}']);
	});

	// JS-T05: mapper edge semantics — empty array wins; null/undefined/throw keep scanning.
	it("JS-T05: empty-array mapper result is valid; null, undefined and throws keep scanning", () => {
		expect(liftJson('{"ops":[]}', (v) => (Array.isArray((v as { ops?: unknown }).ops) ? [] : null))).toEqual([]);
		expect(liftJson('{"a":1}', () => undefined)).toBeNull();
		expect(liftJson('{"a":1}', () => { throw new Error("mapper rejects"); })).toBeNull();
	});

	it("returns null for garbage", () => {
		expect(liftJson("total garbage", () => "x")).toBeNull();
	});

	// JS-T08: inputs that still NEED the span fallback produce baseline-identical results.
	it("JS-T08: span-fallback fixtures lift the same payloads as the baseline", () => {
		const fixture = '前置说明 {"selected":["mem-1","mem-2"]} 后置说明';
		expect(liftJson(fixture, (v) => {
			const sel = (v as { selected?: unknown }).selected;
			return Array.isArray(sel) ? sel.map(String) : null;
		})).toEqual(["mem-1", "mem-2"]);
		const malformed = 'bad outer {"keep":"a ,} b"} tail';
		expect(liftJson(malformed, (v) => (v as { keep?: string }).keep ? (v as { keep: string }).keep : null)).toBe("a ,} b");
	});

	// JS-T07: lazy candidate generation — a stage-1/2 success must never enter
	// the span scan (operation-count assertion, no machine-specific timing).
	it("JS-T07: fence or whole-text success never starts span enumeration", () => {
		_resetSpanScanCountForTests();
		expect(liftJson('```json\n{"ops":[1]}\n``` trailing prose', (v) => {
			const ops = (v as { ops?: unknown }).ops;
			return Array.isArray(ops) ? ops : null;
		})).toEqual([1]);
		expect(_spanScanCountForTests()).toBe(0);

		_resetSpanScanCountForTests();
		expect(liftJson('{"ops":[2],}', (v) => {
			const ops = (v as { ops?: unknown }).ops;
			return Array.isArray(ops) ? ops : null;
		})).toEqual([2]);
		expect(_spanScanCountForTests()).toBe(0);
	});

	it("JS-T07: collecting all candidates enters the span stage exactly once; fallback inputs still scan", () => {
		_resetSpanScanCountForTests();
		expect(jsonCandidates('noise {"a":{"b":1}} tail')).toHaveLength(3);
		expect(_spanScanCountForTests()).toBe(1);

		_resetSpanScanCountForTests();
		expect(liftJson('noise {"ops":[9]} tail', (v) => {
			const ops = (v as { ops?: unknown }).ops;
			return Array.isArray(ops) ? ops : null;
		})).toEqual([9]);
		expect(_spanScanCountForTests()).toBe(1);
	});
});
