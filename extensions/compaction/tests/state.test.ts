/*
 * State/runtime tests (SPEC SC §5.2/§5.10 ST-01/ST-05, task W3).
 *
 * Requirement → test map:
 *   ST-01 → telemetry entry shape + every outcome path (refused/applied/
 *            discarded), display-only type name, INV-7 (no summary text)
 *   APP-05 → onProposed fires before (intent, no entryId); onReconciled
 *            committed fires after exactly once WITH the real entryId; lost
 *            never fires after (snapshot voided, INV-5)
 *   APP-08 → conflict-edit accumulation degrades to shadow at the threshold
 *   ST-05 → degrade is sticky until session reset
 *   SUM-07 → stale-generation compute results are dropped
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { SessionRuntime, buildTelemetryEntry, TELEMETRY_ENTRY_TYPE, type CompactionTelemetryData } from "../state.ts";
import type { ReconcileResult } from "../apply.ts";
import { DEFAULT_COMPACTION_CORE_SETTINGS, type CompactionSettings } from "../settings.ts";
import { notifyAfter, notifyBefore, registerCompactionSubscriber, resetCompactionSeam } from "../../../lib/compaction-seam.ts";
import type { PrecomputedSnapshot } from "../types.ts";

function runtime(over: Partial<CompactionSettings> = {}) {
	const emitted: CompactionTelemetryData[] = [];
	const before: Array<Record<string, unknown>> = [];
	const after: Array<Record<string, unknown>> = [];
	const rt = new SessionRuntime({
		settings: { ...DEFAULT_COMPACTION_CORE_SETTINGS, ...over },
		emitTelemetry: (data) => emitted.push(data),
		notifyBefore: (info) => before.push({ ...info }),
		notifyAfter: (info) => after.push({ ...info }),
	});
	return { rt, emitted, before, after };
}

function snapshot(generation = 0): PrecomputedSnapshot {
	return {
		generation,
		cut: {
			firstKeptEntryId: "e3",
			firstKeptEntryIndex: 3,
			isSplitTurn: false,
			turnStartIndex: -1,
			tailTokens: 5_000,
			boundaryClass: "user",
			score: 80,
		},
		branchPathIds: ["e0", "e1", "e2", "e3"],
		summary: "x".repeat(500),
		summaryTokens: 125,
		tnAtSnapshot: 100_000,
		validated: true,
	};
}

/** Drive the runtime to phase "ready" via the policy boundary path. */
function driveToReady(rt: SessionRuntime) {
	const decision = rt.onBoundary({ type: "boundary", P: 0.7, applySafe: true, isApplyPoint: false, prechecksPassed: true, feasibility: { feasible: true, effectiveSummaryTokens: 12000, expectedGrowth: 3000, tailMax: 9000000, neededTn: 107000 }, mayCompute: true });
	assert.equal(decision.action.type, "start-computing");
	rt.onComputeSucceeded(snapshot(rt.state.generation), { computeMs: 12 });
}

/** Drive the runtime to phase "proposed" via the policy boundary path. */
function driveToProposed(rt: SessionRuntime, nonce = "n-1") {
	let decision = rt.onBoundary({ type: "boundary", P: 0.7, applySafe: true, isApplyPoint: false, prechecksPassed: true, feasibility: { feasible: true, effectiveSummaryTokens: 12000, expectedGrowth: 3000, tailMax: 9000000, neededTn: 107000 }, mayCompute: true });
	assert.equal(decision.action.type, "start-computing");
	rt.onComputeSucceeded(snapshot(rt.state.generation), { computeMs: 12 });
	decision = rt.onBoundary({ type: "boundary", P: 0.8, applySafe: true, isApplyPoint: true, prechecksPassed: true, feasibility: { feasible: true, effectiveSummaryTokens: 12000, expectedGrowth: 3000, tailMax: 9000000, neededTn: 107000 }, mayCompute: true, proposalNonce: nonce });
	assert.equal(decision.action.type, "propose");
	rt.onProposed({ midRun: false, summaryChars: 500, tokensBefore: 90_000 });
}

test("ST-01: telemetry entry type + frozen field set (SC-ENT-01)", () => {
	const { type, data } = buildTelemetryEntry({ v: 1, outcome: "applied", origin: "precompute", validated: true, summaryChars: 500 });
	assert.equal(type, TELEMETRY_ENTRY_TYPE);
	assert.equal(type, "cc-core-compaction");
	assert.deepEqual(Object.keys(data).sort(), ["outcome", "origin", "summaryChars", "validated", "v"].sort());
});

