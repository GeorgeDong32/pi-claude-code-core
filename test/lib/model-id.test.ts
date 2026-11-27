import { describe, expect, it } from "vitest";
import { modelIdentityKey, parseModelId } from "../../lib/model-id.ts";

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

describe("S6 modelIdentityKey", () => {
	it("joins provider and id with the NUL separator", () => {
		expect(modelIdentityKey({ provider: "anthropic", id: "claude-opus-4" })).toBe(
			"anthropic\u0000claude-opus-4",
		);
	});

	it("defaults a missing provider to the empty string", () => {
		expect(modelIdentityKey({ id: "m" })).toBe("\u0000m");
	});

	it("is undefined without a string id (no identity)", () => {
		expect(modelIdentityKey(null)).toBeUndefined();
		expect(modelIdentityKey(undefined)).toBeUndefined();
		expect(modelIdentityKey({})).toBeUndefined();
		expect(modelIdentityKey({ provider: "p" })).toBeUndefined();
		expect(modelIdentityKey({ provider: "p", id: 1 as unknown as string })).toBeUndefined();
	});

	it("distinguishes equal ids across providers and agrees across consumers", () => {
		expect(modelIdentityKey({ provider: "a", id: "m" })).not.toBe(
			modelIdentityKey({ provider: "b", id: "m" }),
		);
		expect(
			modelIdentityKey({ provider: "a", id: "m" }),
		).toBe(modelIdentityKey({ provider: "a", id: "m" }));
	});
});
