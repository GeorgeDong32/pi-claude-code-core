/*
 * Policy tests (SPEC SC §5.3, task W1).
 *
 * Requirement → test map:
 *   POL-01 → "POL-01 effectiveThreshold …"
 *   POL-02 → "POL-02 validateRatioGroup …"
 *   POL-03 → "POL-03 state machine …" (every §5.2 edge, table-driven)
 *   POL-04 → "POL-04 null pressure …"
 *   POL-06 → "POL-06 resolveMode …"
 *   POL-07 → "POL-07 applyPointSafe …" (stopReason × outcome × recovery flag)
 *   POL-09 → "POL-09 jointFeasibility …" (40K infeasible / 200K feasible /
 *             boundary / adaptive S)
 *   POL-10 → "POL-10 estimatePost …" (overhead calibration, null usage, clamp)
 * Host-side modelOverrides resolution is pinned by SC-HOST-06 (contracts),
 * not here.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
	applyPointSafe,
	effectiveThreshold,
	estimatePost,
	evaluate,
	initialState,
	jointFeasibility,
	pressure,
	resolveMode,
	type PolicyEvent,
	type PolicySettings,
} from "../policy.ts";
import { DEFAULT_COMPACTION_CORE_SETTINGS, validateRatioGroup } from "../settings.ts";
import type { ControllerState } from "../types.ts";

import type { Feasibility } from "../policy.ts";

const SETTINGS: PolicySettings = {
	precomputeRatio: 0.6,
	applyRatio: 0.75,
	refusedCooldownTurns: 15,
	degradeAfterRefusals: 3,
	minPrecomputeGapTurns: 3,
};

function feasible(over: Partial<Feasibility> = {}): Feasibility {
	return {
		feasible: true,
		effectiveSummaryTokens: 12_000,
		expectedGrowth: 3_000,
		tailMax: 9_000_000,
		neededTn: 107_000,
		...over,
	};
}

function boundary(over: Partial<Extract<PolicyEvent, { type: "boundary" }>> = {}): PolicyEvent {
	return {
		type: "boundary",
		P: 0.5,
		applySafe: true,
		isApplyPoint: false,
		prechecksPassed: true,
		feasibility: feasible(),
		mayCompute: true,
		...over,
	};
}

test("POL-01 effectiveThreshold: ok / reserve≥window / missing inputs / non-positive", () => {
	assert.equal(effectiveThreshold(128_000, 16_384), 128_000 - 16_384);
	assert.equal(effectiveThreshold(20_000, 20_000), null); // T_n = 0
	assert.equal(effectiveThreshold(10_000, 20_000), null); // negative
	assert.equal(effectiveThreshold(null, 16_384), null);
	assert.equal(effectiveThreshold(128_000, null), null);
	assert.equal(effectiveThreshold(undefined, undefined), null);
	assert.equal(effectiveThreshold(Number.NaN, 100), null);
});

test("POL-02 validateRatioGroup: valid custom passes; each violation reverts the whole group", () => {
	const custom = validateRatioGroup({
		targetPostRatio: 0.4,
		precomputeRatio: 0.55,
		applyRatio: 0.8,
		hardFitRatio: 0.85,
		overflowFitRatio: 0.7,
	});
	assert.equal(custom.reverted, false);
	assert.deepEqual(custom.ratios, {
		targetPostRatio: 0.4,
		precomputeRatio: 0.55,
		applyRatio: 0.8,
		hardFitRatio: 0.85,
		overflowFitRatio: 0.7,
	});
	const violations: Array<Partial<Record<"targetPostRatio" | "precomputeRatio" | "applyRatio" | "hardFitRatio" | "overflowFitRatio", number>>> = [
		{ targetPostRatio: 0.65 }, // q ≥ p
		{ precomputeRatio: 0.8 }, // p ≥ a
		{ applyRatio: 1.0 }, // a ≥ 1
		{ targetPostRatio: 0 }, // q ≤ 0
		{ hardFitRatio: 1.2 }, // h > 1
		{ overflowFitRatio: 0.95 }, // o > h
	];
	for (const violation of violations) {
		const result = validateRatioGroup({ ...DEFAULT_COMPACTION_CORE_SETTINGS, ...violation });
		assert.equal(result.reverted, true, `violation ${JSON.stringify(violation)} should revert`);
		assert.deepEqual(result.ratios, {
			targetPostRatio: DEFAULT_COMPACTION_CORE_SETTINGS.targetPostRatio,
			precomputeRatio: DEFAULT_COMPACTION_CORE_SETTINGS.precomputeRatio,
			applyRatio: DEFAULT_COMPACTION_CORE_SETTINGS.applyRatio,
			hardFitRatio: DEFAULT_COMPACTION_CORE_SETTINGS.hardFitRatio,
			overflowFitRatio: DEFAULT_COMPACTION_CORE_SETTINGS.overflowFitRatio,
		});
	}
});

test("POL-03 state machine: every §5.2 edge, table-driven", () => {
	const base = initialState();

	// idle → computing on P ≥ preRatio at a boundary (§5.2).
	let d = evaluate(base, boundary({ P: 0.61 }), SETTINGS);
	assert.equal(d.state.phase, "computing");
	assert.equal(d.action.type, "start-computing");

	// idle, P < preRatio → nothing.
	d = evaluate(base, boundary({ P: 0.59 }), SETTINGS);
	assert.equal(d.state.phase, "idle");
	assert.equal(d.action.type, "none");

	// idle, null pressure → nothing (POL-04).
	d = evaluate(base, boundary({ P: null }), SETTINGS);
	assert.equal(d.state.phase, "idle");
	assert.equal(d.action.type, "none");

	// idle, mayCompute false → nothing.
	d = evaluate(base, boundary({ P: 0.9, mayCompute: false }), SETTINGS);
	assert.equal(d.state.phase, "idle");

	// computing + boundary → single-flight, no second start.
	const computing: ControllerState = { ...base, phase: "computing" };
	d = evaluate(computing, boundary({ P: 0.95 }), SETTINGS);
	assert.equal(d.state.phase, "computing");
	assert.equal(d.action.type, "none");

	// computing + compute-ok → ready.
	d = evaluate(computing, { type: "compute-ok" }, SETTINGS);
	assert.equal(d.state.phase, "ready");

	// computing + compute-failed (retry left) → still computing.
	d = evaluate(computing, { type: "compute-failed", retryExhausted: false }, SETTINGS);
	assert.equal(d.state.phase, "computing");

	// computing + compute-failed (exhausted) → refused + cooldown + refusals++.
	d = evaluate(computing, { type: "compute-failed", retryExhausted: true }, SETTINGS);
	assert.equal(d.state.phase, "refused");
	assert.equal(d.state.refusedCooldownTurns, 15);
	assert.equal(d.state.refusals, 1);
	assert.deepEqual(d.action, { type: "refuse", cooldownTurns: 15 });

	// refused + boundary decrements cooldown; cannot start while > 0.
	const refused: ControllerState = { ...base, phase: "refused", refusedCooldownTurns: 2 };
	d = evaluate(refused, boundary({ P: 0.9 }), SETTINGS);
	assert.equal(d.state.phase, "refused");
	assert.equal(d.state.refusedCooldownTurns, 1);
	assert.equal(d.action.type, "none");
	d = evaluate(d.state, boundary({ P: 0.9 }), SETTINGS);
	assert.equal(d.state.refusedCooldownTurns, 0);
	assert.equal(d.state.phase, "computing"); // cooldown over → may start again
	assert.equal(d.action.type, "start-computing");

	// degrade after degradeAfterRefusals accumulated refusals (SUM-05 counter).
	let state = { ...base, phase: "computing", refusals: 2 } as ControllerState;
	d = evaluate(state, { type: "compute-failed", retryExhausted: true }, SETTINGS);
	assert.equal(d.state.degraded, true); // 3 ≥ 3

	// ready + non-apply boundary → stays ready.
	const ready: ControllerState = { ...base, phase: "ready" };
	d = evaluate(ready, boundary({ P: 0.7, isApplyPoint: false }), SETTINGS);
	assert.equal(d.state.phase, "ready");

	// ready + apply point + P ≥ applyRatio + safe + prechecks → proposed.
	d = evaluate(ready, boundary({ P: 0.76, isApplyPoint: true, proposalNonce: "n1" }), SETTINGS);
	assert.equal(d.state.phase, "proposed");
	assert.equal(d.state.proposalId, "n1");
	assert.deepEqual(d.action, { type: "propose", proposalId: "n1" });

	// ready + apply point but P < applyRatio → stays ready.
	d = evaluate(ready, boundary({ P: 0.74, isApplyPoint: true }), SETTINGS);
	assert.equal(d.state.phase, "ready");

	// ready + apply point but applySafe false → stays ready.
	d = evaluate(ready, boundary({ P: 0.9, isApplyPoint: true, applySafe: false }), SETTINGS);
	assert.equal(d.state.phase, "ready");

	// ready + apply point but V-gate failed → discarded, gap enforced.
	d = evaluate(ready, boundary({ P: 0.9, isApplyPoint: true, prechecksPassed: false }), SETTINGS);
	assert.equal(d.state.phase, "idle");
	assert.equal(d.state.precomputeGapTurns, 3);
	assert.equal(d.state.lastOutcome?.outcome, "discarded");
	// …and the gap blocks an immediate restart.
	d = evaluate(d.state, boundary({ P: 0.9 }), SETTINGS);
	assert.equal(d.state.phase, "idle");
	assert.equal(d.action.type, "none");

	// proposed + boundary → no re-propose (INV-5).
	const proposed: ControllerState = { ...base, phase: "proposed", proposalId: "p1" };
	d = evaluate(proposed, boundary({ P: 0.95, isApplyPoint: true }), SETTINGS);
	assert.equal(d.state.phase, "proposed");
	assert.equal(d.action.type, "none");

	// proposed + reconcile-committed → idle + applied outcome.
	d = evaluate(proposed, { type: "reconcile-committed" }, SETTINGS);
	assert.equal(d.state.phase, "idle");
	assert.equal(d.state.proposalId, undefined);
	assert.equal(d.state.lastOutcome?.outcome, "applied");

	// proposed + reconcile-lost(overridden) → idle + discarded outcome.
	d = evaluate(proposed, { type: "reconcile-lost", reason: "overridden" }, SETTINGS);
	assert.equal(d.state.phase, "idle");
	assert.equal(d.state.lastOutcome?.outcome, "discarded");
	assert.equal(d.state.lastOutcome?.reason, "overridden");

	// idle + P ≥ preRatio but infeasible → infeasible-window + mark action.
	d = evaluate(base, boundary({ P: 0.7, feasibility: feasible({ feasible: false, neededTn: 107_000 }) }), SETTINGS);
	assert.equal(d.state.phase, "infeasible-window");
	assert.equal(d.action.type, "mark-infeasible");
	assert.equal((d.action as { neededTn?: number }).neededTn, 107_000);

	// infeasible-window + still-infeasible boundary → stays (no new action).
	const infeasible: ControllerState = { ...base, phase: "infeasible-window", infeasibleReported: true };
	d = evaluate(infeasible, boundary({ P: 0.9, feasibility: feasible({ feasible: false }) }), SETTINGS);
	assert.equal(d.state.phase, "infeasible-window");
	assert.equal(d.action.type, "none"); // telemetry emitted once per session

	// infeasible-window + feasible boundary → back to idle (and can compute).
	d = evaluate(infeasible, boundary({ P: 0.9, feasibility: feasible() }), SETTINGS);
	assert.equal(d.state.phase, "computing");
	assert.equal(d.action.type, "start-computing");

	// session-reset → generation++, fresh state (late results dropped).
	d = evaluate(proposed, { type: "session-reset" }, SETTINGS);
	assert.equal(d.state.phase, "idle");
	assert.equal(d.state.generation, 1);
	assert.equal(d.state.turns, 0);

	// events on wrong phase are no-ops (total function, INV-1 shape).
	d = evaluate(base, { type: "compute-ok" }, SETTINGS);
	assert.equal(d.action.type, "none");
	d = evaluate(base, { type: "reconcile-committed" }, SETTINGS);
	assert.equal(d.action.type, "none");
	d = evaluate(base, { type: "discard", reason: "v8a-hard-fit" }, SETTINGS);
	assert.equal(d.action.type, "none");
});

test("POL-04 pressure(): null tokens or bad T_n → null", () => {
	assert.equal(pressure(null, 100_000), null);
	assert.equal(pressure(50_000, null), null);
	assert.equal(pressure(50_000, 0), null);
	assert.equal(pressure(75_000, 100_000), 0.75);
});

test("POL-06 resolveMode: version gate wins, native-disabled → shadow, off respected", () => {
	assert.deepEqual(resolveMode("on", false, true), { mode: "shadow", reason: "compaction.enabled=false; forced shadow" });
	assert.deepEqual(resolveMode("shadow", false, true), { mode: "shadow", reason: "compaction.enabled=false; forced shadow" });
	assert.deepEqual(resolveMode("on", true, false), { mode: "off", reason: "pi < 1.5.0 or compat probe failed; forced off" });
	assert.deepEqual(resolveMode("on", false, false), { mode: "off", reason: "pi < 1.5.0 or compat probe failed; forced off" });
	assert.deepEqual(resolveMode("off", true, true), { mode: "off" });
	assert.deepEqual(resolveMode("on", true, true), { mode: "on" });
	assert.deepEqual(resolveMode("shadow", true, true), { mode: "shadow" });
});

test("POL-07 applyPointSafe: stopReason × recovery-flag matrix (outcome completed is NOT sufficient)", () => {
	// Clean stop / toolUse with no pending recovery → safe.
	assert.equal(applyPointSafe({ stopReason: "stop", outcome: "completed", nativeRecoveryPending: false }), true);
	assert.equal(applyPointSafe({ stopReason: "toolUse", outcome: "toolUse", nativeRecoveryPending: false }), true);
	// length maps to outcome "completed" in the host (H12) — must be rejected.
	assert.equal(applyPointSafe({ stopReason: "length", outcome: "completed", nativeRecoveryPending: false }), false);
	assert.equal(applyPointSafe({ stopReason: "error", outcome: "error", nativeRecoveryPending: false }), false);
	assert.equal(applyPointSafe({ stopReason: "aborted", outcome: "aborted", nativeRecoveryPending: false }), false);
	// Pending native recovery poisons every boundary.
	assert.equal(applyPointSafe({ stopReason: "stop", outcome: "completed", nativeRecoveryPending: true }), false);
	// Nothing to evaluate → cannot verify → unsafe.
	assert.equal(applyPointSafe({ outcome: "completed", nativeRecoveryPending: false }), false);
});

test("POL-09 jointFeasibility: 40K infeasible, 200K feasible, boundary, adaptive S, neededTn", () => {
	const defaults = {
		keepRecentTokens: 20_000,
		summaryTokenEstimate: 12_000,
		precomputeRatio: 0.6,
		applyRatio: 0.75,
		targetPostRatio: 0.45,
	};
	const small = jointFeasibility({ ...defaults, tn: 40_000 });
	assert.equal(small.feasible, false);
	assert.ok(small.neededTn > 40_000);

	const large = jointFeasibility({ ...defaults, tn: 200_000 });
	assert.equal(large.feasible, true);
	// S = 12000, G = 0.15·T; keep+S+G = 32k+30k = 62k ≤ 0.45·200k = 90k.
	assert.equal(large.effectiveSummaryTokens, 12_000);
	assert.ok(Math.abs(large.expectedGrowth - 30_000) < 1e-6);
	assert.ok(Math.abs(large.tailMax - (0.45 * 200_000 - 12_000 - 30_000)) < 1e-6);

	// Boundary: keep + S + G == q·T exactly ⇒ feasible (≤).
	const boundaryTn = (20_000 + 12_000) / (0.45 + 0.6 - 0.75);
	const atBoundary = jointFeasibility({ ...defaults, tn: boundaryTn });
	assert.equal(atBoundary.feasible, true);
	assert.ok(Math.abs(atBoundary.neededTn - boundaryTn) < 1e-9);

	// Adaptive S: a 20k-token previous summary raises S to 24k (1.2×).
	const adapted = jointFeasibility({ ...defaults, tn: 200_000, lastSummaryTokens: 20_000 });
	assert.equal(adapted.effectiveSummaryTokens, 24_000);
	// Default floor still applies when the last summary was tiny.
	const floored = jointFeasibility({ ...defaults, tn: 200_000, lastSummaryTokens: 1_000 });
	assert.equal(floored.effectiveSummaryTokens, 12_000);
});

test("POL-10 estimatePost: summary + tail + calibrated overhead; null usage path; clamps", () => {
	const summary = "x".repeat(4_000); // ≈1000 tokens via chars/4
	const kept = [
		{ role: "user", content: [{ type: "text", text: "y".repeat(2_000) }] },
		{ role: "assistant", content: [{ type: "text", text: "z".repeat(1_200) }] },
	] as never[];
	const projection = [
		{ role: "system", content: [{ type: "text", text: "s".repeat(4_000) }] },
		...kept,
	] as never[];

	// Calibrated: usage 2000 above the projection estimate → overhead 2000.
	const calibrated = estimatePost({
		summary,
		keptMessages: kept,
		currentProjectionMessages: projection,
		ctxTokensUsage: 2_000 + 1_000 + 500 + 300,
		contextWindow: 128_000,
		unknownOverheadTokens: 8_000,
	});
	assert.equal(calibrated.overhead, 2_000);
	assert.equal(calibrated.summaryTokens, 1_000);
	assert.equal(calibrated.tailTokens, 500 + 300);
	assert.equal(calibrated.total, 1_000 + 800 + 2_000);

	// Null usage (H7 window) → conservative unknownOverheadTokens.
	const unknown = estimatePost({
		summary,
		keptMessages: kept,
		currentProjectionMessages: projection,
		ctxTokensUsage: null,
		contextWindow: 128_000,
		unknownOverheadTokens: 8_000,
	});
	assert.equal(unknown.overhead, 8_000);

	// Negative calibration → 0; absurd calibration clamps at 0.3·window.
	const negative = estimatePost({
		summary,
		keptMessages: kept,
		currentProjectionMessages: projection,
		ctxTokensUsage: 0,
		contextWindow: 128_000,
		unknownOverheadTokens: 8_000,
	});
	assert.equal(negative.overhead, 0);
	const clamped = estimatePost({
		summary,
		keptMessages: kept,
		currentProjectionMessages: projection,
		ctxTokensUsage: 1_000_000,
		contextWindow: 128_000,
		unknownOverheadTokens: 8_000,
	});
	assert.equal(clamped.overhead, Math.floor(0.3 * 128_000));
});

test("A1 (2026-11-10 review P0): length boundary never proposes — ready snapshot + apply window + all gates pass, still idle", () => {
	// Build a ready state (P above applyRatio, apply-safe, checks passed),
	// then hit a length boundary: the proposal MUST be withheld so native
	// recovery (H12/H13) is not swallowed by a draft.
	let d = evaluate(initialState(), boundary({ P: 0.61 }), SETTINGS);
	assert.equal(d.action.type, "start-computing");
	const ready = evaluate(d.state, { type: "compute-ok" }, SETTINGS).state;
	assert.equal(ready.phase, "ready");
	d = evaluate(
		ready,
		boundary({ P: 0.8, isApplyPoint: true, applySafe: true, prechecksPassed: true, lastAssistantStopReason: "length", proposalNonce: "n1" }),
		SETTINGS,
	);
	assert.equal(d.state.phase, "ready"); // stays ready — no proposal
	assert.equal(d.action.type, "none");
	// Same boundary with a clean stop DOES propose.
	d = evaluate(
		ready,
		boundary({ P: 0.8, isApplyPoint: true, applySafe: true, prechecksPassed: true, lastAssistantStopReason: "stop", proposalNonce: "n2" }),
		SETTINGS,
	);
	assert.equal(d.state.phase, "proposed");
	assert.equal(d.action.type, "propose");
});

test("A2: served event leaves ready → idle (fallback supply consumed the snapshot)", () => {
	let d = evaluate(initialState(), boundary({ P: 0.61 }), SETTINGS);
	const ready = evaluate(d.state, { type: "compute-ok" }, SETTINGS).state;
	assert.equal(ready.phase, "ready");
	d = evaluate(ready, boundary({ P: 0.8, served: true }), SETTINGS);
	assert.equal(d.state.phase, "idle");
	assert.equal(d.state.lastOutcome?.outcome, "served");
	// Post-served boundary can start a fresh precompute cycle.
	d = evaluate(d.state, boundary({ P: 0.61 }), SETTINGS);
	assert.equal(d.action.type, "start-computing");
});