test("APP-05/ST-01: committed — before (intent, no entryId) then after exactly once with the real entryId; telemetry applied", () => {
	const { rt, emitted, before, after } = runtime();
	driveToProposed(rt, "nonce-a");
	assert.equal(before.length, 1);
	assert.equal(before[0].entryId, undefined);
	assert.equal(before[0].midRun, false);

	const committed: ReconcileResult = { status: "committed", entryId: "real-entry-1", conflictEdits: 0 };
	rt.onReconciled(committed, { midRun: false, summaryChars: 500, tokensBefore: 90_000, estPostTokens: 42_000, applyMs: 8, cutClass: "user" });
	assert.equal(after.length, 1);
	assert.equal(after[0].entryId, "real-entry-1");
	assert.equal(rt.snapshot, null); // INV-5: consumed
	assert.equal(emitted.length, 1);
	assert.equal(emitted[0].outcome, "applied");
	assert.equal(emitted[0].estPostTokens, 42_000);
	assert.ok(!JSON.stringify(emitted[0]).includes("x".repeat(50))); // INV-7: no summary text
	assert.equal(rt.state.phase, "idle");
});

test("APP-05/INV-5: lost — before fired once, NO after, snapshot voided, telemetry discarded", () => {
	const { rt, emitted, before, after } = runtime();
	driveToProposed(rt, "nonce-b");
	rt.onReconciled({ status: "lost", lostReason: "overridden" }, { midRun: false, summaryChars: 500 });
	assert.equal(before.length, 1);
	assert.equal(after.length, 0);
	assert.equal(rt.snapshot, null);
	assert.equal(emitted[0].outcome, "discarded");
	assert.equal(emitted[0].reason, "overridden");
});

test("APP-08/ST-05: conflict-edit audits accumulate and degrade at conflictEditDegradeAfter", () => {
	const { rt } = runtime({ conflictEditDegradeAfter: 2 });
	driveToProposed(rt);
	rt.onReconciled({ status: "committed", entryId: "e", conflictEdits: 1 }, { midRun: false, summaryChars: 10 });
	assert.equal(rt.degraded, false);
	driveToProposed(rt, "n-2");
	rt.onReconciled({ status: "committed", entryId: "e2", conflictEdits: 1 }, { midRun: false, summaryChars: 10 });
	assert.equal(rt.degraded, true); // 2 ≥ 2
});

test("SUM-07: a stale-generation compute success is dropped (no ready transition)", () => {
	const { rt } = runtime();
	const decision = rt.onBoundary({ type: "boundary", P: 0.7, applySafe: true, isApplyPoint: false, prechecksPassed: true, feasibility: { feasible: true, effectiveSummaryTokens: 1, expectedGrowth: 1, tailMax: 1e9, neededTn: 1 }, mayCompute: true });
	assert.equal(decision.action.type, "start-computing");
	rt.onSessionReset(); // generation bumps — the in-flight compute is stale
	rt.onComputeSucceeded(snapshot(0)); // old generation
	assert.equal(rt.state.phase, "idle");
	assert.equal(rt.snapshot, null);
});

test("SUM-05: compute failure refuses with cooldown + telemetry; repeated refusals degrade", () => {
	const { rt, emitted } = runtime({ degradeAfterRefusals: 2 });
	rt.onBoundary({ type: "boundary", P: 0.7, applySafe: true, isApplyPoint: false, prechecksPassed: true, feasibility: { feasible: true, effectiveSummaryTokens: 1, expectedGrowth: 1, tailMax: 1e9, neededTn: 1 }, mayCompute: true });
	rt.onComputeFailed("validation");
	assert.equal(rt.state.phase, "refused");
	assert.equal(emitted[0].outcome, "refused");
	assert.equal(rt.degraded, false);
	// Second refusal crosses degradeAfterRefusals=2.
	rt.state = { ...rt.state, phase: "computing" };
	rt.onComputeFailed("validation");
	assert.equal(rt.degraded, true);
});

test("session reset clears per-session custody and bumps generation", () => {
	const { rt } = runtime();
	driveToProposed(rt);
	const before = rt.state.generation;
	rt.onSessionReset();
	assert.equal(rt.state.generation, before + 1);
	assert.equal(rt.state.phase, "idle");
	assert.equal(rt.snapshot, null);
});

test("ST-05 degrade is sticky across boundaries until reset", () => {
	const { rt } = runtime();
	rt.degrade();
	rt.onBoundary({ type: "boundary", P: 0.9, applySafe: true, isApplyPoint: false, prechecksPassed: true, feasibility: { feasible: true, effectiveSummaryTokens: 1, expectedGrowth: 1, tailMax: 1e9, neededTn: 1 }, mayCompute: true });
	assert.equal(rt.degraded, true);
	rt.onSessionReset();
	assert.equal(rt.degraded, false);
});

