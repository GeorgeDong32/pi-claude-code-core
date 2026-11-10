/*
 * Smart Compaction — session runtime + telemetry (SPEC SC §5.2/§5.10 ST-01,
 * task W3).
 *
 * SessionRuntime composes the pure policy (policy.ts evaluate) with the
 * effectful edges: snapshot custody (INV-5 — consumed exactly once, only on
 * committed/lost), the seam notifications (APP-05: before = intent,
 * after = confirmed commit only), the ST-01 telemetry entry, and the ST-05
 * degrade counters (refusals, conflict-edits). The event wiring itself
 * (which pi event maps to which runtime call) is index.ts (W4) — this class
 * never touches pi objects, so every edge is unit-testable.
 *
 * ST-01 entry shape is FROZEN (SC-ENT-01): display-only, never enters the
 * LLM context, carries sizes/ids/reason codes only (INV-7: no summary or
 * ledger text in telemetry).
 */

import type {
	CompactionSeamInfo,
} from "../../lib/compaction-seam.ts";
import type { ReconcileResult } from "./apply.ts";
import { evaluate, initialState, type PolicyEvent, type PolicySettings } from "./policy.ts";
import type { CompactionSettings } from "./settings.ts";
import type { ControllerState, CycleOutcome, DiscardReason, PrecomputedSnapshot } from "./types.ts";

/** ST-01 data — field set frozen; optional keys may be absent, never renamed. */
export interface CompactionTelemetryData {
	v: 1;
	outcome: CycleOutcome;
	reason?: string;
	origin: "precompute" | "native-backfill" | "native";
	cutClass?: string;
	summaryChars?: number;
	tokensBefore?: number;
	tokensAfter?: number;
	estPostTokens?: number;
	computeMs?: number;
	applyMs?: number;
	waitedMs?: number;
	validated: boolean;
	summaryModelFallback?: boolean;
	ledger?: { tierADegraded: number; directivesCollapsed: number; directivesPointerOnly: number; openOverflow: number };
	conflictEdit?: number;
}

export const TELEMETRY_ENTRY_TYPE = "cc-core-compaction";

export function buildTelemetryEntry(data: CompactionTelemetryData): { type: string; data: CompactionTelemetryData } {
	return { type: TELEMETRY_ENTRY_TYPE, data };
}

export interface SessionRuntimeDeps {
	settings: CompactionSettings;
	/** Fail-open telemetry writer (index.ts wraps appendEntry). */
	emitTelemetry: (data: CompactionTelemetryData) => void;
	notifyBefore: (info: CompactionSeamInfo) => void;
	notifyAfter: (info: CompactionSeamInfo) => void;
}

/** Ledger degradation counters surfaced through telemetry (LED-01). */
export interface LedgerMeta {
	tierADegraded: number;
	directivesCollapsed: number;
	directivesPointerOnly: number;
	openOverflow: number;
	ledgerChars: number;
}


/** A3 (2026-11-10 rework R3): CUMULATIVE (per-session) lost(overridden)
 * count that degrades the controller to shadow — same family as
 * conflictEditDegradeAfter (2). Cleared on reset. */
export const OVERRIDE_DEGRADE_AFTER = 2;

export class SessionRuntime {
	state: ControllerState = initialState();
	snapshot: PrecomputedSnapshot | null = null;
	computeMs: number | undefined;
	summaryModelFallback = false;
	conflictEditTotal = 0;
	// A3 (2026-11-10): lost(overridden) occurrences this session.
	overrideTotal = 0;

	private readonly deps: SessionRuntimeDeps;

	constructor(deps: SessionRuntimeDeps) {
		this.deps = deps;
	}

	private policySettings(): PolicySettings {
		const s = this.deps.settings;
		return {
			precomputeRatio: s.precomputeRatio,
			applyRatio: s.applyRatio,
			refusedCooldownTurns: s.refusedCooldownTurns,
			degradeAfterRefusals: s.degradeAfterRefusals,
			minPrecomputeGapTurns: s.minPrecomputeGapTurns,
		};
	}

