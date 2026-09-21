import { strict as assert } from "node:assert";
import { describe, test } from "node:test";

import { extractPrRef, normalizeUserInput } from "../src/pr-ref.js";

describe("extractPrRef", () => {
	test("full GitHub PR URL", () => {
		assert.equal(
			extractPrRef("https://github.com/CherryHQ/cherry-studio/pull/17206"),
			"https://github.com/CherryHQ/cherry-studio/pull/17206",
		);
	});

	test("URL with trailing CJK punctuation and words", () => {
		assert.equal(
			extractPrRef("https://github.com/CherryHQ/cherry-studio/pull/17206，review"),
			"https://github.com/CherryHQ/cherry-studio/pull/17206",
		);
	});

	test("PR number only", () => {
		assert.equal(extractPrRef("17206"), "17206");
		assert.equal(extractPrRef("#17206"), "17206");
	});

	test("natural language with PR number", () => {
		assert.equal(extractPrRef("review PR 17206 for backup"), "17206");
	});

	test("no PR reference", () => {
		assert.equal(extractPrRef("focus on security of the backup module"), null);
	});
});

describe("normalizeUserInput", () => {
	test("replaces Chinese commas", () => {
		assert.equal(normalizeUserInput("foo，bar"), "foo bar");
	});
});
