/**
 * B5 (cherry-batch2 spec) clampToSupported unit pins — the one clamping
 * semantic shared by the command/flag/profile paths.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { clampToSupported, type EffortLevel, type EffortModel } from "../effort.ts";

function mapModel(mapping: Record<string, string | null>): EffortModel {
	return { id: "m", reasoning: true, thinkingLevelMap: mapping } as EffortModel;
}

describe("clampToSupported (B5-1)", () => {
	it("supported level unchanged; off always legal", () => {
		const m = mapModel({ minimal: null, low: null, medium: "medium", high: "high", xhigh: null, max: null });
		assert.deepEqual(clampToSupported("high", m), { level: "high", clamped: false });
		assert.deepEqual(clampToSupported("off", m), { level: "off", clamped: false });
		assert.deepEqual(clampToSupported("off", null), { level: "off", clamped: false });
	});

	it("single-tier model clamps to the tier", () => {
		// thinkingLevelMap semantics: MISSING keys use provider defaults
		// (supported); null marks unsupported — so a single-tier model must
		// null out every other tier explicitly.
		const m = mapModel({ minimal: null, low: null, medium: null, high: "high", xhigh: null, max: null });
		assert.deepEqual(clampToSupported("medium", m), { level: "high", clamped: true });
		assert.deepEqual(clampToSupported("max", m), { level: "high", clamped: true });
	});

	it("equidistant clamps to the LOWER side (conservative direction)", () => {
		// medium(3) with low(2) and high(4) available: dist 1 both → low
		const m = mapModel({ minimal: null, low: "low", medium: null, high: "high", xhigh: null, max: null });
		assert.deepEqual(clampToSupported("medium", m), { level: "low", clamped: true });
	});

	it("null model returns undefined (callers keep the reject; B5 R1 P2-1)", () => {
		assert.equal(clampToSupported("high", null), undefined);
		assert.equal(clampToSupported("high", undefined), undefined);
	});

	it("only-off model clamps reasoning levels to off", () => {
		const m = mapModel({ minimal: null, low: null, medium: null, high: null, xhigh: null, max: null });
		const r = clampToSupported("high", m);
		assert.equal(r?.clamped, true);
	});
});
