/**
 * P0-LB-02 / P0-LB-04 — lib/model-id.ts unit tests.
 * The equivalence table mirrors pm 2.8.0 profiles.ts parseModelId outputs
 * (field-name mapping: model→modelId, thinkingLevel→effort). The retired
 * package moved to ../archive/repos (2026-09-30); its frozen outputs are
 * encoded as explicit goldens below.
 */
import { describe, expect, it } from "vitest";
import { parseModelId } from "../../lib/model-id.ts";

/** Frozen pm 2.8.0 outputs (null where the old parser returned null). */
const PM_GOLDENS: Record<string, null | { provider: string; model: string; thinkingLevel?: string }> = {
	"anthropic/claude-opus-4": { provider: "anthropic", model: "claude-opus-4" },
	"anthropic/claude-opus-4:high": { provider: "anthropic", model: "claude-opus-4", thinkingLevel: "high" },
	"openrouter/anthropic/claude-3.5-sonnet": { provider: "openrouter", model: "anthropic/claude-3.5-sonnet" },
	"opencode/big-pickle:": { provider: "opencode", model: "big-pickle" },
	"prov/model:x:y": { provider: "prov", model: "model", thinkingLevel: "x:y" },
	"prov/model:": { provider: "prov", model: "model" },
	"/leading-slash": null,
	"no-slash": null,
	"provider/": null,
	"": null,
	":": null,
	":effort": null,
};

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

describe("P0-LB-02 parseModelId equivalence with pm profiles.ts (frozen goldens)", () => {
	for (const raw of CASES) {
		it(`equivalence: ${JSON.stringify(raw)}`, () => {
			const mine = parseModelId(raw);
			const old = PM_GOLDENS[raw];
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
