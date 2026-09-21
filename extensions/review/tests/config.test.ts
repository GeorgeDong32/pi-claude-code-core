/**
 * Tests for src/config.ts (v0.7): defaults, merge, validation, atomic write,
 * legacy-key migration warnings.
 */
import { strict as assert } from "node:assert";
import { afterEach, beforeEach, describe, test } from "node:test";
import { dirname, join } from "node:path";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

import {
	DEFAULT_CONFIG,
	DEFAULT_GATE_MODEL,
	clampThreshold,
	configPath,
	legacyConfigWarnings,
	loadConfig,
	loadRawConfig,
	mergeWithDefaults,
	parseRoutingMode,
	parseVerdictPolicy,
	resolveModel,
	setConfigPath,
	validateConfig,
	writeConfig,
} from "../src/config.js";

let sandbox: string;

beforeEach(() => {
	sandbox = mkdtempSync(join(tmpdir(), "pi-review-config-"));
	setConfigPath(join(sandbox, "pi-review.json"));
});

afterEach(() => {
	rmSync(sandbox, { recursive: true, force: true });
	setConfigPath(); // reset to default
});

describe("mergeWithDefaults", () => {
	test("returns DEFAULT_CONFIG when raw is empty", () => {
		const merged = mergeWithDefaults({});
		assert.equal(merged.schemaVersion, 1);
		assert.equal(merged.gate.model, DEFAULT_GATE_MODEL);
		assert.equal(merged.gate.threshold, 8);
		assert.equal(merged.gate.verdictPolicy, "strict");
		assert.equal(merged.routing.mode, "adaptive");
		assert.equal(Object.keys(merged.reviewers).length, 6);
		// Removed legacy knobs are absent.
		assert.ok(!("concurrency" in merged));
		assert.ok(!("inheritance" in merged));
		assert.ok(!("scorePerIssue" in merged.gate));
	});

	test("returns DEFAULT_CONFIG when raw is null/non-object", () => {
		assert.deepEqual(mergeWithDefaults(null), DEFAULT_CONFIG);
		assert.deepEqual(mergeWithDefaults(undefined), DEFAULT_CONFIG);
		assert.deepEqual(mergeWithDefaults(42), DEFAULT_CONFIG);
		assert.deepEqual(mergeWithDefaults([1, 2]), DEFAULT_CONFIG);
	});

	test("merges gate overrides on top of defaults", () => {
		const merged = mergeWithDefaults({
			gate: { model: "anthropic/claude-opus-4-6", thinking: "high", enabled: false, threshold: 7, verdictPolicy: "legacy" },
		});
		assert.equal(merged.gate.model, "anthropic/claude-opus-4-6");
		assert.equal(merged.gate.thinking, "high");
		assert.equal(merged.gate.enabled, false);
		assert.equal(merged.gate.threshold, 7);
		assert.equal(merged.gate.verdictPolicy, "legacy");
	});

	test("merges routing.mode", () => {
		assert.equal(mergeWithDefaults({ routing: { mode: "all" } }).routing.mode, "all");
	});

	test("clamps threshold to [0, 10]", () => {
		assert.equal(mergeWithDefaults({ gate: { threshold: -1 } }).gate.threshold, 0);
		assert.equal(mergeWithDefaults({ gate: { threshold: 11 } }).gate.threshold, 10);
		assert.equal(mergeWithDefaults({ gate: { threshold: 4.9 } }).gate.threshold, 4);
	});

	test("merges per-reviewer overrides", () => {
		const merged = mergeWithDefaults({
			reviewers: {
				bugbot: { model: "anthropic/claude-opus-4-6", thinking: "xhigh", enabled: false },
			},
		});
		const bug = merged.reviewers.bugbot;
		assert.equal(bug.model, "anthropic/claude-opus-4-6");
		assert.equal(bug.thinking, "xhigh");
		assert.equal(bug.enabled, false);
		// Other reviewers untouched.
		assert.equal(merged.reviewers["rulesheriff"].model, "inherit");
	});

	test("adds a brand-new reviewer", () => {
		const merged = mergeWithDefaults({
			reviewers: {
				"custom-foo": { label: "Custom Foo", model: "anthropic/claude-haiku-4-5" },
			},
		});
		assert.ok(merged.reviewers["custom-foo"]);
		assert.equal(merged.reviewers["custom-foo"].label, "Custom Foo");
		assert.equal(Object.keys(merged.reviewers).length, 7);
	});

	test("ignores invalid sub-objects under reviewers", () => {
		const merged = mergeWithDefaults({
			reviewers: { "rulesheriff": null, bugbot: "bad" },
		});
		assert.equal(merged.reviewers["rulesheriff"].model, "inherit");
		assert.equal(merged.reviewers.bugbot.model, "inherit");
	});

	test("ignores legacy per-reviewer tools / timeoutMs ", () => {
		const merged = mergeWithDefaults({
			reviewers: { bugbot: { tools: ["bash"], timeoutMs: 42 } },
		});
		assert.ok(!("tools" in merged.reviewers.bugbot));
		assert.ok(!("timeoutMs" in merged.reviewers.bugbot));
	});
});

describe("legacyConfigWarnings", () => {
	test("flags removed top-level keys", () => {
		const warnings = legacyConfigWarnings({ concurrency: 4, inheritance: {}, gate: { scorePerIssue: "all" }, reviewers: { bugbot: { tools: ["bash"], timeoutMs: 9 } } });
		const joined = warnings.join("\n");
		assert.match(joined, /concurrency/);
		assert.match(joined, /inheritance/);
		assert.match(joined, /scorePerIssue/);
		assert.match(joined, /tools/);
		assert.match(joined, /timeoutMs/);
	});

	test("reports no warnings for a clean v0.7 config", () => {
		assert.deepEqual(legacyConfigWarnings({}), []);
		assert.deepEqual(legacyConfigWarnings(DEFAULT_CONFIG as unknown as Record<string, unknown>), []);
	});
});

