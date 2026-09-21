import { strict as assert } from "node:assert";
import { describe, test } from "node:test";

import { parseReviewArgs } from "../src/cli-args.js";

describe("parseReviewArgs", () => {
	test("parses --lite flag", () => {
		const p = parseReviewArgs("--lite");
		assert.equal(p.lite, true);
		assert.equal(p.noSpawn, false);
		assert.equal(p.input, undefined);
	});

	test("parses --no-spawn flag", () => {
		const p = parseReviewArgs("--no-spawn");
		assert.equal(p.noSpawn, true);
		assert.equal(p.lite, false);
	});

	test("joins freeform trailing text into input (any prompt)", () => {
		const p = parseReviewArgs("review PR 17206 for backup edge cases");
		assert.equal(p.input, "review PR 17206 for backup edge cases");
		assert.equal(p.lite, false);
	});

	test("keeps a PR url as input", () => {
		const p = parseReviewArgs("https://github.com/org/repo/pull/42");
		assert.equal(p.input, "https://github.com/org/repo/pull/42");
	});

	test("combines --lite with a focus prompt", () => {
		const p = parseReviewArgs("--lite focus on concurrency and security");
		assert.equal(p.lite, true);
		assert.equal(p.input, "focus on concurrency and security");
	});

	test("silently drops removed valued flags and their values (graceful degradation)", () => {
		// Old invocations must not leak flag values into input.
		const p = parseReviewArgs("--threshold 7 --reviewer bugbot --no-gate focus on bugs");
		assert.equal(p.input, "focus on bugs");
		assert.equal(p.lite, false);
	});

	test("drops removed --diff and its value", () => {
		const p = parseReviewArgs("--diff @./changes.patch");
		assert.equal(p.input, undefined);
	});

	test("drops removed --score-per-issue and its value", () => {
		const p = parseReviewArgs("--score-per-issue blocker-major");
		assert.equal(p.input, undefined);
	});

	test("parses --gate-model override (no longer a legacy flag)", () => {
		const p = parseReviewArgs("--gate-model anthropic/claude-sonnet-4-6");
		assert.equal(p.gateModel, "anthropic/claude-sonnet-4-6");
		assert.equal(p.input, undefined);
	});

	test("--gate-model does not swallow the trailing user prompt", () => {
		const p = parseReviewArgs("--gate-model anthropic/claude-haiku-4-5 focus on auth");
		assert.equal(p.gateModel, "anthropic/claude-haiku-4-5");
		assert.equal(p.input, "focus on auth");
	});
});
