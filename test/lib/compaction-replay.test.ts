/**
 * Replay tool tests (SPEC SC §7.2, task W2) — the `--self-check` layer as a
 * vitest suite: metric math pinned on synthetic fixtures (INV-7: no real
 * session content anywhere near the repo).
 *
 * Requirement → test map:
 *   回放 AC → extract/simulate/aggregate correctness (crossing counting,
 *             precommit accounting, M1 ∈ [0,1], waste counting, scheme
 *             equivalence classes)
 *   --self-check → selfCheck() passes and mirrors these assertions
 *   O1/O2 对比 → every registered scheme produces M1/M3b/M10 fields
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
	aggregate,
	contextTokensOf,
	extractSession,
	parseSessionFile,
	selfCheck,
	sessionThreshold,
	simulateSession,
	SCHEMES,
	summaryLatencyMs,
} from "../../scripts/compaction-replay.mjs";

const fixtures = join(__dirname, "..", "fixtures", "compaction", "synthetic");

function loadFixture(name: string) {
	return extractSession(parseSessionFile(join(fixtures, name)));
}

describe("replay pipeline on synthetic fixtures", () => {
	it("extracts turns, compactions and threshold from session-a", () => {
		const session = loadFixture("session-a.jsonl");
		expect(session.turns.length).toBeGreaterThan(50);
		expect(session.compactions).toHaveLength(1);
		expect(session.compactions[0].tokensBefore).toBe(250_000);
		expect(sessionThreshold(session)).toBe(250_000);
		expect(session.turns[0].tokens).toBeGreaterThan(0);
	});

	it("contextTokensOf prefers totalTokens and falls back to components", () => {
		expect(contextTokensOf({ totalTokens: 42, input: 1, output: 2 })).toBe(42);
		expect(contextTokensOf({ input: 10, output: 5, cacheRead: 1, cacheWrite: 1 })).toBe(17);
		expect(contextTokensOf(undefined)).toBeNull();
		expect(contextTokensOf({})).toBeNull();
	});

	it("summaryLatencyMs matches the spec model (10s + 0.5ms/input token)", () => {
		expect(summaryLatencyMs(0)).toBe(10_000);
		expect(summaryLatencyMs(100_000)).toBe(60_000);
	});

	it("simulateSession counts the crossing and a precommit under fixed-ratio", () => {
		const session = loadFixture("session-a.jsonl");
		const result = simulateSession(session, 250_000, "fixed-ratio");
		expect(result.crossings).toBe(1);
		expect(result.computesStarted).toBeGreaterThanOrEqual(1);
		// Aggregates stay in range; cut metrics exist (the fixture HAS messages).
		const agg = aggregate([result]);
		expect(agg.m1_thresholdPrecommitRate).toBeGreaterThanOrEqual(0);
		expect(agg.m1_thresholdPrecommitRate).toBeLessThanOrEqual(1);
		expect(agg.m3_tailFloorRate).toBe(1); // every cut kept ≥ keep (CUT-02 by construction)
	});

	it("burst session-b: idle gaps + toolUse turns still produce legal simulations", () => {
		const session = loadFixture("session-b.jsonl");
		const result = simulateSession(session, 160_000, "fixed-ratio");
		expect(result.crossings).toBe(1);
		expect(result.computesStarted).toBeGreaterThanOrEqual(1);
	});

	it("every registered scheme reports M1/M3b/M10 (O1/O2 comparison surface)", () => {
		const session = loadFixture("session-a.jsonl");
		for (const scheme of Object.keys(SCHEMES)) {
			const agg = aggregate([simulateSession(session, 250_000, scheme)]);
			expect(agg).toHaveProperty("m1_thresholdPrecommitRate");
			expect(agg).toHaveProperty("m3b_capacityRate");
			expect(agg).toHaveProperty("m10_wastedComputeRate");
		}
	});

	it("aggregate sums waste and class counts across sessions", () => {
		const a = simulateSession(loadFixture("session-a.jsonl"), 250_000, "fixed-ratio");
		const b = simulateSession(loadFixture("session-b.jsonl"), 160_000, "fixed-ratio");
		const agg = aggregate([a, b]);
		expect(agg.raw.crossings).toBe(a.crossings + b.crossings);
		expect(agg.raw.computesStarted).toBe(a.computesStarted + b.computesStarted);
		expect(agg.raw.wastedInputTokens).toBe(a.wastedInputTokens + b.wastedInputTokens);
	});

	it("self-check passes (the --self-check entry point)", () => {
		expect(selfCheck()).toBe(true);
	});

	it("INV-7: the replay script source emits no per-session identifiers", () => {
		const source = readFileSync(join(__dirname, "..", "..", "scripts", "compaction-replay.mjs"), "utf-8");
		// The report object may only carry aggregate keys (spot-check the
		// report construction does not embed file paths / session ids).
		expect(source).not.toMatch(/files:\s*\[.*file/);
		expect(source).toContain("aggregates only");
	});
});
