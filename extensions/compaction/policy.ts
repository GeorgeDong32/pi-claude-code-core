/*
 * Smart Compaction — pressure policy (SPEC SC §5.3, task W1).
 *
 * Pure functions only (POL-03): no timers, no I/O, no pi context objects —
 * every input is injected data, every output is a decision the caller applies.
 * The state machine (§5.2) is a total function over (state, event) so tests
 * can enumerate every edge, including cooldowns, single-flight and the
 * "no re-propose while proposed" invariant (INV-5).
 *
 * Key host facts baked in:
 *   - H7: getContextUsage().tokens is null after a compaction until the next
 *     assistant response — null pressure never advances state (POL-04).
 *   - H8: T_n must come from the EFFECTIVE compaction settings (modelOverrides
 *     resolved by the caller via SettingsManager); POL-01 refuses to guess.
 *   - H12: outcome==="completed" is NOT sufficient safety; POL-07 checks the
 *     raw stopReason and the session's pending-native-recovery flag.
 */

import { estimateTokens } from "@earendil-works/pi-coding-agent";
import type {
	AgentMessage,
} from "@earendil-works/pi-agent-core";
import type {
	ApplyPointSafety,
	ControllerMode,
	ControllerState,
	DiscardReason,
	PolicyAction,
} from "./types.ts";

// ─── POL-01: effective threshold ────────────────────────────────────────────

/**
 * T_n = contextWindow − effectiveReserveTokens (H8). Any missing input or a
 * non-positive result → null: the controller stays idle and never throws.
 */
export function effectiveThreshold(
	contextWindow: number | null | undefined,
	reserveTokens: number | null | undefined,
): number | null {
	if (typeof contextWindow !== "number" || !Number.isFinite(contextWindow)) return null;
	if (typeof reserveTokens !== "number" || !Number.isFinite(reserveTokens)) return null;
	const tn = contextWindow - reserveTokens;
	return tn > 0 ? tn : null;
}

/** P = tokens / T_n; null tokens (H7) → null (POL-04: no state advance). */
export function pressure(tokens: number | null, tn: number | null): number | null {
	if (tokens === null || tn === null || tn <= 0) return null;
	return tokens / tn;
}

// ─── POL-06/POL-08: mode resolution ─────────────────────────────────────────

export interface ModeResolution {
	mode: ControllerMode;
	/** Present whenever the effective mode differs from the configured one. */
	reason?: string;
}

/**
 * Version gate (POL-08) wins outright; native `compaction.enabled=false`
 * forces shadow (POL-06 — the controller must not auto-compact, but keeps
 * observing); a configured "off" is always respected.
 */
export function resolveMode(
	configured: ControllerMode,
	nativeCompactionEnabled: boolean,
	versionOk: boolean,
): ModeResolution {
	if (!versionOk) return { mode: "off", reason: "pi < 1.5.0 or compat probe failed; forced off" };
	if (configured === "off") return { mode: "off" };
	if (!nativeCompactionEnabled) {
		return { mode: "shadow", reason: "compaction.enabled=false; forced shadow" };
	}
	return { mode: configured };
}

// ─── POL-07: apply-point safety (INV-11, BLK-1) ─────────────────────────────

/**
 * Safe to propose at this boundary only when the last assistant response
 * settled cleanly AND no native recovery is pending. `"completed"` alone is
 * NOT sufficient (H12: stopReason "length" maps to outcome "completed").
 */
export function applyPointSafe(input: ApplyPointSafety): boolean {
	if (input.nativeRecoveryPending) return false;
	// Undefined stopReason = no assistant to evaluate — cannot verify safety.
	if (input.stopReason !== "stop" && input.stopReason !== "toolUse") return false;
	return true;
}

/**
 * A1 (2026-11-10 review P0, rework R1): stopReason of the last assistant
 * message on the SESSION BRANCH (backward scan). The authority for POL-07 —
 * `event.entries` is the host's draft-accumulator (runner.js emitBoundary),
 * never session messages, so it must not be read for stopReasons.
 */
