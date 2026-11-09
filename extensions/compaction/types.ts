/*
 * Smart Compaction — shared types (SPEC SC §5.1, task W1; first commit).
 *
 * Type-only foundation for the controller. Design decisions:
 *
 *   - Only CROSS-FILE shapes live here. Settings schema/defaults live in
 *     settings.ts (§5.10), ledger shapes in ledger/types.ts (W6) — this file
 *     must not grow module-local types.
 *   - No runtime imports except pure type re-exports; pi types are imported
 *     as `import type` only (erased at runtime, keeps the dependency light).
 *   - The state machine vocabulary (§5.2) is a closed string union: phases
 *     "computing"/"ready"/"proposed" carry payloads, terminal-per-cycle
 *     outcomes collapse back to "idle" with a last-outcome record.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

/** Controller mode (ST-02 `mode` / ST-03 env; POL-06/08 can force it down). */
export type ControllerMode = "off" | "shadow" | "on";

/** Projection entry view the cutpoint scorer consumes (§5.4 input). */
export interface ProjectedEntry {
	/** Raw append-only entry owning this projected contribution. */
	sourceEntry: SessionEntry;
	/** Model-visible messages after context edits (may be empty). */
	messages: AgentMessage[];
}

/**
 * Boundary classes (§5.4). Ordered by default weight; "native-equivalent"
 * marks the CUT-02 fallback (no semantic candidate inside the window).
 */
export type BoundaryClass =
	| "run-closed"
	| "goal-step"
	| "user"
	| "git-commit"
	| "verified"
	| "idle-gap"
	| "plain-turn"
	| "tool-turn"
	| "native-equivalent";

/**
 * A selected cut (§5.4 output). `firstKeptEntryId` refers to the raw session
 * entry id; `tailTokens` is the estimated token size of the kept tail under
 * the CURRENT projection (context edits applied, H15).
 */
export interface CutSelection {
	firstKeptEntryId: string;
	/** Branch index of the kept-tail head (into the entries the cutter saw). */
	firstKeptEntryIndex: number;
	isSplitTurn: boolean;
	/** -1 when not splitting (native findCutPoint semantics). */
	turnStartIndex: number;
	tailTokens: number;
	boundaryClass: BoundaryClass;
	score: number;
}

/** Capacity-first outcome: either a cut or the POL-09 infeasibility verdict. */
export type CutpointResult =
	| { status: "ok"; cut: CutSelection }
	| { status: "native-equivalent"; cut: CutSelection }
	| { status: "infeasible"; reason: string; neededTn?: number };

// ─── State machine (§5.2) ───────────────────────────────────────────────────

export type ControllerPhase =
	| "idle"
	| "computing"
	| "ready"
	| "proposed"
	| "infeasible-window";

/** Why a snapshot left "ready"/"proposed" without committing (§5.2 codes). */
export type DiscardReason =
	| "overridden" // same-boundary later handler replaced entries (BLK-2a)
	| "dropped" // reconcile window passed with no matching compaction
	| "branch-changed" // session_tree / fork / navigation between propose and reconcile
	| "v1-branch-prefix"
	| "v2-new-compaction"
	| "v3-cut-invalid"
	| "v4-conflict-edit"
	| "v5-window-shift"
	| "v6-summary-invalid"
	| "v7-unsafe-boundary"
	| "v8a-hard-fit"
	| "v8b-efficiency"
	| "v9-degraded"
	| "v10-same-boundary-conflict"
	| "snapshot-oversized"
	| "aborted";

/** Cycle outcomes recorded on the telemetry entry (ST-01 `outcome`). */
export type CycleOutcome =
	| "applied"
	| "served"
	| "discarded"
	| "refused"
	| "fellthrough"
	| "infeasible";

/** Immutable state record the pure policy operates on (POL-03). */
export interface ControllerState {
	phase: ControllerPhase;
	/** Monotonic per-session generation; late results from older gens drop. */
	generation: number;
	/** proposalId nonce of the in-flight proposal, when phase === "proposed". */
	proposalId?: string;
	/** Turns left in the refused cooldown (SUM-05), decremented per boundary. */
	refusedCooldownTurns: number;
	/** Boundaries left before computing may start again (INV-5 gap). */
	precomputeGapTurns: number;
	/** Accumulated refusals this session (SUM-05 degrade counter). */
	refusals: number;
	/** Accumulated conflict-edit audits (APP-08 degrade counter). */
	conflictEdits: number;
	/** Session-degraded to shadow (ST-05); sticky until session reset. */
	degraded: boolean;
	/** infeasible-window telemetry already emitted once this session (POL-09). */
	infeasibleReported: boolean;
	/** Last completed-cycle outcome, for /compaction status. */
	lastOutcome?: { outcome: CycleOutcome; reason?: DiscardReason | string; atTurn?: number };
	/** Turn counter (boundaries seen), drives cooldowns. */
	turns: number;
}

/** Pressure sample as the policy sees it at an event boundary (POL-01/04). */
export interface PressureSample {
	/** ctx.getContextUsage().tokens — null until the next assistant (H7). */
	tokens: number | null;
	/** Effective threshold T_n = contextWindow − effectiveReserveTokens. */
	tn: number;
}

/** What the policy decided (POL-03); effects are applied by the caller. */
export type PolicyAction =
	| { type: "none" }
	| { type: "start-computing" }
	| { type: "propose"; proposalId: string }
	| { type: "refuse"; cooldownTurns: number }
	| { type: "discard"; reason: DiscardReason }
	| { type: "mark-infeasible"; neededTn?: number }
	| { type: "reset" };

/** POL-07 apply-point safety inputs (INV-11; BLK-1). */
export interface ApplyPointSafety {
	/** stopReason of the last assistant message being evaluated. */
	stopReason?: string;
	/** turn_end outcome, when available. */
	outcome?: string;
	/** Session flag: an overflow recovery was just served and not settled. */
	nativeRecoveryPending: boolean;
}

// ─── Summary validation (§5.5 SUM-04/SUM-09) ────────────────────────────────

/** Logical sub-call classification by pi's internal prompt shapes (SUM-09). */
export type SubCallKind = "history" | "turn-prefix" | "unknown";

/** One logical summarization call observed through the streamFn wrapper. */
export interface SubCallRecord {
	kind: SubCallKind;
	stopReason: string;
	/** Narrative text content (excluding reasoning), possibly empty. */
	narrativeText: string;
	/** Whether the response carried any toolCall blocks. */
	hasToolCall: boolean;
	usage?: { input?: number; output?: number; reasoning?: number };
}

/** Verdict helpers keep reasons structured so tests can pin each gate. */
export interface ValidationVerdict {
	ok: boolean;
	/** Gate ids that failed, e.g. "sub:narrative", "assembled:headings". */
	failures: string[];
}

// ─── Snapshot (ready payload; §5.2 INV-5) ───────────────────────────────────

/**
 * The precomputed snapshot held while "ready". Consumed exactly once, only on
 * committed/lost reconciliation (INV-5). Filled by W3; the shape is frozen
 * here because policy/state/apply all reference it.
 */
export interface PrecomputedSnapshot {
	/** Generation that started the compute; mismatch ⇒ stale. */
	generation: number;
	cut: CutSelection;
	/** Branch entry-id path at snapshot time (V1 prefix check). */
	branchPathIds: string[];
	/** Summary text (ledger block assembled at apply time, not here). */
	summary: string;
	summaryTokens: number;
	/** tokens/usage captured for V5/V8 checks. */
	tnAtSnapshot: number;
	validated: boolean;
}
