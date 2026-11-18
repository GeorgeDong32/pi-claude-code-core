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

export type ControllerMode = "off" | "shadow" | "on";

export interface ProjectedEntry {
	sourceEntry: SessionEntry;
	messages: AgentMessage[];
}

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

export interface CutSelection {
	firstKeptEntryId: string;
	firstKeptEntryIndex: number;
	isSplitTurn: boolean;
	turnStartIndex: number;
	tailTokens: number;
	boundaryClass: BoundaryClass;
	score: number;
}

export type CutpointResult =
	| { status: "ok"; cut: CutSelection }
	| { status: "native-equivalent"; cut: CutSelection }
	| { status: "infeasible"; reason: string; neededTn?: number };


export type ControllerPhase =
	| "idle"
	| "computing"
	| "ready"
	| "proposed"
	| "refused"
	| "infeasible-window";

export type DiscardReason =
	| "overridden"
	| "dropped"
	| "branch-changed"
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

export type CycleOutcome =
	| "applied"
	| "served"
	| "discarded"
	| "refused"
	| "fellthrough"
	| "infeasible";

export interface ControllerState {
	phase: ControllerPhase;
	generation: number;
	proposalId?: string;
	refusedCooldownTurns: number;
	precomputeGapTurns: number;
	refusals: number;
	conflictEdits: number;
	degraded: boolean;
	infeasibleReported: boolean;
	lastOutcome?: { outcome: CycleOutcome; reason?: DiscardReason | string; atTurn?: number };
	turns: number;
}

export interface PressureSample {
	tokens: number | null;
	tn: number;
}

export type PolicyAction =
	| { type: "none" }
	| { type: "start-computing" }
	| { type: "propose"; proposalId: string }
	| { type: "refuse"; cooldownTurns: number }
	| { type: "discard"; reason: DiscardReason }
	| { type: "mark-infeasible"; neededTn?: number }
	| { type: "reset" };

export interface ApplyPointSafety {
	stopReason?: string;
	outcome?: string;
	nativeRecoveryPending: boolean;
}


export type SubCallKind = "history" | "turn-prefix" | "unknown";

export interface SubCallRecord {
	kind: SubCallKind;
	stopReason: string;
	narrativeText: string;
	hasToolCall: boolean;
	usage?: { input?: number; output?: number; reasoning?: number };
}

export interface ValidationVerdict {
	ok: boolean;
	failures: string[];
}


export interface PrecomputedSnapshot {
	generation: number;
	cut: CutSelection;
	branchPathIds: string[];
	summary: string;
	summaryTokens: number;
	tnAtSnapshot: number;
	validated: boolean;
}
