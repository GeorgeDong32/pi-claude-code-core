import assert from "node:assert/strict";
import { test } from "node:test";
import type { ControllerPhase } from "../types.ts";

import {
	applyPointSafe,
	lastAssistantStopReason,
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
	assert.equal(effectiveThreshold(20_000, 20_000), null);
	assert.equal(effectiveThreshold(10_000, 20_000), null);
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
		{ targetPostRatio: 0.65 },
		{ precomputeRatio: 0.8 },
		{ applyRatio: 1.0 },
		{ targetPostRatio: 0 },
		{ hardFitRatio: 1.2 },
		{ overflowFitRatio: 0.95 },
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

	let d = evaluate(base, boundary({ P: 0.61 }), SETTINGS);
	assert.equal(d.state.phase, "computing");
	assert.equal(d.action.type, "start-computing");

	d = evaluate(base, boundary({ P: 0.59 }), SETTINGS);
	assert.equal(d.state.phase, "idle");
	assert.equal(d.action.type, "none");

	d = evaluate(base, boundary({ P: null }), SETTINGS);
	assert.equal(d.state.phase, "idle");
	assert.equal(d.action.type, "none");

	d = evaluate(base, boundary({ P: 0.9, mayCompute: false }), SETTINGS);
	assert.equal(d.state.phase, "idle");

	const computing: ControllerState = { ...base, phase: "computing" };
	d = evaluate(computing, boundary({ P: 0.95 }), SETTINGS);
	assert.equal(d.state.phase, "computing");
	assert.equal(d.action.type, "none");

	d = evaluate(computing, { type: "compute-ok" }, SETTINGS);
	assert.equal(d.state.phase, "ready");

	d = evaluate(computing, { type: "compute-failed", retryExhausted: false }, SETTINGS);
	assert.equal(d.state.phase, "computing");

	d = evaluate(computing, { type: "compute-failed", retryExhausted: true }, SETTINGS);
	assert.equal(d.state.phase, "refused");
	assert.equal(d.state.refusedCooldownTurns, 15);
	assert.equal(d.state.refusals, 1);
	assert.deepEqual(d.action, { type: "refuse", cooldownTurns: 15 });

	const refused: ControllerState = { ...base, phase: "refused", refusedCooldownTurns: 2 };
	d = evaluate(refused, boundary({ P: 0.9 }), SETTINGS);
	assert.equal(d.state.phase, "refused");
	assert.equal(d.state.refusedCooldownTurns, 1);
	assert.equal(d.action.type, "none");
	d = evaluate(d.state, boundary({ P: 0.9 }), SETTINGS);
	assert.equal(d.state.refusedCooldownTurns, 0);
	assert.equal(d.state.phase, "computing");
	assert.equal(d.action.type, "start-computing");

	let state = { ...base, phase: "computing", refusals: 2 } as ControllerState;
	d = evaluate(state, { type: "compute-failed", retryExhausted: true }, SETTINGS);
	assert.equal(d.state.degraded, true);

	const ready: ControllerState = { ...base, phase: "ready" };
	d = evaluate(ready, boundary({ P: 0.7, isApplyPoint: false }), SETTINGS);
	assert.equal(d.state.phase, "ready");

	d = evaluate(ready, boundary({ P: 0.76, isApplyPoint: true, proposalNonce: "n1" }), SETTINGS);
	assert.equal(d.state.phase, "proposed");
	assert.equal(d.state.proposalId, "n1");
	assert.deepEqual(d.action, { type: "propose", proposalId: "n1" });

	d = evaluate(ready, boundary({ P: 0.74, isApplyPoint: true }), SETTINGS);
	assert.equal(d.state.phase, "ready");

	d = evaluate(ready, boundary({ P: 0.9, isApplyPoint: true, applySafe: false }), SETTINGS);
	assert.equal(d.state.phase, "ready");

	d = evaluate(ready, boundary({ P: 0.9, isApplyPoint: true, prechecksPassed: false }), SETTINGS);
	assert.equal(d.state.phase, "idle");
	assert.equal(d.state.precomputeGapTurns, 3);
	assert.equal(d.state.lastOutcome?.outcome, "discarded");
	d = evaluate(d.state, boundary({ P: 0.9 }), SETTINGS);
	assert.equal(d.state.phase, "idle");
	assert.equal(d.action.type, "none");

	const proposed: ControllerState = { ...base, phase: "proposed", proposalId: "p1" };
	d = evaluate(proposed, boundary({ P: 0.95, isApplyPoint: true }), SETTINGS);
	assert.equal(d.state.phase, "proposed");
	assert.equal(d.action.type, "none");

	d = evaluate(proposed, { type: "reconcile-committed" }, SETTINGS);
	assert.equal(d.state.phase, "idle");
	assert.equal(d.state.proposalId, undefined);
	assert.equal(d.state.lastOutcome?.outcome, "applied");

	d = evaluate(proposed, { type: "reconcile-lost", reason: "overridden" }, SETTINGS);
	assert.equal(d.state.phase, "idle");
	assert.equal(d.state.lastOutcome?.outcome, "discarded");
	assert.equal(d.state.lastOutcome?.reason, "overridden");

	d = evaluate(base, boundary({ P: 0.7, feasibility: feasible({ feasible: false, neededTn: 107_000 }) }), SETTINGS);
	assert.equal(d.state.phase, "infeasible-window");
	assert.equal(d.action.type, "mark-infeasible");
	assert.equal((d.action as { neededTn?: number }).neededTn, 107_000);

	const infeasible: ControllerState = { ...base, phase: "infeasible-window", infeasibleReported: true };
	d = evaluate(infeasible, boundary({ P: 0.9, feasibility: feasible({ feasible: false }) }), SETTINGS);
	assert.equal(d.state.phase, "infeasible-window");
	assert.equal(d.action.type, "none");

	d = evaluate(infeasible, boundary({ P: 0.9, feasibility: feasible() }), SETTINGS);
	assert.equal(d.state.phase, "computing");
	assert.equal(d.action.type, "start-computing");

	d = evaluate(proposed, { type: "session-reset" }, SETTINGS);
	assert.equal(d.state.phase, "idle");
	assert.equal(d.state.generation, 1);
	assert.equal(d.state.turns, 0);

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
	assert.equal(applyPointSafe({ stopReason: "stop", outcome: "completed", nativeRecoveryPending: false }), true);
	assert.equal(applyPointSafe({ stopReason: "toolUse", outcome: "toolUse", nativeRecoveryPending: false }), true);
	// length maps to outcome "completed" in the host — must be rejected.
	assert.equal(applyPointSafe({ stopReason: "length", outcome: "completed", nativeRecoveryPending: false }), false);
	assert.equal(applyPointSafe({ stopReason: "error", outcome: "error", nativeRecoveryPending: false }), false);
	assert.equal(applyPointSafe({ stopReason: "aborted", outcome: "aborted", nativeRecoveryPending: false }), false);
	assert.equal(applyPointSafe({ stopReason: "stop", outcome: "completed", nativeRecoveryPending: true }), false);
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
	assert.equal(large.effectiveSummaryTokens, 12_000);
	assert.ok(Math.abs(large.expectedGrowth - 30_000) < 1e-6);
	assert.ok(Math.abs(large.tailMax - (0.45 * 200_000 - 12_000 - 30_000)) < 1e-6);

	const boundaryTn = (20_000 + 12_000) / (0.45 + 0.6 - 0.75);
	const atBoundary = jointFeasibility({ ...defaults, tn: boundaryTn });
	assert.equal(atBoundary.feasible, true);
	assert.ok(Math.abs(atBoundary.neededTn - boundaryTn) < 1e-9);

	const adapted = jointFeasibility({ ...defaults, tn: 200_000, lastSummaryTokens: 20_000 });
	assert.equal(adapted.effectiveSummaryTokens, 24_000);
	const floored = jointFeasibility({ ...defaults, tn: 200_000, lastSummaryTokens: 1_000 });
	assert.equal(floored.effectiveSummaryTokens, 12_000);
});