	/** Wrap evaluate() so callers get the live state back automatically. */
	onBoundary(event: Extract<PolicyEvent, { type: "boundary" }>) {
		const decision = evaluate(this.state, event, this.policySettings());
		this.state = decision.state;
		return decision;
	}

	/** Compute finished and validated — hold the snapshot, stay "ready". */
	onComputeSucceeded(snapshot: PrecomputedSnapshot, meta: { computeMs?: number; summaryModelFallback?: boolean } = {}) {
		if (snapshot.generation !== this.state.generation) return; // SUM-07: stale generation dropped
		const decision = evaluate(this.state, { type: "compute-ok" }, this.policySettings());
		this.state = decision.state;
		if (this.state.phase === "ready") {
			this.snapshot = snapshot;
			this.computeMs = meta.computeMs;
			this.summaryModelFallback = meta.summaryModelFallback ?? false;
		}
	}

	/** Compute failed after retries — refused cooldown, maybe degrade (SUM-05). */
	onComputeFailed(reason: string) {
		const decision = evaluate(this.state, { type: "compute-failed", retryExhausted: true }, this.policySettings());
		this.state = decision.state;
		this.emit({
			outcome: "refused",
			reason,
			origin: "precompute",
			validated: false,
		});
	}

	/** V-gate discard outside the policy boundary path (apply-time failures). */
	onDiscarded(reason: DiscardReason, meta: Partial<CompactionTelemetryData> = {}) {
		const decision = evaluate(this.state, { type: "discard", reason }, this.policySettings());
		this.state = decision.state;
		this.snapshot = null;
		this.emit({ outcome: "discarded", reason, origin: "precompute", validated: true, ...meta });
	}

	/**
	 * A draft was returned: phase → proposed and the BEFORE notification
	 * fires synchronously (APP-05 — intent first, no entryId yet).
	 */
	onProposed(info: { midRun: boolean; summaryChars: number; tokensBefore?: number }) {
		this.deps.notifyBefore({
			origin: "boundary-draft",
			midRun: info.midRun,
			summaryChars: info.summaryChars,
			tokensBefore: info.tokensBefore,
		});
	}

	/**
	 * Reconciliation outcome (APP-08). committed → seam after exactly once
	 * (deduped upstream by entryId) + telemetry applied + snapshot consumed;
	 * lost → telemetry discarded, NO after, snapshot voided (INV-5).
	 */
	onReconciled(
		result: ReconcileResult,
		info: { midRun: boolean; summaryChars: number; tokensBefore?: number; estPostTokens?: number; applyMs?: number; waitedMs?: number; tokensAfter?: number; cutClass?: string },
	) {
		if (this.state.phase !== "proposed") return;
		if (result.status === "committed") {
			const decision = evaluate(this.state, { type: "reconcile-committed" }, this.policySettings());
			this.state = decision.state;
			this.snapshot = null;
			this.deps.notifyAfter({
				origin: "boundary-draft",
				entryId: result.entryId,
				midRun: info.midRun,
				summaryChars: info.summaryChars,
				tokensBefore: info.tokensBefore,
			});
			if ((result.conflictEdits ?? 0) > 0) this.noteConflictEdits(result.conflictEdits!);
			this.emit({
				outcome: "applied",
				origin: "precompute",
				validated: true,
				summaryChars: info.summaryChars,
				tokensBefore: info.tokensBefore,
				tokensAfter: info.tokensAfter,
				estPostTokens: info.estPostTokens,
				applyMs: info.applyMs,
				waitedMs: info.waitedMs,
				cutClass: info.cutClass,
				computeMs: this.computeMs,
				summaryModelFallback: this.summaryModelFallback || undefined,
				conflictEdit: result.conflictEdits,
			});
			this.computeMs = undefined;
			this.summaryModelFallback = false;
			return;
		}
		const decision = evaluate(this.state, { type: "reconcile-lost", reason: result.lostReason ?? "dropped" }, this.policySettings());
		this.state = decision.state;
		this.snapshot = null;
		this.emit({
			outcome: "discarded",
			reason: result.lostReason ?? "dropped",
			origin: "precompute",
			validated: true,
			summaryChars: info.summaryChars,
			computeMs: this.computeMs,
			waitedMs: info.waitedMs,
		});
		this.computeMs = undefined;
		this.summaryModelFallback = false;
	}

