/*
 * SC-MET-01 / INV-7: measurement-only writes, no policy effects, and honest
 * runtime aggregates (proposals/manual/overflow never inflate early success).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { metricFromEntry, recordCompactionMetric, summarizeCompactionMetrics, COMPACTION_METRICS_ENTRY_TYPE, type CompactionMetric } from "../metrics.ts";

function metric(event: CompactionMetric["event"], extra: Partial<CompactionMetric> = {}): CompactionMetric {
	return { v: 1, event, at: 100, tokens: 80, tn: 100, phase: "ready", degraded: false, precomputeRatio: 0.6, applyRatio: 0.75, cycleId: "cycle-1", ...extra };
}

test("SC-MET-01: writes are fail-open and use a separate v1 display-only schema", () => {
	const written: CompactionMetric[] = [];
	recordCompactionMetric((data) => written.push(data), metric("compute-start"));
	assert.equal(written[0]?.v, 1);
	assert.ok(Number.isFinite(written[0]?.at));
	assert.doesNotThrow(() => recordCompactionMetric(() => { throw new Error("disk failure"); }, metric("compute-start")));
	assert.equal(metricFromEntry({ type: "message", data: metric("applied") }), undefined);
	assert.equal(metricFromEntry({ type: "custom", customType: "cc-core-compaction", data: metric("applied") }), undefined);
	assert.equal(metricFromEntry({ type: "custom", customType: COMPACTION_METRICS_ENTRY_TYPE, data: { ...metric("applied"), v: 2 } }), undefined);
	assert.equal(metricFromEntry({ type: "custom", customType: COMPACTION_METRICS_ENTRY_TYPE, data: metric("applied") })?.event, "applied");
});

test("SC-MET-01: only confirmed early commits count; fallback reasons and unknown pressure stay separate", () => {
	const rows = [
		metric("compute-start"), metric("compute-ready", { elapsedMs: 40 }),
		metric("proposal", { proposalId: "lost" }),
		metric("applied", { proposalId: "early" }),
		metric("applied", { proposalId: "late", tokens: 100 }),
		metric("applied", { proposalId: "unknown", tokens: null }),
		metric("fallback-start", { attemptId: "t", reason: "threshold" }),
		metric("fallback-start", { attemptId: "o", reason: "overflow" }),
		metric("fallback-start", { attemptId: "m", reason: "manual" }),
		metric("fallback-end", { attemptId: "t", reason: "threshold", elapsedMs: 60, fromExtension: true }),
		metric("fallback-end", { attemptId: "o", reason: "overflow", elapsedMs: 10, failed: true }),
	];
	const report = summarizeCompactionMetrics([rows]);
	assert.equal(report.earlyCommits, 1);
	assert.equal(report.lateCommits, 1);
	assert.equal(report.unknownPressureCommits, 1);
	assert.equal(report.observedEarlyTakeoverRate, 1 / 4);
	assert.equal(report.counterfactualM1Available, false);
	assert.equal(report.thresholdFallbacks, 1);
	assert.equal(report.overflowRecoveries, 1);
	assert.equal(report.manualCompactions, 1);
	assert.equal(report.fallbackCompleted, 1);
	assert.equal(report.fallbackFailed, 1);
	assert.deepEqual(report.computeMs, { samples: 1, p50: 40, p90: 40 });
	assert.deepEqual(report.fallbackMs, { samples: 2, p50: 10, p90: 60 });
});

test("SC-MET-01: proposal alone is not success; duplicate rows dedupe within, not across, sessions", () => {
	assert.equal(summarizeCompactionMetrics([[metric("proposal", { proposalId: "p" })]]).observedEarlyTakeoverRate, null);
	const row = metric("applied", { proposalId: "p" });
	assert.equal(summarizeCompactionMetrics([[row, row], [row]]).earlyCommits, 2);
	assert.equal(summarizeCompactionMetrics([]).observedEarlyTakeoverRate, null);
});