export function lastAssistantStopReason(entries: ReadonlyArray<unknown>): string | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i] as { type?: string; message?: { role?: string; stopReason?: unknown } } | undefined;
		if (entry?.type === "message" && entry.message?.role === "assistant") {
			const stop = entry.message.stopReason;
			return typeof stop === "string" ? stop : undefined;
		}
	}
	return undefined;
}

// ─── POL-09: joint feasibility ──────────────────────────────────────────────

export interface FeasibilityInput {
	tn: number;
	keepRecentTokens: number;
	summaryTokenEstimate: number;
	/** Token size of the previous compaction's summary, when one exists. */
	lastSummaryTokens?: number;
	precomputeRatio: number;
	applyRatio: number;
	targetPostRatio: number;
}

export interface Feasibility {
	feasible: boolean;
	/** Adaptive summary budget S = max(default, 1.2 × last summary). */
	effectiveSummaryTokens: number;
	/** Expected growth between snapshot and apply, in tokens. */
	expectedGrowth: number;
	/** Capacity upper bound for the kept tail (§5.4 tailMax). */
	tailMax: number;
	/** T_n the current configuration would need (for /compaction status). */
	neededTn: number;
}

/**
 * Joint feasibility over threshold, tail budget and the hard-fit gate:
 * `keep + S + G ≤ q·T` with `G = max(0, a − p)·T` (growth expected between a
 * snapshot at preRatio and the apply threshold — worst case, since a snapshot
 * may fire exactly at p). `S` adapts to the previous summary so a chatty
 * summarizer cannot silently eat the tail budget.
 */
export function jointFeasibility(input: FeasibilityInput): Feasibility {
	const { tn, keepRecentTokens, precomputeRatio, applyRatio, targetPostRatio } = input;
	const s = Math.max(
		input.summaryTokenEstimate,
		input.lastSummaryTokens !== undefined ? Math.ceil(1.2 * input.lastSummaryTokens) : 0,
	);
	const growth = Math.max(0, applyRatio - precomputeRatio) * tn;
	const tailMax = targetPostRatio * tn - s - growth;
	const denominator = targetPostRatio + precomputeRatio - applyRatio;
	const neededTn = denominator > 0 ? (keepRecentTokens + s) / denominator : Number.POSITIVE_INFINITY;
	return {
		feasible: keepRecentTokens + s + growth <= targetPostRatio * tn,
		effectiveSummaryTokens: s,
		expectedGrowth: growth,
		tailMax,
		neededTn,
	};
}

// ─── POL-10: post-compaction estimate ───────────────────────────────────────

export interface EstimatePostInput {
	/** Candidate summary text (ledger block included). */
	summary: string;
	/** Kept-tail messages under the CURRENT projection (context edits applied). */
	keptMessages: AgentMessage[];
	/** Full current projection messages, for overhead calibration. */
	currentProjectionMessages: AgentMessage[];
	/** ctx.getContextUsage().tokens when available, else null (H7 windows). */
	ctxTokensUsage: number | null;
	contextWindow: number;
	unknownOverheadTokens: number;
}

export interface PostEstimate {
	summaryTokens: number;
	tailTokens: number;
	overhead: number;
	total: number;
}

/** Sum of estimateTokens over messages (chars/4 heuristic, same as host). */
export function estimateMessages(messages: AgentMessage[]): number {
	let sum = 0;
	for (const message of messages) sum += estimateTokens(message as never);
	return sum;
}

/**
 * estimatePost = summary tokens + kept-tail tokens + overhead. Overhead is
 * calibrated from real usage when available: clamp(usage − estimate(projection),
 * 0, 0.3·window); otherwise the conservative unknownOverheadTokens default.
 * Estimation drift is absorbed by hardFitRatio's margin (R13), and telemetry
 * records estimate-vs-next-real-usage for W2 calibration (M8).
 */