test("POL-10 estimatePost: summary + tail + calibrated overhead; null usage path; clamps", () => {
	const summary = "x".repeat(4_000);
	const kept = [
		{ role: "user", content: [{ type: "text", text: "y".repeat(2_000) }] },
		{ role: "assistant", content: [{ type: "text", text: "z".repeat(1_200) }] },
	] as never[];
	const projection = [
		{ role: "system", content: [{ type: "text", text: "s".repeat(4_000) }] },
		...kept,
	] as never[];

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

	const unknown = estimatePost({
		summary,
		keptMessages: kept,
		currentProjectionMessages: projection,
		ctxTokensUsage: null,
		contextWindow: 128_000,
		unknownOverheadTokens: 8_000,
	});
	assert.equal(unknown.overhead, 8_000);

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

test("A1 rework R1: lastAssistantStopReason — backward scan of the session branch", () => {
	const asst = (stop: unknown) => ({ type: "message", message: { role: "assistant", stopReason: stop } });
	assert.equal(lastAssistantStopReason([]), undefined);
	assert.equal(lastAssistantStopReason([asst("stop"), asst("length")]), "length");
	assert.equal(
		lastAssistantStopReason([asst("stop"), { type: "toolResult" }, { type: "custom", data: {} }, { type: "compaction" }]),
		"stop",
	);
	assert.equal(lastAssistantStopReason([{ type: "toolResult" }, { type: "message", message: { role: "user", content: [] } }]), undefined);
	assert.equal(lastAssistantStopReason([asst(123)]), undefined);
});

test("A1 rework R1: length boundary never proposes (branch authority via applySafe)", () => {
	let d = evaluate(initialState(), boundary({ P: 0.61 }), SETTINGS);
	const ready = evaluate(d.state, { type: "compute-ok" }, SETTINGS).state;
	d = evaluate(ready, boundary({ P: 0.8, isApplyPoint: true, applySafe: false, prechecksPassed: true, proposalNonce: "n1" }), SETTINGS);
	assert.equal(d.state.phase, "ready");
	assert.equal(d.action.type, "none");
	d = evaluate(ready, boundary({ P: 0.8, isApplyPoint: true, applySafe: true, prechecksPassed: true, proposalNonce: "n2" }), SETTINGS);
	assert.equal(d.state.phase, "proposed");
	assert.equal(d.action.type, "propose");
});

test("A2 rework R4: served event — ready→idle+gap; other phases unchanged (table-driven)", () => {
	const mk = (phase: ControllerPhase) => ({ ...initialState(), phase });
	for (const phase of ["idle", "computing", "proposed"] as ControllerPhase[]) {
		const d = evaluate(mk(phase), { type: "served" }, SETTINGS);
		assert.equal(d.state.phase, phase);
		assert.equal(d.action.type, "none");
	}
	const ready = mk("ready");
	let d = evaluate(ready, { type: "served" }, SETTINGS);
	assert.equal(d.state.phase, "idle");
	assert.equal(d.state.lastOutcome?.outcome, "served");
	assert.equal(d.state.precomputeGapTurns, SETTINGS.minPrecomputeGapTurns);
	d = evaluate(d.state, boundary({ P: 0.61 }), SETTINGS);
	assert.equal(d.action.type, "none");
	d = evaluate({ ...d.state, precomputeGapTurns: 0 }, boundary({ P: 0.61 }), SETTINGS);
	assert.equal(d.action.type, "start-computing");
});
