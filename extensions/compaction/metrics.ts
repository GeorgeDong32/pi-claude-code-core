/*
 * SC-MET-01: opt-in-by-mode, content-free runtime measurements for M1 diagnosis.
 * This separate display-only entry leaves the frozen ST-01 schema untouched.
 * Only reconciled commits count as successes; live takeover is not the
 * counterfactual M1 produced by replay. No timers, network, or policy effects.
 */
import type { ControllerPhase } from "./types.ts";

export const COMPACTION_METRICS_ENTRY_TYPE = "cc-core-compaction-metrics";
const EVENTS = ["compute-start", "compute-ready", "proposal", "applied", "fallback-start", "fallback-end"] as const;
export interface CompactionMetric {
	v: 1;
	event: typeof EVENTS[number];
	at: number;
	tokens: number | null;
	tn: number | null;
	phase: ControllerPhase;
	degraded: boolean;
	precomputeRatio: number;
	applyRatio: number;
	cycleId?: string;
	proposalId?: string;
	attemptId?: string;
	reason?: "threshold" | "overflow" | "manual";
	elapsedMs?: number;
	estPostTokens?: number;
	fromExtension?: boolean;
	failed?: boolean;
}

/** A failed diagnostic write must never change the host's control flow. */
export function recordCompactionMetric(write: (data: CompactionMetric) => void, data: Omit<CompactionMetric, "v" | "at">): void {
	try {
		write({ ...data, v: 1, at: Date.now() });
	} catch {
		/* INV-1: diagnostics are best-effort. */
	}
}

/** Project only measurement rows; never retain message/summary bodies. */
export function metricFromEntry(entry: unknown): CompactionMetric | undefined {
	if (!entry || typeof entry !== "object") return undefined;
	const row = entry as { type?: string; customType?: string; data?: CompactionMetric };
	const data = row.data;
	if (row.type !== "custom" || row.customType !== COMPACTION_METRICS_ENTRY_TYPE || data?.v !== 1) return undefined;
	if (!EVENTS.includes(data.event) || !Number.isFinite(data.at)) return undefined;
	return data;
}

function sampleStats(values: number[]) {
	const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
	const percentile = (p: number) => sorted.length ? sorted[Math.ceil(sorted.length * p) - 1]! : null;
	return { samples: sorted.length, p50: percentile(0.5), p90: percentile(0.9) };
}

/** Each input is one session file, preventing cross-session id collisions. */
export function summarizeCompactionMetrics(sessions: ReadonlyArray<ReadonlyArray<CompactionMetric>>) {
	let sessionsWithMetrics = 0;
	let computeStarts = 0;
	let computeReady = 0;
	let proposals = 0;
	let earlyCommits = 0;
	let lateCommits = 0;
	let unknownPressureCommits = 0;
	let thresholdFallbacks = 0;
	let overflowRecoveries = 0;
	let manualCompactions = 0;
	let fallbackCompleted = 0;
	let fallbackFailed = 0;
	const computeDurations: number[] = [];
	const fallbackDurations: number[] = [];
	const computeLeadTokens: number[] = [];
	const thresholdFallbackPhases = { idle: 0, computing: 0, ready: 0, proposed: 0, refused: 0, "infeasible-window": 0 };
	for (const rows of sessions) {
		if (rows.length) sessionsWithMetrics += 1;
		const seen = new Set<string>();
		for (const row of rows) {
			const id = row.proposalId ?? row.attemptId ?? row.cycleId;
			if (!id) continue;
			const key = `${row.event}:${id}`;
			if (seen.has(key)) continue;
			seen.add(key);
			switch (row.event) {
				case "compute-start":
					computeStarts += 1;
					if (typeof row.tn === "number" && typeof row.tokens === "number") computeLeadTokens.push(row.tn - row.tokens);
					break;
				case "compute-ready":
					computeReady += 1;
					if (row.elapsedMs !== undefined) computeDurations.push(row.elapsedMs);
					break;
				case "proposal": proposals += 1; break;
				case "applied":
					if (!Number.isFinite(row.tokens) || !Number.isFinite(row.tn) || row.tn === null || row.tn <= 0 || row.tokens === null) unknownPressureCommits += 1;
					else if (row.tokens < row.tn) earlyCommits += 1;
					else lateCommits += 1;
					break;
				case "fallback-start":
					if (row.reason === "threshold") {
						thresholdFallbacks += 1;
						if (Object.hasOwn(thresholdFallbackPhases, row.phase)) thresholdFallbackPhases[row.phase] += 1;
					}
					else if (row.reason === "overflow") overflowRecoveries += 1;
					else if (row.reason === "manual") manualCompactions += 1;
					break;
				case "fallback-end":
					if (row.failed) fallbackFailed += 1;
					else fallbackCompleted += 1;
					if (row.elapsedMs !== undefined) fallbackDurations.push(row.elapsedMs);
					break;
			}
		}
	}
	const opportunities = earlyCommits + lateCommits + unknownPressureCommits + thresholdFallbacks;
	return {
		sessionsWithMetrics, computeStarts, computeReady, proposals,
		earlyCommits, lateCommits, unknownPressureCommits,
		thresholdFallbacks, overflowRecoveries, manualCompactions, fallbackCompleted, fallbackFailed,
		observedEarlyTakeoverRate: opportunities ? earlyCommits / opportunities : null,
		counterfactualM1Available: false,
		thresholdFallbackPhases,
		computeLeadTokens: sampleStats(computeLeadTokens),
		computeMs: sampleStats(computeDurations),
		fallbackMs: sampleStats(fallbackDurations),
	};
}