export function estimatePost(input: EstimatePostInput): PostEstimate {
	// Synthetic compactionSummary message — same shape the host projects for a
	// compaction entry (session-manager.js createCompactionSummaryMessage), so
	// the estimator sees what the next request would actually contain.
	const summaryMessage = {
		role: "compactionSummary",
		summary: input.summary,
		tokensBefore: 0,
		timestamp: Date.now(),
	} as unknown as AgentMessage;
	const summaryTokens = estimateTokens(summaryMessage as never);
	const tailTokens = estimateMessages(input.keptMessages);
	let overhead: number;
	if (input.ctxTokensUsage !== null && Number.isFinite(input.ctxTokensUsage)) {
		const projected = estimateMessages(input.currentProjectionMessages);
		overhead = input.ctxTokensUsage - projected;
		if (overhead < 0) overhead = 0;
		const cap = 0.3 * input.contextWindow;
		if (overhead > cap) overhead = cap;
	} else {
		overhead = input.unknownOverheadTokens;
	}
	return { summaryTokens, tailTokens, overhead, total: summaryTokens + tailTokens + overhead };
}

// ─── POL-03: the state machine ──────────────────────────────────────────────

export type PolicyEvent =
	| {
			type: "boundary";
			/** Pressure P at this boundary; null ⇒ no evaluation (POL-04). */
			P: number | null;
			/** POL-07 predicate already evaluated by the caller. */
			applySafe: boolean;
			/** True only on turn_end / agent_before_settle (apply points). */
			isApplyPoint: boolean;
			/** V1–V10 outcome, supplied by apply.ts at apply points (W3). */
			prechecksPassed: boolean;
			/** Joint feasibility under the CURRENT window/settings. */
			feasibility: Feasibility | null;
			/** Fresh nonce minted by the caller for a new proposal. */
			proposalNonce?: string;
			/** Controller may compute (mode on/shadow, not degraded-out). */
			mayCompute: boolean;
	  }
	| { type: "compute-ok" }
	| { type: "compute-failed"; retryExhausted: boolean }
	| { type: "discard"; reason: DiscardReason }
	| { type: "reconcile-committed" }
	| { type: "reconcile-lost"; reason: DiscardReason }
	| { type: "served" }
	| { type: "session-reset" };

export function initialState(generation = 0): ControllerState {
	return {
		phase: "idle",
		generation,
		refusedCooldownTurns: 0,
		precomputeGapTurns: 0,
		refusals: 0,
		conflictEdits: 0,
		degraded: false,
		infeasibleReported: false,
		turns: 0,
	};
}

export interface PolicyDecision {
	state: ControllerState;
	action: PolicyAction;
}

/** Everything `evaluate` needs from settings (POL-02-validated values). */
export interface PolicySettings {
	precomputeRatio: number;
	applyRatio: number;
	refusedCooldownTurns: number;
	degradeAfterRefusals: number;
	minPrecomputeGapTurns: number;
}

/**
 * Total transition function (§5.2). Every edge is a table row in the tests;
 * unknown combinations fall through to "none" rather than throwing (INV-1's
 * pure-function form: a policy bug must never break a turn).
 */
