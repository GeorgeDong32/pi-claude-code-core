/**
 * test/lib/truncation-verdict.test.ts — [cherry-batch1 B1-1/B1-2] the dual
 * verdict table + the recovery-policy copy (spec §B1 test matrix).
 */
import { describe, expect, it } from "vitest";

import { boundedRecoveryPolicy, classifyLengthStop } from "../../lib/truncation-verdict.ts";

describe("classifyLengthStop (B1-1)", () => {
	it("non-length stop reasons are not-length", () => {
		expect(classifyLengthStop({ stopReason: undefined })).toBe("not-length");
		expect(classifyHistory("stop")).toBe("not-length");
		expect(classifyHistory("error")).toBe("not-length");
		expect(classifyHistory("aborted")).toBe("not-length");
		expect(classifyHistory("toolUse")).toBe("not-length");
	});

	it("length + output at/over a known cap → output-limit (>= pinned at the boundary)", () => {
		expect(classifyHistory("length", { output: 8192 }, 8192)).toBe("output-limit");
		expect(classifyHistory("length", { output: 9000 }, 8192)).toBe("output-limit");
	});

	it("length + output under a known cap → context-clamp", () => {
		expect(classifyHistory("length", { output: 100 }, 8192)).toBe("context-clamp");
	});

	it("length + unknown cap → context-clamp (conservative: a notice beats silence)", () => {
		expect(classifyHistory("length", { output: 9000 }, undefined)).toBe("context-clamp");
		expect(classifyHistory("length", undefined, undefined)).toBe("context-clamp");
	});

	it("malformed cap/output values fall back to context-clamp, never crash", () => {
		expect(classifyHistory("length", { output: Number.NaN }, 100)).toBe("context-clamp");
		expect(classifyHistory("length", { output: 50 }, -1)).toBe("context-clamp");
		expect(classifyHistory("length", { output: 50 }, Number.NaN)).toBe("context-clamp");
	});
});

describe("boundedRecoveryPolicy (B1-2)", () => {
	it("not-length → no notice", () => {
		expect(boundedRecoveryPolicy("not-length").userNotice).toBeNull();
		expect(boundedRecoveryPolicy("not-length").isQuota).toBe(false);
	});

	it("context-clamp → guidance copy with the maxTokens hedge", () => {
		const p = boundedRecoveryPolicy("context-clamp");
		expect(p.userNotice).toMatch(/context/);
		expect(p.userNotice).toMatch(/maxTokens/); // the hedge for mis-verdicts
		expect(p.isQuota).toBe(false);
	});

	it("output-limit → quota copy", () => {
		const p = boundedRecoveryPolicy("output-limit");
		expect(p.userNotice).toMatch(/output limit/);
		expect(p.userNotice).toMatch(/maxTokens|continuing/);
		expect(p.isQuota).toBe(true);
	});
});

function classifyHistory(
	stopReason: string | undefined,
	usage?: { output?: number },
	cap?: number,
): ReturnType<typeof classifyLengthStop> {
	return classifyLengthStop({ stopReason, usage, modelMaxOutputTokens: cap });
}