describe("clampThreshold", () => {
	test("clamps and floors", () => {
		assert.equal(clampThreshold(-5), 0);
		assert.equal(clampThreshold(0), 0);
		assert.equal(clampThreshold(10), 10);
		assert.equal(clampThreshold(11), 10);
		assert.equal(clampThreshold(3.7), 3);
		assert.equal(clampThreshold(NaN), 8);
		assert.equal(clampThreshold(-Infinity), 0);
		assert.equal(clampThreshold(Infinity), 10);
	});
});

describe("parseVerdictPolicy / parseRoutingMode", () => {
	test("parses valid values and rejects bad ones", () => {
		assert.equal(parseVerdictPolicy("strict"), "strict");
		assert.equal(parseVerdictPolicy("legacy"), "legacy");
		assert.equal(parseVerdictPolicy("whatever"), null);
		assert.equal(parseRoutingMode("adaptive"), "adaptive");
		assert.equal(parseRoutingMode("all"), "all");
		assert.equal(parseRoutingMode("none"), null);
	});
});

describe("validateConfig", () => {
	test("accepts DEFAULT_CONFIG", () => {
		assert.deepEqual(validateConfig(DEFAULT_CONFIG), { ok: true });
	});

	test("rejects wrong schemaVersion", () => {
		const cfg = { ...DEFAULT_CONFIG, schemaVersion: 2 as 1 };
		const v = validateConfig(cfg);
		assert.equal(v.ok, false);
		assert.ok((v as { ok: false; errors: string[] }).errors.some((e) => e.includes("schemaVersion")));
	});

	test("rejects out-of-range threshold", () => {
		const cfg = { ...DEFAULT_CONFIG, gate: { ...DEFAULT_CONFIG.gate, threshold: 11 } };
		const v = validateConfig(cfg);
		assert.equal(v.ok, false);
	});

	test("rejects empty model strings", () => {
		const cfg = { ...DEFAULT_CONFIG, gate: { ...DEFAULT_CONFIG.gate, model: "" } };
		const v = validateConfig(cfg);
		assert.equal(v.ok, false);
		assert.ok((v as { ok: false; errors: string[] }).errors.some((e) => e.includes("gate.model")));
	});
});

describe("resolveModel", () => {
	test("returns parent model when 'inherit'", () => {
		assert.equal(resolveModel("inherit", "anthropic/claude-sonnet-4-6"), "anthropic/claude-sonnet-4-6");
	});

	test("falls back when inherit and no parent model", () => {
		assert.equal(resolveModel("inherit", undefined), DEFAULT_GATE_MODEL);
		assert.equal(resolveModel("inherit", ""), DEFAULT_GATE_MODEL);
	});

	test("returns explicit value untouched", () => {
		assert.equal(resolveModel("anthropic/claude-haiku-4-5", "anthropic/claude-opus-4-6"), "anthropic/claude-haiku-4-5");
	});
});

describe("loadRawConfig / loadConfig / writeConfig", () => {
	test("loadRawConfig returns empty object when file missing", () => {
		assert.deepEqual(loadRawConfig(), {});
	});

	test("loadConfig returns merged defaults when file missing", () => {
		const { config, errors, legacyWarnings } = loadConfig();
		assert.deepEqual(errors, []);
		assert.deepEqual(legacyWarnings, []);
		assert.equal(config.gate.model, DEFAULT_GATE_MODEL);
	});

	test("writeConfig round-trips through loadConfig", () => {
		const cfg = mergeWithDefaults({ gate: { model: "anthropic/claude-haiku-4-5", threshold: 5 } });
		writeConfig(cfg);
		assert.ok(configPath().startsWith(sandbox));
		const reloaded = loadConfig();
		assert.equal(reloaded.config.gate.model, "anthropic/claude-haiku-4-5");
		assert.equal(reloaded.config.gate.threshold, 5);
	});

	test("loadConfig recovers from corrupt JSON", () => {
		mkdirSync(dirname(configPath()), { recursive: true });
		writeFileSync(configPath(), "{not json", "utf-8");
		const { config, errors } = loadConfig();
		assert.deepEqual(errors, []);
		assert.equal(config.gate.model, DEFAULT_GATE_MODEL);
	});

	test("loadConfig reports validation errors when override is structurally bad", () => {
		mkdirSync(dirname(configPath()), { recursive: true });
		writeFileSync(configPath(), JSON.stringify({ schemaVersion: 99 }), "utf-8");
		const { errors } = loadConfig();
		assert.ok(errors.length > 0);
		assert.ok(errors.some((e) => e.includes("schemaVersion")));
	});

	test("loadConfig clamps out-of-range values silently", () => {
		mkdirSync(dirname(configPath()), { recursive: true });
		writeFileSync(configPath(), JSON.stringify({ gate: { threshold: 99 } }), "utf-8");
		const { config, errors } = loadConfig();
		assert.deepEqual(errors, []);
		assert.equal(config.gate.threshold, 10);
	});

	test("loadConfig surfaces legacy migration warnings", () => {
		mkdirSync(dirname(configPath()), { recursive: true });
		writeFileSync(configPath(), JSON.stringify({ concurrency: 2, gate: { scorePerIssue: "all" } }), "utf-8");
		const { legacyWarnings, config } = loadConfig();
		assert.ok(legacyWarnings.length > 0);
		assert.equal(config.routing.mode, "adaptive");
	});
});