// Seam-level wiring sanity for the notify callbacks used above (SM-02
// mechanics already covered in test/lib/compaction-seam.test.ts).
test("runtime notify callbacks route through the real seam when wired", () => {
	resetCompactionSeam();
	const seen: string[] = [];
	registerCompactionSubscriber({
		before: () => seen.push("before"),
		after: () => seen.push("after"),
	});
	const { rt } = runtime({
		// Reuse the class with the REAL seam functions:
	});
	// Rebuild with seam functions:
	const rt2 = new SessionRuntime({
		settings: { ...DEFAULT_COMPACTION_CORE_SETTINGS },
		emitTelemetry: () => {},
		notifyBefore: (info) => notifyBefore(info),
		notifyAfter: (info) => notifyAfter(info),
	});
	void rt;
	driveToProposed(rt2);
	rt2.onReconciled({ status: "committed", entryId: "z-1", conflictEdits: 0 }, { midRun: false, summaryChars: 5 });
	assert.deepEqual(seen, ["before", "after"]);
	resetCompactionSeam();
});

test("A2 rework R4: onServed — from ready → idle + served telemetry; non-ready phase unchanged", () => {
	const mk = () => runtime();
	// non-ready: served is a no-op on the phase — start from computing AND
	// proposed (idle would not distinguish the old unconditional impl)
	for (const phase of ["computing", "proposed"] as const) {
		const { rt } = mk();
		// drive to proposed (which passes through computing) or stop at computing
		const d = rt.onBoundary({ type: "boundary", P: 0.7, applySafe: true, isApplyPoint: false, prechecksPassed: true, feasibility: { feasible: true, effectiveSummaryTokens: 12000, expectedGrowth: 3000, tailMax: 9000000, neededTn: 107000 }, mayCompute: true });
		assert.equal(d.action.type, "start-computing");
		if (phase === "proposed") {
			rt.onComputeSucceeded(snapshot(rt.state.generation), { computeMs: 5 });
			rt.onBoundary({ type: "boundary", P: 0.8, applySafe: true, isApplyPoint: true, prechecksPassed: true, feasibility: { feasible: true, effectiveSummaryTokens: 12000, expectedGrowth: 3000, tailMax: 9000000, neededTn: 107000 }, mayCompute: true, proposalNonce: "sn-1" });
		}
		assert.equal(rt.state.phase, phase);
		rt.onServed();
		assert.equal(rt.state.phase, phase, `served must not move a ${phase} phase`);
	}
	// ready → idle via the policy served event + snapshot cleared + telemetry
	{
		const { rt, emitted } = mk();
		driveToReady(rt);
		assert.equal(rt.state.phase, "ready");
		rt.onServed();
		assert.equal(rt.state.phase, "idle");
		assert.equal(rt.snapshot, null);
		assert.equal(rt.state.lastOutcome?.outcome, "served");
		assert.ok(emitted.some((e) => e.outcome === "served" && e.origin === "native-backfill"));
	}
});

test("A3 rework R3: onOverridden — telemetry every occurrence, degrade at OVERRIDE_DEGRADE_AFTER, phase back to ready, reset clears", () => {
	const { rt, emitted } = runtime();
	rt.onOverridden({ summaryChars: 900 });
	assert.equal(rt.state.phase, "ready"); // BLK-2(a): back to ready, fresh nonce slot
	assert.equal(rt.degraded, false); // 1 < 2
	assert.ok(emitted.some((e) => e.outcome === "discarded" && e.reason === "overridden" && e.origin === "precompute"));
	rt.onOverridden({ summaryChars: 800, estPostTokens: 1200 });
	assert.equal(rt.degraded, true); // 2 >= 2 — degraded
	assert.equal(emitted.filter((e) => e.reason === "overridden").length, 2); // APP-08: EVERY occurrence writes telemetry
	rt.onSessionReset();
	assert.equal(rt.degraded, false); // counters cleared
});

test("A3/R5: conflictEditTotal reset leak — 1 + reset + 1 does NOT degrade (cross-session leak fixed)", () => {
	const { rt } = runtime();
	rt.noteConflictEdits(1); // session A: 1/2
	rt.onSessionReset();
	rt.noteConflictEdits(1); // session B: fresh counter — must NOT reach 2
	assert.equal(rt.degraded, false);
});

test("B5 (2026-11-10 review): infeasible / apply-error / fellthrough telemetry (no phase change)", () => {
	const { rt, emitted } = runtime();
	const phaseBefore = rt.state.phase;
	rt.onInfeasible(123_456);
	rt.onInfeasible();
	rt.onApplyError();
	rt.onFellthrough("deadline");
	rt.onFellthrough("aborted");
	assert.equal(rt.state.phase, phaseBefore); // telemetry-only
	const outcomes = emitted.map((e) => `${e.outcome}:${e.reason}`);
	assert.ok(outcomes.includes("infeasible:pol-09:needTn=123456"));
	assert.ok(outcomes.includes("infeasible:pol-09"));
	assert.ok(outcomes.includes("discarded:apply-error"));
	assert.ok(outcomes.includes("fellthrough:deadline"));
	assert.ok(outcomes.includes("fellthrough:aborted"));
});
