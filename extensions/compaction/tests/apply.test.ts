/*
 * Apply-path tests (SPEC SC §5.7 APP-01/02/06/07/08, task W3).
 *
 * Requirement → test map:
 *   APP-02 → "V1…V10" — one discard per gate (+V8a/V8b independently) and
 *             one all-pass propose; V10 asserts HOLD (snapshot survives)
 *   APP-01 → "draft shape + append-only merge"
 *   APP-06 → precheck totality (malformed inputs never throw)
 *   APP-07/08 → "reconcile matrix" — nonce hit (real entryId + V4' audit),
 *             miss → overridden, session_tree → branch-changed, scanMax
 *             window misses, post-commit conflict-edit counting
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";

import { buildDraft, mergeDraftEntries, reconcile, runPrechecks, type PrecheckInput } from "../apply.ts";

function entry(id: string, type = "message"): Record<string, unknown> {
	return { type, id, parentId: null, timestamp: "2026-11-09T10:00:00Z" };
}

const COMPRESSED = new Set(["e0", "e1", "e2"]);

function passingInput(over: Partial<PrecheckInput> = {}): PrecheckInput {
	const branch = [entry("e0"), entry("e1"), entry("e2"), entry("e3"), entry("e4")] as never;
	return {
		snapshotPathIds: ["e0", "e1", "e2", "e3"],
		branchEntries: branch,
		firstKeptEntryId: "e3",
		firstKeptStillLegal: true,
		compressedRegionIds: COMPRESSED,
		tnAtSnapshot: 100_000,
		tnNow: 100_000,
		summaryValidated: true,
		applySafe: true,
		estimatePostTokens: 50_000,
		hardFitLimit: 90_000,
		efficiencyLimit: 60_000,
		degraded: false,
		signalAborted: false,
		sameBoundaryEntries: [],
		...over,
	};
}

test("APP-02: all gates pass → propose", () => {
	assert.deepEqual(runPrechecks(passingInput()), { action: "propose" });
});

test("APP-02 V1: branch divergence (non-prefix) discards", () => {
	const outcome = runPrechecks(passingInput({ branchEntries: [entry("x0"), entry("e2"), entry("e3"), entry("e4")] as never }));
	assert.deepEqual(outcome, { action: "discard", reason: "v1-branch-prefix" });
});

test("APP-02 V2: a newer compaction after the snapshot discards", () => {
	const branch = [entry("e0"), entry("e1"), entry("e2"), entry("e3"), entry("new-compact", "compaction")] as never;
	assert.deepEqual(runPrechecks(passingInput({ branchEntries: branch })), { action: "discard", reason: "v2-new-compaction" });
});

test("APP-02 V3: missing or illegal firstKept discards", () => {
	assert.deepEqual(
		runPrechecks(passingInput({ firstKeptEntryId: "gone" })),
		{ action: "discard", reason: "v3-cut-invalid" },
	);
	assert.deepEqual(
		runPrechecks(passingInput({ firstKeptStillLegal: false })),
		{ action: "discard", reason: "v3-cut-invalid" },
	);
});

test("APP-02 V4: a post-snapshot context_edit targeting the compressed region discards", () => {
	const branch = [
		entry("e0"), entry("e1"), entry("e2"), entry("e3"),
		{ ...entry("edit-1", "context_edit"), targetId: "e1", replacement: null },
	] as never;
	assert.deepEqual(runPrechecks(passingInput({ branchEntries: branch })), { action: "discard", reason: "v4-conflict-edit" });
	// An edit aimed at the KEPT tail does not poison the snapshot.
	const tailEdit = [
		entry("e0"), entry("e1"), entry("e2"), entry("e3"), entry("e4"),
		{ ...entry("edit-2", "context_edit"), targetId: "e4", replacement: null },
	] as never;
	assert.deepEqual(runPrechecks(passingInput({ branchEntries: tailEdit, snapshotPathIds: ["e0", "e1", "e2", "e3", "e4"] })), { action: "propose" });
});

test("APP-02 V5: T_n drift beyond 10% discards; within tolerance passes", () => {
	assert.deepEqual(runPrechecks(passingInput({ tnNow: 125_000 })), { action: "discard", reason: "v5-window-shift" });
	assert.deepEqual(runPrechecks(passingInput({ tnNow: 105_000 })), { action: "propose" });
});

test("APP-02 V6: unvalidated summary discards", () => {
	assert.deepEqual(runPrechecks(passingInput({ summaryValidated: false })), { action: "discard", reason: "v6-summary-invalid" });
});

test("APP-02 V7: unsafe boundary (POL-07) discards", () => {
	assert.deepEqual(runPrechecks(passingInput({ applySafe: false })), { action: "discard", reason: "v7-unsafe-boundary" });
});

test("APP-02 V8a: hard-fit overflow discards even without the efficiency gate", () => {
	assert.deepEqual(
		runPrechecks(passingInput({ estimatePostTokens: 95_000, hardFitLimit: 90_000, efficiencyLimit: undefined })),
		{ action: "discard", reason: "v8a-hard-fit" },
	);
});

test("APP-02 V8b: draft-only efficiency gate discards when hard-fit would pass", () => {
	assert.deepEqual(
		runPrechecks(passingInput({ estimatePostTokens: 65_000, hardFitLimit: 90_000, efficiencyLimit: 60_000 })),
		{ action: "discard", reason: "v8b-efficiency" },
	);
});

test("APP-02 V9: degraded/aborted discards", () => {
	assert.deepEqual(runPrechecks(passingInput({ degraded: true })), { action: "discard", reason: "v9-degraded" });
	assert.deepEqual(runPrechecks(passingInput({ signalAborted: true })), { action: "discard", reason: "v9-degraded" });
});

test("APP-02 V10: same-boundary conflicts HOLD — snapshot survives for the next boundary", () => {
	const withCompaction = [{ type: "compaction", summary: "other", firstKeptEntryId: "e3" }];
	assert.deepEqual(runPrechecks(passingInput({ sameBoundaryEntries: withCompaction })), { action: "hold" });
	const withEdit = [{ type: "context_edit", targetId: "e1", replacement: null }];
	assert.deepEqual(runPrechecks(passingInput({ sameBoundaryEntries: withEdit })), { action: "hold" });
	// Harmless same-boundary entries do not block.
	assert.deepEqual(
		runPrechecks(passingInput({ sameBoundaryEntries: [{ type: "context_edit", targetId: "e4", replacement: null }] })),
		{ action: "propose" },
	);
});

test("APP-06: malformed precheck inputs never throw (total function)", () => {
	// Missing ids, wrong shapes — the gates degrade to a discard, never throw.
	const weird = runPrechecks(
		passingInput({
			branchEntries: [{ type: "message" }] as never,
			snapshotPathIds: [""],
			sameBoundaryEntries: [null as never, 42 as never],
		}),
	);
	assert.ok(weird.action === "discard" || weird.action === "hold");
});

test("APP-01: draft shape (nonce, ccCore origin, file lists) and append-only merge", () => {
	const draft = buildDraft({
		summary: "final summary text",
		firstKeptEntryId: "e3",
		readFiles: ["/a.ts"],
		modifiedFiles: ["/b.ts"],
		proposalId: "nonce-1",
		cutClass: "user",
		providers: ["generic"],
		usage: { totalTokens: 42 },
	});
	assert.equal(draft.type, "compaction");
	assert.equal(draft.details.ccCore.v, 1);
	assert.equal(draft.details.ccCore.origin, "precompute");
	assert.equal(draft.details.ccCore.proposalId, "nonce-1");
	assert.deepEqual(draft.details.readFiles, ["/a.ts"]);
	// Append-only (H5(a)): the draft lands AFTER earlier handlers' entries.
	const merged = mergeDraftEntries([{ type: "context_edit", targetId: "e9" }], draft);
	assert.deepEqual(merged.entries, [{ type: "context_edit", targetId: "e9" }, draft]);
});

function branchWith(...entries: Array<Record<string, unknown>>): never {
	return entries as never;
}

test("APP-08: reconcile hits OUR nonce → committed with the real entryId", () => {
	const proposalId = randomUUID();
	const branch = branchWith(
		entry("e0"), entry("e1"), entry("e2"), entry("e3"), entry("e4"),
		{ ...entry("c-1", "compaction"), summary: "s", firstKeptEntryId: "e3", details: { ccCore: { v: 1, proposalId } } },
	);
	const result = reconcile(branch as never, proposalId, 50, false, COMPRESSED);
	assert.equal(result.status, "committed");
	assert.equal(result.entryId, "c-1");
	assert.equal(result.conflictEdits, 0);
});

test("APP-08/V4': post-commit context_edits targeting the compressed region are counted", () => {
	const proposalId = randomUUID();
	const branch = branchWith(
		entry("e0"), entry("e1"), entry("e2"), entry("e3"), entry("e4"),
		{ ...entry("c-1", "compaction"), summary: "s", firstKeptEntryId: "e3", details: { ccCore: { v: 1, proposalId } } },
		{ ...entry("edit-1", "context_edit"), targetId: "e1", replacement: null },
		{ ...entry("edit-2", "context_edit"), targetId: "e2", replacement: null },
		{ ...entry("edit-3", "context_edit"), targetId: "e4", replacement: null }, // tail — not a conflict
	);
	const result = reconcile(branch as never, proposalId, 50, false, COMPRESSED);
	assert.equal(result.status, "committed");
	assert.equal(result.conflictEdits, 2);
});

test("APP-08: nonce miss → lost(overridden); session_tree since proposal → lost(branch-changed)", () => {
	const branch = branchWith(
		entry("e0"), entry("e1"), entry("e2"), entry("e3"), entry("e4"),
		{ ...entry("c-1", "compaction"), summary: "someone else's", firstKeptEntryId: "e3" }, // no ccCore
	);
	const overridden = reconcile(branch as never, "nonce-x", 50, false, COMPRESSED);
	assert.deepEqual(overridden, { status: "lost", lostReason: "overridden" });
	const treeLost = reconcile(branch as never, "nonce-x", 50, true, COMPRESSED);
	assert.deepEqual(treeLost, { status: "lost", lostReason: "branch-changed" });
});

test("APP-08: the nonce beyond scanMax is not found (windowed scan)", () => {
	const proposalId = randomUUID();
	const head = Array.from({ length: 10 }, (_, i) => entry(`pad-${i}`));
	const tail = Array.from({ length: 50 }, (_, i) => entry(`tail-${i}`));
	const branch = branchWith(
		...head,
		{ ...entry("c-far", "compaction"), summary: "s", firstKeptEntryId: "e3", details: { ccCore: { v: 1, proposalId } } },
		...tail,
	);
	const result = reconcile(branch as never, proposalId, 10, false, COMPRESSED);
	assert.equal(result.status, "lost");
	// A generous window finds it.
	const found = reconcile(branch as never, proposalId, 70, false, COMPRESSED);
	assert.equal(found.status, "committed");
});
