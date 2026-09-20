/**
 * P0-LB-02 / P0-LB-04 — lib/model-id.ts unit tests.
 * Equivalence table mirrors pm 2.8.0 profiles.ts parseModelId outputs
 * (field-name mapping: model→modelId, thinkingLevel→effort).
 */
import { describe, expect, it } from "vitest";
import { parseModelId } from "../../lib/model-id.ts";
import { parseModelId as pmParseModelId } from "../../../pi-permission-modes/profiles.ts";

const CASES: string[] = [
	"anthropic/claude-opus-4",
	"anthropic/claude-opus-4:high",
	"openrouter/anthropic/claude-3.5-sonnet",
	"opencode/big-pickle:",
	"prov/model:x:y",
	"prov/model:",
	"/leading-slash",
	"no-slash",
	"provider/",
	"",
	":",
	":effort",
];

describe("P0-LB-02 parseModelId equivalence with pm profiles.ts", () => {
	for (const raw of CASES) {
		it(`equivalence: ${JSON.stringify(raw)}`, () => {
			const mine = parseModelId(raw);
			const old = pmParseModelId(raw);
			if (old === null) {
				expect(mine).toBeNull();
			} else {
				expect(mine).toEqual({
					provider: old.provider,
					modelId: old.model,
					...(old.thinkingLevel !== undefined ? { effort: old.thinkingLevel } : {}),
				});
			}
		});
	}
});

describe("P0-LB-02 parseModelId boundaries", () => {
	it("rejects non-string input without throwing", () => {
		expect(parseModelId(undefined)).toBeNull();
		expect(parseModelId(null)).toBeNull();
		expect(parseModelId(123)).toBeNull();
		expect(parseModelId({} as unknown as string)).toBeNull();
	});

	it("parses provider/model with effort suffix", () => {
		expect(parseModelId("anthropic/claude-opus-4:high")).toEqual({
			provider: "anthropic",
			modelId: "claude-opus-4",
			effort: "high",
		});
	});

	it("treats a trailing colon as no effort suffix", () => {
		expect(parseModelId("opencode/big-pickle:")).toEqual({
			provider: "opencode",
			modelId: "big-pickle",
		});
	});
});
