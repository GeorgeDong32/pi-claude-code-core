/*
 * Fallback-leg tests (SPEC SC §5.8 FB-01…08, task W4).
 *
 * Requirement → test map:
 *   FB-01 → "decideFallback matrix" (reason × readiness × custom
 *            instructions × V8a verdict)
 *   FB-04 → "supply shape" (fields complete, origin native-backfill)
 *   FB-06 → "no cancel path" (source scan — wiring test pins the handler)
 *   FB-07 → deadline math is exercised end-to-end by the BLK-3/5 protection
 *            tests; unit level pins hardFitLimitFor per reason
 *   FB-08 → "auditNativeSummary" (⑤–⑦ only; E3 shape invalid)
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { auditNativeSummary, buildSupplyCompaction, decideFallback, hardFitLimitFor } from "../fallback.ts";
import { DEFAULT_COMPACTION_CORE_SETTINGS } from "../settings.ts";
import type { PrecomputedSnapshot } from "../types.ts";

const base = {
	reason: "threshold" as const,
	hasCustomInstructions: false,
	hasComputingSnapshot: false,
	hasReadySnapshot: false,
	snapshotGatesPassed: false,
	snapshotHardFitPassed: false,
};

test("FB-01 matrix: reason × readiness × instructions × fit", () => {
	// threshold + ready + gates + fit → supply.
	assert.deepEqual(decideFallback({ ...base, hasReadySnapshot: true, snapshotGatesPassed: true, snapshotHardFitPassed: true }), { action: "supply-snapshot" });
	// Ready but UNFIT (BLK-3) → skip the snapshot, regenerate.
	assert.deepEqual(decideFallback({ ...base, hasReadySnapshot: true, snapshotGatesPassed: true, snapshotHardFitPassed: false }), { action: "regenerate" });
	// Computing → wait (then re-evaluate).
	assert.deepEqual(decideFallback({ ...base, hasComputingSnapshot: true }), { action: "wait-for-ready" });
	// Nothing → regenerate.
	assert.deepEqual(decideFallback({ ...base }), { action: "regenerate" });
	// manual + instructions → native (D6).
	assert.deepEqual(decideFallback({ ...base, reason: "manual", hasCustomInstructions: true, hasReadySnapshot: true, snapshotGatesPassed: true, snapshotHardFitPassed: true }), { action: "native" });
	// manual + clean ready snapshot → supply.
	assert.deepEqual(decideFallback({ ...base, reason: "manual", hasReadySnapshot: true, snapshotGatesPassed: true, snapshotHardFitPassed: true }), { action: "supply-snapshot" });
	// manual + nothing → native (no synchronous generation for manual).
	assert.deepEqual(decideFallback({ ...base, reason: "manual" }), { action: "native" });
	// overflow behaves like threshold for the decision shape.
	assert.deepEqual(decideFallback({ ...base, reason: "overflow", hasComputingSnapshot: true }), { action: "wait-for-ready" });
});

test("FB-01/INV-12: hardFitLimitFor applies the stricter overflow ratio", () => {
	const settings = DEFAULT_COMPACTION_CORE_SETTINGS;
	const tn = 100_000;
	assert.equal(hardFitLimitFor("threshold", settings, tn), 90_000);
	assert.equal(hardFitLimitFor("manual", settings, tn), 90_000);
	assert.equal(hardFitLimitFor("overflow", settings, tn), 75_000);
});

test("FB-04: supply shape is complete (pi adopts verbatim, H6/H13)", () => {
	const snapshot: PrecomputedSnapshot = {
		generation: 0,
		cut: { firstKeptEntryId: "kept-9", firstKeptEntryIndex: 3, isSplitTurn: false, turnStartIndex: -1, tailTokens: 5_000, boundaryClass: "user", score: 80 },
		branchPathIds: ["a", "b"],
		summary: "# S\ncontent",
		summaryTokens: 3,
		tnAtSnapshot: 100_000,
		validated: true,
	};
	const supply = buildSupplyCompaction({ snapshot, summary: "s", tokensBefore: 91_000, readFiles: ["/a"], modifiedFiles: ["/b"], proposalId: "p1" });
	assert.deepEqual(Object.keys(supply.compaction).sort(), ["details", "firstKeptEntryId", "summary", "tokensBefore"].sort());
	assert.equal(supply.compaction.details.ccCore.origin, "native-backfill");
	assert.equal(supply.compaction.firstKeptEntryId, "kept-9");
});

test("FB-08: auditNativeSummary — E3 file-listing shape invalid; healthy summary valid", () => {
	const thresholds = { minNarrativeChars: 400, minPrefixChars: 100, maxSummaryChars: 40_000 };
	const listing = `${"<read-files>\n- /a.ts\n</read-files>".repeat(4)}`;
	const bad = auditNativeSummary(listing, thresholds);
	assert.equal(bad.valid, false);
	assert.ok(bad.failures.some((f) => f.startsWith("assembled:")));
	const good = auditNativeSummary(`## Work\n${"n".repeat(500)}\n\n## State\n- stable`, thresholds);
	assert.equal(good.valid, true);
});

test("FB-06: the fallback source never returns cancel", () => {
	const source = readFileSync(fileURLToPath(new URL("../fallback.ts", import.meta.url)), "utf-8");
	assert.ok(!/\{\s*cancel|cancel\s*:/.test(source), "no cancel return shape may exist in the fallback leg (FB-06)");
});
