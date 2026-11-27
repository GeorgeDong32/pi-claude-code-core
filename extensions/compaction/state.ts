
import type {
	CompactionSeamInfo,
} from "../../lib/compaction-seam.ts";
import type { ReconcileResult } from "./apply.ts";
import { evaluate, initialState, type PolicyEvent, type PolicySettings } from "./policy.ts";
import type { CompactionSettings } from "./settings.ts";
import type { ControllerState, CycleOutcome, DiscardReason, PrecomputedSnapshot } from "./types.ts";

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
	emitTelemetry: (data: CompactionTelemetryData) => void;
	notifyBefore: (info: CompactionSeamInfo) => void;
	notifyAfter: (info: CompactionSeamInfo) => void;
}

export interface LedgerMeta {
	tierADegraded: number;
	directivesCollapsed: number;
	directivesPointerOnly: number;
	openOverflow: number;
	ledgerChars: number;
}


export const OVERRIDE_DEGRADE_AFTER = 2;

export class SessionRuntime {
	state: ControllerState = initialState();
	snapshot: PrecomputedSnapshot | null = null;
	computeMs: number | undefined;
	summaryModelFallback = false;
	conflictEditTotal = 0;
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

	onBoundary(event: Extract<PolicyEvent, { type: "boundary" }>) {
		const decision = evaluate(this.state, event, this.policySettings());
		this.state = decision.state;
		return decision;
	}

	onPropose(event: Extract<PolicyEvent, { type: "propose" }>) {
		const decision = evaluate(this.state, event, this.policySettings());
		this.state = decision.state;
		return decision;
	}

	onComputeSucceeded(snapshot: PrecomputedSnapshot, meta: { computeMs?: number; summaryModelFallback?: boolean } = {}) {
		if (snapshot.generation !== this.state.generation) return;
		const decision = evaluate(this.state, { type: "compute-ok" }, this.policySettings());
		this.state = decision.state;
		if (this.state.phase === "ready") {
			this.snapshot = snapshot;
			this.computeMs = meta.computeMs;
			this.summaryModelFallback = meta.summaryModelFallback ?? false;
		}
	}

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

	onDiscarded(reason: DiscardReason, meta: Partial<CompactionTelemetryData> = {}) {
		const decision = evaluate(this.state, { type: "discard", reason }, this.policySettings());
		this.state = decision.state;
		this.snapshot = null;
		this.emit({ outcome: "discarded", reason, origin: "precompute", validated: true, ...meta });
	}

	onProposed(info: { midRun: boolean; summaryChars: number; tokensBefore?: number }) {
		this.deps.notifyBefore({
			origin: "boundary-draft",
			midRun: info.midRun,
			summaryChars: info.summaryChars,
			tokensBefore: info.tokensBefore,
		});
	}

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

	noteConflictEdits(count: number): void {
		this.conflictEditTotal += count;
		this.state = { ...this.state, conflictEdits: this.conflictEditTotal };
		if (this.conflictEditTotal >= this.deps.settings.conflictEditDegradeAfter) this.degrade();
	}

	degrade(): void {
		this.state = { ...this.state, degraded: true };
	}

	get degraded(): boolean {
		return this.state.degraded;
	}

	onSessionReset(): void {
		const decision = evaluate(this.state, { type: "session-reset" }, this.policySettings());
		this.state = decision.state;
		this.snapshot = null;
		this.computeMs = undefined;
		this.summaryModelFallback = false;
		this.conflictEditTotal = 0;
		this.overrideTotal = 0;
	}

	onServed(): void {
		this.state = evaluate(this.state, { type: "served" }, this.policySettings()).state;
		this.snapshot = null;
		this.emit({ outcome: "served", origin: "native-backfill", validated: true });
	}

	onInfeasible(neededTn?: number): void {
		this.emit({ outcome: "infeasible", reason: neededTn !== undefined ? `pol-09:needTn=${Math.round(neededTn)}` : "pol-09", origin: "precompute", validated: false });
	}

	onApplyError(): void {
		this.emit({ outcome: "discarded", reason: "apply-error", origin: "precompute", validated: true });
	}

	onFellthrough(why: string): void {
		this.emit({ outcome: "fellthrough", reason: why, origin: "precompute", validated: true });
	}

	onOverridden(info: { summaryChars: number; estPostTokens?: number }): void {
		if (this.state.phase !== "proposed") return;
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
		}
	}
}