	/** APP-08 degrade: conflict-edit audits accumulate → shadow (ST-05). */
	noteConflictEdits(count: number): void {
		this.conflictEditTotal += count;
		this.state = { ...this.state, conflictEdits: this.conflictEditTotal };
		if (this.conflictEditTotal >= this.deps.settings.conflictEditDegradeAfter) this.degrade();
	}

	/** ST-05 session degrade (sticky until reset). */
	degrade(): void {
		this.state = { ...this.state, degraded: true };
	}

	get degraded(): boolean {
		return this.state.degraded;
	}

	/** session_start / session_shutdown — abort in-flight, bump generation. */
	onSessionReset(): void {
		const decision = evaluate(this.state, { type: "session-reset" }, this.policySettings());
		this.state = decision.state;
		this.snapshot = null;
		this.computeMs = undefined;
		this.summaryModelFallback = false;
		// A3 (2026-11-10): degrade counters are session-scoped — a reset must
		// not carry them across sessions (previously conflictEditTotal leaked).
		this.conflictEditTotal = 0;
		this.overrideTotal = 0;
	}

	/**
	 * A2 (2026-11-10, rework R4): the fallback leg supplied the snapshot to
	 * native — the policy's `served` event moves a READY phase to idle (+min
	 * gap) so the next boundary can precompute again; other phases are a
	 * no-op. The snapshot is gone either way (consumed by the supply).
	 */
	onServed(): void {
		this.state = evaluate(this.state, { type: "served" }, this.policySettings()).state;
		this.snapshot = null;
		this.emit({ outcome: "served", origin: "native-backfill", validated: true });
	}

	/**
	 * B5 (2026-11-10 review): POL-09 infeasibility telemetry — emitted once
	 * per infeasible-window entry (infeasibleReported dedup upstream);
	 * neededTn rides inside the reason string (ST-01 field set is frozen).
	 */
	onInfeasible(neededTn?: number): void {
		this.emit({ outcome: "infeasible", reason: neededTn !== undefined ? `pol-09:needTn=${Math.round(neededTn)}` : "pol-09", origin: "precompute", validated: false });
	}

	/** B5 (2026-11-10 review): APP-06 — an apply-path handler error writes telemetry, never throws. */
	onApplyError(): void {
		this.emit({ outcome: "discarded", reason: "apply-error", origin: "precompute", validated: true });
	}

	/** B5 (2026-11-10 review): FB-07 — the fallback leg missed its deadline or was aborted. */
	onFellthrough(why: "deadline" | "aborted"): void {
		this.emit({ outcome: "fellthrough", reason: why, origin: "precompute", validated: true });
	}

	/**
	 * A3 (2026-11-10, rework R3): lost(overridden) — every occurrence writes
	 * the APP-08 discarded telemetry, then the BLK-2(a) semantics run: phase
	 * back to ready with a fresh nonce slot. Once the CUMULATIVE per-session
	 * count reaches OVERRIDE_DEGRADE_AFTER the controller degrades to shadow
	 * (the counter is NOT reset by commits — only by session reset).
	 */
	onOverridden(info: { summaryChars: number; estPostTokens?: number }): void {
		this.emit({
			outcome: "discarded",
			reason: "overridden",
			origin: "precompute",
			validated: true,
			summaryChars: info.summaryChars,
			...(info.estPostTokens !== undefined ? { estPostTokens: info.estPostTokens } : {}),
		});
		this.overrideTotal += 1;
		if (this.overrideTotal >= OVERRIDE_DEGRADE_AFTER) this.degrade();
		this.state = { ...this.state, phase: "ready", proposalId: undefined };
	}

	private emit(data: Omit<CompactionTelemetryData, "v">): void {
		try {
			this.deps.emitTelemetry({ v: 1, ...data });
		} catch {
			// Telemetry is fail-open (INV-1): never break a boundary for it.
		}
	}
}
