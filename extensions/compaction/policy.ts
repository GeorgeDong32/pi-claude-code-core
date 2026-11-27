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


// T_n must come from the EFFECTIVE compaction settings (modelOverrides resolved by the caller via pi's SettingsManager).
export function effectiveThreshold(
	contextWindow: number | null | undefined,
	reserveTokens: number | null | undefined,
): number | null {
	if (typeof contextWindow !== "number" || !Number.isFinite(contextWindow)) return null;
	if (typeof reserveTokens !== "number" || !Number.isFinite(reserveTokens)) return null;
	const tn = contextWindow - reserveTokens;
	return tn > 0 ? tn : null;
}

// pi host: getContextUsage().tokens is null after a compaction until the next assistant response — null pressure must never start compute or propose.
export function pressure(tokens: number | null, tn: number | null): number | null {
	if (tokens === null || tn === null || tn <= 0) return null;
	return tokens / tn;
}


export interface ModeResolution {
	mode: ControllerMode;
	reason?: string;
}

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


export function applyPointSafe(input: ApplyPointSafety): boolean {
	if (input.nativeRecoveryPending) return false;
	if (input.stopReason !== "stop" && input.stopReason !== "toolUse") return false;
	return true;
}

// pi host: `event.entries` is the host's draft-accumulator (runner.js emitBoundary), never session messages — stopReason must be scanned from session entries.
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


export interface FeasibilityInput {
	tn: number;
	keepRecentTokens: number;
	summaryTokenEstimate: number;
	lastSummaryTokens?: number;
	precomputeRatio: number;
	applyRatio: number;
	targetPostRatio: number;
}

export interface Feasibility {
	feasible: boolean;
	effectiveSummaryTokens: number;
	expectedGrowth: number;
	tailMax: number;
	neededTn: number;
}

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


export interface EstimatePostInput {
	summary: string;
	keptMessages: AgentMessage[];
	currentProjectionMessages: AgentMessage[];
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

export function estimateMessages(messages: AgentMessage[]): number {
	let sum = 0;
	for (const message of messages) sum += estimateTokens(message as never);
	return sum;
}

export function estimatePost(input: EstimatePostInput): PostEstimate {
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


export type PolicyEvent =
	| {
			type: "boundary";
			P: number | null;
			applySafe: boolean;
			isApplyPoint: boolean;
			prechecksPassed: boolean;
			feasibility: Feasibility | null;
			proposalNonce?: string;
			mayCompute: boolean;
	  }
	| { type: "compute-ok" }
	| { type: "propose"; P: number | null; applySafe: boolean; prechecksPassed: boolean; proposalNonce?: string }
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

export interface PolicySettings {
	precomputeRatio: number;
	applyRatio: number;
	refusedCooldownTurns: number;
	degradeAfterRefusals: number;
	minPrecomputeGapTurns: number;
}

function propose(state: ControllerState, event: Extract<PolicyEvent, { type: "propose" }> | Extract<PolicyEvent, { type: "boundary" }>, settings: PolicySettings): PolicyDecision {
	if (state.phase !== "ready" || !event.applySafe || event.P === null || !(event.P >= settings.applyRatio)) {
		return { state, action: { type: "none" } };
	}
	if (!event.prechecksPassed) {
		return {
			state: {
				...state, phase: "idle", precomputeGapTurns: settings.minPrecomputeGapTurns,
				lastOutcome: { outcome: "discarded", reason: "v-gate", atTurn: state.turns },
			},
			action: { type: "none" },
		};
	}
	const proposalId = event.proposalNonce ?? `prop-${state.generation}-${state.turns}`;
	return { state: { ...state, phase: "proposed", proposalId }, action: { type: "propose", proposalId } };
}

export function evaluate(
	state: ControllerState,
	event: PolicyEvent,
	settings: PolicySettings,
): PolicyDecision {
	switch (event.type) {
		case "propose":
			return propose(state, event, settings);
		case "session-reset":
			return { state: initialState(state.generation + 1), action: { type: "reset" } };

		case "served": {
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
			if (state.phase === "proposed" || state.phase === "computing") {
				return { state: next, action: { type: "none" } };
			}
			if (state.phase === "infeasible-window") {
				if (!event.feasibility?.feasible) return { state: next, action: { type: "none" } };
				next.phase = "idle";
			}
			if (state.phase === "ready") {
				return event.isApplyPoint ? propose(next, event, settings) : { state: next, action: { type: "none" } };
			}
			if (next.refusedCooldownTurns > 0 || next.precomputeGapTurns > 0) {
				return { state: next, action: { type: "none" } };
			}
			if (event.P === null) return { state: next, action: { type: "none" } };
			if (!event.mayCompute) return { state: next, action: { type: "none" } };
			if (event.P >= settings.precomputeRatio) {
				if (event.feasibility === null) return { state: next, action: { type: "none" } };
				if (!event.feasibility.feasible) {
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
				action: { type: "none" },
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
