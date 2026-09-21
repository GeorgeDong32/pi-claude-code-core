/**
 * Tests for src/gate-enforce.ts: dedupe, threshold, verdict, dispositions.
 */
import { strict as assert } from "node:assert";
import { describe, test } from "node:test";

import {
	buildDispositions,
	computeVerdict,
	dedupeIssues,
	enforceGateOutput,
	filterByThreshold,
} from "../src/gate-enforce.js";
import type { Issue } from "../src/types.js";

function issue(partial: Partial<Issue> & Pick<Issue, "file" | "severity" | "confidence">): Issue {
	return {
		category: "bug",
		evidence: "evidence",
		...partial,
	};
}

describe("dedupeIssues", () => {
	test("keeps highest confidence for same file/line/category", () => {
		const out = dedupeIssues([
			issue({ file: "a.ts", line: 1, confidence: 5, severity: "minor", evidence: "low" }),
			issue({ file: "a.ts", line: 1, confidence: 9, severity: "major", evidence: "high" }),
		]);
		assert.equal(out.length, 1);
		assert.equal(out[0]!.confidence, 9);
	});

	test("stable fingerprint dedupes across reviewers", () => {
		const a = issue({ file: "a.ts", line: 2, confidence: 8, severity: "major", evidence: "x" });
		const b = issue({ file: "a.ts", line: 2, confidence: 6, severity: "minor", evidence: "x" });
		a.fingerprint = "fp:1";
		b.fingerprint = "fp:1";
		const out = dedupeIssues([a, b]);
		assert.equal(out.length, 1);
		assert.equal(out[0]!.confidence, 8);
	});
});

describe("filterByThreshold", () => {
	test("drops below floor", () => {
		const out = filterByThreshold(
			[
				issue({ file: "a.ts", confidence: 7, severity: "major" }),
				issue({ file: "b.ts", confidence: 8, severity: "major" }),
			],
			8,
		);
		assert.equal(out.length, 1);
		assert.equal(out[0]!.file, "b.ts");
	});

	test("missing confidence defaults to neutral 5, not silently dropped", () => {
		// Field regression: shape-adapted issues arrived without confidence and
		// `undefined >= floor` filtered out every one of them — a systematic
		// false-negative source (real majors killed).
		const noConf = {
			...issue({ file: "a.ts", confidence: 9, severity: "major" }),
			confidence: undefined,
		} as unknown as import("../src/types.js").Issue;
		const out = filterByThreshold([noConf], 8);
		assert.equal(out.length, 0, "neutral 5 is still below floor 8");
		const outLowFloor = filterByThreshold([noConf], 5);
		assert.equal(outLowFloor.length, 1, "neutral 5 survives a floor of 5");
	});
});

describe("computeVerdict", () => {
	test("strict: any blocker or major → request_changes", () => {
		assert.equal(
			computeVerdict([issue({ file: "a.ts", confidence: 9, severity: "blocker" })]),
			"request_changes",
		);
		assert.equal(
			computeVerdict([issue({ file: "a.ts", confidence: 9, severity: "major" })]),
			"request_changes",
		);
	});

	test("legacy: needs ≥3 majors before request_changes", () => {
		assert.equal(
			computeVerdict([
				issue({ file: "a.ts", confidence: 8, severity: "major" }),
			], "legacy"),
			"comment",
		);
		assert.equal(
			computeVerdict([
				issue({ file: "a.ts", confidence: 8, severity: "major" }),
				issue({ file: "b.ts", confidence: 8, severity: "major" }),
				issue({ file: "c.ts", confidence: 8, severity: "major" }),
			], "legacy"),
			"request_changes",
		);
	});

	test("approve when empty or only minor/nit", () => {
		assert.equal(computeVerdict([], "strict"), "approve");
		assert.equal(computeVerdict([issue({ file: "a.ts", confidence: 9, severity: "nit" })], "strict"), "comment");
	});
});

describe("enforceGateOutput", () => {
	test("strict overrides LLM approve when a major remains", () => {
		const out = enforceGateOutput(
			{ issues: [issue({ file: "a.ts", confidence: 9, severity: "major" })], reason: "looks fine" },
			8,
			"strict",
		);
		assert.equal(out.verdict, "request_changes");
		assert.equal(out.issues.length, 1);
		assert.equal(out.dispositions.length, 0);
	});

	test("drops low-confidence then approves", () => {
		const out = enforceGateOutput(
			{ issues: [issue({ file: "a.ts", confidence: 3, severity: "blocker" })], reason: "noise" },
			8,
		);
		assert.equal(out.verdict, "approve");
	});
});

describe("buildDispositions", () => {
	test("marks kept vs dropped by survival", () => {
		const candidates = [
			issue({ file: "a", line: 1, confidence: 9, severity: "blocker", evidence: "x", fingerprint: "fp:1" }),
			issue({ file: "b", line: 1, confidence: 5, severity: "minor", evidence: "y", fingerprint: "fp:2" }),
		];
		const surviving = [candidates[0]!];
		const d = buildDispositions(candidates, surviving);
		const byFp = Object.fromEntries(d.map((x) => [x.fingerprint, x.decision]));
		assert.equal(byFp["fp:1"], "kept");
		assert.equal(byFp["fp:2"], "dropped");
	});
});