export function evaluate(
	state: ControllerState,
	event: PolicyEvent,
	settings: PolicySettings,
): PolicyDecision {
	switch (event.type) {
		case "session-reset":
			return { state: initialState(state.generation + 1), action: { type: "reset" } };

		case "served": {
			// A2 (2026-11-10 rework R4): the fallback leg supplied the snapshot
			// to native. Only a READY phase transitions (idle + min gap) —
			// every other phase is a no-op.
			if (state.phase === "ready") {
				return {
					state: { ...state, phase: "idle", precomputeGapTurns: settings.minPrecomputeGapTurns, lastOutcome: { outcome: "served", atTurn: state.turns } },
					action: { type: "none" },
				};
			}
			return { state, action: { type: "none" } };
		}

	case "boundary": {
			const next: ControllerState = {
				...state,
				turns: state.turns + 1,
				refusedCooldownTurns: Math.max(0, state.refusedCooldownTurns - 1),
				precomputeGapTurns: Math.max(0, state.precomputeGapTurns - 1),
			};
			// INV-5: while a proposal is outstanding or a compute is in flight,
			// boundaries never start new work (single-flight, no re-propose).
			if (state.phase === "proposed" || state.phase === "computing") {
				return { state: next, action: { type: "none" } };
			}
			if (state.phase === "infeasible-window") {
				// Still infeasible → stay; feasibility restored → drop to idle
				// semantics and evaluate this boundary like an idle one below.
				if (!event.feasibility?.feasible) return { state: next, action: { type: "none" } };
				next.phase = "idle";
			}
			if (state.phase === "ready") {
				// Apply-point gate: POL-07 safety + P ≥ applyRatio + V1–V10.
				if (
					event.isApplyPoint &&
					event.applySafe &&
					event.P !== null &&
					event.P >= settings.applyRatio
				) {
					if (!event.prechecksPassed) {
						// V-gate failed: snapshot discarded, ready for the next
						// boundary only after the min gap (§5.2 ready→discarded).
						return {
							state: {
								...next,
								phase: "idle",
								precomputeGapTurns: settings.minPrecomputeGapTurns,
								lastOutcome: { outcome: "discarded", reason: "v-gate", atTurn: next.turns },
							},
							action: { type: "none" },
						};
					}
					const proposalId = event.proposalNonce ?? `prop-${next.generation}-${next.turns}`;
					return {
						state: { ...next, phase: "proposed", proposalId },
						action: { type: "propose", proposalId },
					};
				}
				// Not proposing here: keep the snapshot ready (V10 semantics —
				// the SAME snapshot stays eligible at the next boundary).
				return { state: next, action: { type: "none" } };
			}
			// idle (possibly with cooldown / gap outstanding — decremented above).
			if (next.refusedCooldownTurns > 0 || next.precomputeGapTurns > 0) {
				return { state: next, action: { type: "none" } };
			}
			if (event.P === null) return { state: next, action: { type: "none" } }; // POL-04
			if (!event.mayCompute) return { state: next, action: { type: "none" } };
			if (event.P >= settings.precomputeRatio) {
				if (event.feasibility === null) return { state: next, action: { type: "none" } };
				if (!event.feasibility.feasible) {
					// POL-09: no precompute; the phase itself throttles the
					// telemetry (infeasibleReported marks it emitted).
					return {
						state: { ...next, phase: "infeasible-window", infeasibleReported: true },
						action: {
							type: "mark-infeasible",
							neededTn:
								event.feasibility.neededTn === Number.POSITIVE_INFINITY
									? undefined
									: Math.ceil(event.feasibility.neededTn),
						},
					};
				}
				return { state: { ...next, phase: "computing" }, action: { type: "start-computing" } };
			}
			return { state: next, action: { type: "none" } };
		}

		case "compute-ok":
			if (state.phase !== "computing") return { state, action: { type: "none" } };
			return { state: { ...state, phase: "ready" }, action: { type: "none" } };

		case "compute-failed": {
			if (state.phase !== "computing") return { state, action: { type: "none" } };
			if (!event.retryExhausted) return { state, action: { type: "none" } };
			const refusals = state.refusals + 1;
			return {
				state: {
					...state,
					phase: "refused",
					refusedCooldownTurns: settings.refusedCooldownTurns,
					refusals,
					degraded: state.degraded || refusals >= settings.degradeAfterRefusals,
					lastOutcome: { outcome: "refused", atTurn: state.turns },
				},
				action: { type: "refuse", cooldownTurns: settings.refusedCooldownTurns },
			};
		}

		case "discard":
			if (state.phase !== "ready" && state.phase !== "proposed") return { state, action: { type: "none" } };
			return {
				state: {
					...state,
					phase: "idle",
					precomputeGapTurns: settings.minPrecomputeGapTurns,
					lastOutcome: { outcome: "discarded", reason: event.reason, atTurn: state.turns },
				},
				action: { type: "discard", reason: event.reason },
			};

		case "reconcile-committed":
			if (state.phase !== "proposed") return { state, action: { type: "none" } };
			return {
				state: {
					...state,
					phase: "idle",
					proposalId: undefined,
					lastOutcome: { outcome: "applied", atTurn: state.turns },
				},
				action: { type: "none" }, // seam-after + telemetry are W3's effects
			};

		case "reconcile-lost":
			if (state.phase !== "proposed") return { state, action: { type: "none" } };
			return {
				state: {
					...state,
					phase: "idle",
					proposalId: undefined,
					lastOutcome: { outcome: "discarded", reason: event.reason, atTurn: state.turns },
				},
				action: { type: "none" },
			};
	}
}
