/*
 * Settings tests (SPEC SC §5.10 ST-02 + ST-03 env part, task W1).
 *
 * Requirement → test map:
 *   ST-02 → "defaults on missing file", "malformed file → defaults + warn",
 *            "valid custom file round-trips", "invalid ratio group reverts
 *            together", "per-field out-of-range falls back"
 *   ST-03 (env) → "PI_CORE_COMPACTION overrides / invalid ignored"
 * File layout is frozen by SC-CFG-01; env by SC-ENV-01 (contracts table).
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import {
	DEFAULT_COMPACTION_CORE_SETTINGS,
	loadCompactionSettings,
	setCompactionSettingsPath,
} from "../settings.ts";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "sc-settings-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function pointAt(content?: string): string {
	const path = join(dir, "core-compaction.json");
	if (content !== undefined) writeFileSync(path, content, "utf8");
	return path;
}

test("ST-02: missing file → defaults, no warns", () => {
	setCompactionSettingsPath(pointAt());
	const { settings, warned } = loadCompactionSettings({});
	assert.deepEqual(settings, DEFAULT_COMPACTION_CORE_SETTINGS);
	assert.deepEqual(warned, []);
});

test("default takeover is ON (user-approved 2026-11-10, DEVIATIONS SC-1 recovery clause ②)", () => {
	// pins the shipping default: a user override, not a gate pass — M1=0.52
	// replay fact stands; PI_CORE_COMPACTION=shadow is the one-line rollback.
	assert.equal(DEFAULT_COMPACTION_CORE_SETTINGS.mode, "on");
});

test("ST-02: malformed file → defaults + one warn (never throws)", () => {
	setCompactionSettingsPath(pointAt("{ not json"));
	const { settings, warned } = loadCompactionSettings({});
	assert.equal(settings.mode, DEFAULT_COMPACTION_CORE_SETTINGS.mode);
	assert.equal(settings.precomputeRatio, DEFAULT_COMPACTION_CORE_SETTINGS.precomputeRatio);
	assert.equal(warned.length, 1);
	assert.match(warned[0], /core-compaction\.json ignored/);
});

test("ST-02: valid custom file round-trips every layer", () => {
	setCompactionSettingsPath(
		pointAt(
			JSON.stringify({
				mode: "shadow",
				targetPostRatio: 0.4,
				precomputeRatio: 0.55,
				applyRatio: 0.8,
				hardFitRatio: 0.85,
				overflowFitRatio: 0.7,
				summaryTokenEstimate: 9000,
				summaryModel: "zai/glm-4.6",
				summaryThinking: "minimal",
				summaryMaxTokens: 8000,
				idleGapMs: 300000,
				standingPatterns: ["immer", "niemals"],
				ledger: { rexFlow: { enabled: false, boardPath: "/tmp/board.json" } },
				weights: { user: 70 },
				lambda: 5,
			}),
		),
	);
	const { settings, warned } = loadCompactionSettings({});
	assert.deepEqual(warned, []);
	assert.equal(settings.mode, "shadow");
	assert.equal(settings.precomputeRatio, 0.55);
	assert.equal(settings.applyRatio, 0.8);
	assert.equal(settings.targetPostRatio, 0.4);
	assert.equal(settings.hardFitRatio, 0.85);
	assert.equal(settings.overflowFitRatio, 0.7);
	assert.equal(settings.summaryTokenEstimate, 9000);
	assert.equal(settings.summaryModel, "zai/glm-4.6");
	assert.equal(settings.summaryThinking, "minimal");
	assert.equal(settings.summaryMaxTokens, 8000);
	assert.equal(settings.idleGapMs, 300000);
	assert.deepEqual(settings.standingPatterns, ["immer", "niemals"]);
	assert.equal(settings.ledger.rexFlow.enabled, false);
	assert.equal(settings.ledger.rexFlow.boardPath, "/tmp/board.json");
	assert.equal(settings.weights.user, 70); // per-key override…
	assert.equal(settings.weights.runClosed, 100); // …others keep defaults
	assert.equal(settings.lambda, 5);
});

test("ST-02/POL-02: invalid ratio group reverts together with one warn", () => {
	setCompactionSettingsPath(
		pointAt(JSON.stringify({ precomputeRatio: 0.9, applyRatio: 0.8 })), // p ≥ a: invalid
	);
	const { settings, warned } = loadCompactionSettings({});
	// Whole group reverted — the valid-looking applyRatio too.
	assert.equal(settings.precomputeRatio, DEFAULT_COMPACTION_CORE_SETTINGS.precomputeRatio);
	assert.equal(settings.applyRatio, DEFAULT_COMPACTION_CORE_SETTINGS.applyRatio);
	assert.equal(warned.length, 1);
	assert.match(warned[0], /ratio group invalid/);
});

test("ST-02: per-field out-of-range or mistyped values fall back", () => {
	setCompactionSettingsPath(
		pointAt(
			JSON.stringify({
				fallbackDeadlineMs: -5,
				minNarrativeChars: "big",
				summaryModel: 42,
				standingPatterns: ["ok", 7, ""],
				refusedCooldownTurns: 0,
				weights: { user: "high" },
			}),
		),
	);
	const { settings } = loadCompactionSettings({});
	assert.equal(settings.fallbackDeadlineMs, DEFAULT_COMPACTION_CORE_SETTINGS.fallbackDeadlineMs);
	assert.equal(settings.minNarrativeChars, DEFAULT_COMPACTION_CORE_SETTINGS.minNarrativeChars);
	assert.equal(settings.summaryModel, null);
	assert.deepEqual(settings.standingPatterns, ["ok"]);
	assert.equal(settings.refusedCooldownTurns, 0); // 0 is allowed (min-inclusive)
	assert.equal(settings.weights.user, DEFAULT_COMPACTION_CORE_SETTINGS.weights.user);
});

test("ST-03 (env): PI_CORE_COMPACTION overrides the file; invalid values ignored with a warn", () => {
	setCompactionSettingsPath(pointAt(JSON.stringify({ mode: "on" })));
	assert.equal(loadCompactionSettings({ PI_CORE_COMPACTION: "off" }).settings.mode, "off");
	assert.equal(loadCompactionSettings({ PI_CORE_COMPACTION: "shadow" }).settings.mode, "shadow");
	assert.equal(loadCompactionSettings({ PI_CORE_COMPACTION: "on" }).settings.mode, "on");
	assert.equal(loadCompactionSettings({}).settings.mode, "on"); // no env → file
	const bogus = loadCompactionSettings({ PI_CORE_COMPACTION: "yes" });
	assert.equal(bogus.settings.mode, "on");
	assert.equal(bogus.warned.length, 1);
	assert.match(bogus.warned[0], /PI_CORE_COMPACTION=yes ignored/);
});
