/*
 * Cutpoint tests (SPEC SC §5.4, task W1).
 *
 * Requirement → test map:
 *   CUT-01 → "CUT-01 seeded property: legality" (≥2000 seeded sessions)
 *   CUT-02 → "CUT-02 tail floor + native-equivalent fallback"
 *   CUT-03 → "CUT-03 preference/tie-breaks/determinism"
 *   CUT-05 → "CUT-05 giant single turn → legal split cut"
 *   CUT-06 → "CUT-06 10k entries ≤ 1s"
 *   CUT-07 → "CUT-07 throwing signal counts 0"
 *   CUT-08 → "CUT-08 seeded property: capacity-first" (≥2000 seeded sessions)
 * All fixtures synthetic (INV-7).
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { selectCut, suffixTokenSums, type CutpointParams } from "../cutpoint.ts";
import { bestBoundarySignal, type BoundarySignal } from "../signals/generic.ts";
import { jointFeasibility } from "../policy.ts";
import {
	assistantEntry,
	compactionEntry,
	mulberry32,
	pick,
	stateOnlyEntry,
	toolResultEntry,
	userEntry,
} from "./helpers.ts";
import type { ProjectedEntry } from "../types.ts";

const CUT_POINT_ROLES = new Set(["user", "assistant", "bashExecution", "custom", "branchSummary", "compactionSummary"]);

function params(over: Partial<CutpointParams> = {}): CutpointParams {
	return {
		keepRecentTokens: 100,
		keepSlackTokens: 40_000,
		feasibility: {
			feasible: true,
			effectiveSummaryTokens: 12_000,
			expectedGrowth: 3_000,
			tailMax: 1_000_000,
			neededTn: 107_000,
		},
		weights: {
			"run-closed": 100,
			"goal-step": 90,
			user: 80,
			"git-commit": 60,
			verified: 55,
			"idle-gap": 50,
			"plain-turn": 30,
			"tool-turn": 10,
		},
		lambda: 20,
		idleGapMs: 600_000,
		...over,
	};
}

/** Random synthetic session: user/assistant/tool interleavings + oddities. */
function randomSession(rng: () => number): ProjectedEntry[] {
	const length = 8 + Math.floor(rng() * 32);
	const entries: ProjectedEntry[] = [];
	if (rng() < 0.4) entries.push(compactionEntry());
	if (rng() < 0.2) entries.push(stateOnlyEntry("usage"));
	for (let i = 0; i < length; i += 1) {
		const roll = rng();
		const size = 40 + Math.floor(rng() * 3600); // 10..900 tokens via chars/4
		const text = "x".repeat(size * 4);
		if (roll < 0.25) {
			entries.push(userEntry(text));
		} else if (roll < 0.55) {
			entries.push(assistantEntry(text));
		} else if (roll < 0.8) {
			entries.push(assistantEntry(text, { toolCalls: 1 }));
			entries.push(toolResultEntry("r".repeat(size * 4)));
		} else if (roll < 0.9) {
			entries.push(stateOnlyEntry(pick(rng, ["usage", "label"])));
		} else {
			// consecutive assistants (no user in between)
			entries.push(assistantEntry(text, { toolCalls: 1 }));
			entries.push(toolResultEntry("r".repeat(size * 4)));
			entries.push(assistantEntry(text));
		}
	}
	return entries;
}

function assertLegalCut(entries: ProjectedEntry[], index: number, label: string): void {
	const entry = entries[index];
	assert.notEqual(entry.sourceEntry.type, "compaction", `${label}: cut at compaction entry`);
	assert.ok(
		entry.messages.some((message) => CUT_POINT_ROLES.has(message.role)),
		`${label}: cut at non-cut-point entry (role ${entry.messages[0]?.role ?? "none"})`,
	);
	let lastCompaction = -1;
	for (let i = 0; i < entries.length; i += 1) {
		if (entries[i].sourceEntry.type === "compaction") lastCompaction = i;
	}
	assert.ok(index > lastCompaction, `${label}: cut at/before the latest compaction boundary`);
}

test("CUT-01 seeded property: legality over 2000 random sessions (never toolResult, never pre-compaction)", () => {
	for (let seed = 1; seed <= 2000; seed += 1) {
		const rng = mulberry32(seed);
		const entries = randomSession(rng);
		const suffix = suffixTokenSums(entries);
		const keep = 50;
		const result = selectCut(entries, params({ keepRecentTokens: keep }));
		const label = `seed ${seed}`;
		assert.ok(result.status !== "infeasible", `${label}: wide window should not be infeasible`);
		if (result.status === "ok" || result.status === "native-equivalent") {
			assertLegalCut(entries, result.cut.firstKeptEntryIndex, label);
			if (suffix[0] >= keep) {
				// Session big enough: the cut must respect the keep floor.
				assert.ok(result.cut.tailTokens >= keep, `${label}: tail ${result.cut.tailTokens} < keep ${keep}`);
			}
			assert.equal(result.cut.firstKeptEntryId, entries[result.cut.firstKeptEntryIndex].sourceEntry.id, `${label}: id mismatch`);
		}
	}
});

test("CUT-02: tail floor in every result; window-empty falls back to native-equivalent", () => {
	// Window collapsed to a single token value (150) that no suffix hits
	// (suffix values here: 400/300/200/100) → fallback.
	const entries = [
		userEntry("x".repeat(400)),
		assistantEntry("y".repeat(400)),
		toolResultEntry("r".repeat(400)),
		assistantEntry("z".repeat(400)),
	];
	const result = selectCut(
		entries,
		params({ keepRecentTokens: 150, keepSlackTokens: 0, feasibility: { feasible: true, effectiveSummaryTokens: 0, expectedGrowth: 0, tailMax: 150, neededTn: 0 } }),
	);
	assert.equal(result.status, "native-equivalent");
	assert.ok(result.cut.tailTokens >= 1);
	assertLegalCut(entries, result.cut.firstKeptEntryIndex, "cut-02 fallback");

	// Wide window: every ok result keeps at least `keep`.
	for (let seed = 1; seed <= 50; seed += 1) {
		const rng = mulberry32(seed + 10_000);
		const session = randomSession(rng);
		const out = selectCut(session, params({ keepRecentTokens: 120 }));
		if (out.status === "ok") assert.ok(out.cut.tailTokens >= 120, `seed ${seed}`);
	}
});

test("CUT-03: highest class wins; same class → closest to native; ties → older index; deterministic", () => {
	// Fixture (token sizes): u0=100, a1=100, u2=100, a3(tool)=100, tr4=100, a5=100.
	const u0 = userEntry("u".repeat(400));
	const a1 = assistantEntry("a".repeat(400));
	const u2 = userEntry("u".repeat(400));
	const a3 = assistantEntry("a".repeat(400), { toolCalls: 1 });
	const tr4 = toolResultEntry("r".repeat(400));
	const a5 = assistantEntry("z".repeat(400));
	const entries = [u0, a1, u2, a3, tr4, a5];
	// suffix: u0=600 a1=500 u2=400 a3=300 tr4=200 a5=100; native (keep=100) → a5.
	const winner = selectCut(entries, params({ keepRecentTokens: 100 }));
	assert.equal(winner.status, "ok");
	// Candidate cuts: a1 (user boundary after u0, tail 500) vs a3 (user
	// boundary after u2, tail 300). Same class; a3 is closer to native(100).
	assert.equal(winner.cut.firstKeptEntryId, a3.sourceEntry.id);
	assert.equal(winner.cut.boundaryClass, "user");

	// Equal-WEIGHT tie broken by distance to the native tail: a git-commit
	// boundary right at the native cut beats an equally-weighted user boundary
	// further away (native = a5, tail 100).
	const gitCommitAtLast: BoundarySignal = {
		name: "git-commit",
		weight: (ctx) => (ctx.index === 4 ? 1 : 0),
	};
	const tieWeights = { ...params().weights, user: 80, "git-commit": 80 } as Record<string, number>;
	const tied = selectCut(entries, params({ keepRecentTokens: 100, signals: [gitCommitAtLast], weights: tieWeights }));
	assert.equal(tied.status, "ok");
	// cut@5 (tail 100, dist 0, weight 80) vs cut@3 (user, tail 300, dist 200):
	// equal class weight — the closer-to-native cut@5 must win.
	assert.equal(tied.cut.firstKeptEntryIndex, 5);
	assert.equal(tied.cut.boundaryClass, "git-commit");

	// Determinism: identical input → identical output (deep).
	const again = selectCut(entries, params({ keepRecentTokens: 100, signals: [gitCommitAtLast], weights: tieWeights }));
	assert.deepEqual(tied, again);
});

test("CUT-05: 4 user entries over a giant single turn still yields a legal split cut", () => {
	const entries: ProjectedEntry[] = [];
	for (let u = 0; u < 4; u += 1) {
		entries.push(userEntry(`task ${u}: ` + "u".repeat(2000)));
		for (let i = 0; i < 300; i += 1) {
			entries.push(assistantEntry("a".repeat(400), { toolCalls: 1 }));
			entries.push(toolResultEntry("r".repeat(800)));
		}
	}
	const result = selectCut(entries, params({ keepRecentTokens: 3_000 }));
	assert.equal(result.status, "ok");
	assertLegalCut(entries, result.cut.firstKeptEntryIndex, "cut-05");
	assert.ok(result.cut.tailTokens >= 3_000);
	if (result.cut.isSplitTurn) {
		const start = entries[result.cut.turnStartIndex];
		assert.equal(start.messages[0].role, "user", "turn start must be a user-role entry");
		for (let i = result.cut.turnStartIndex; i < result.cut.firstKeptEntryIndex; i += 1) {
			// No other turn start between the split point and its turn start.
			const role = entries[i].messages[0]?.role;
			if (i > result.cut.turnStartIndex) {
				assert.ok(role !== "user", "inner user entry would be its own turn start");
			}
		}
	} else {
		// Cutting at a turn start is also legal (no split needed).
		assert.equal(entries[result.cut.firstKeptEntryIndex].messages[0].role, "user");
	}
});

test("CUT-06: 10k entries ≤ 1s (log actual)", () => {
	const entries: ProjectedEntry[] = [];
	for (let i = 0; i < 10_000; i += 1) {
		if (i % 97 === 0) entries.push(userEntry("u".repeat(400)));
		else if (i % 3 === 0) entries.push(assistantEntry("a".repeat(400), { toolCalls: 1 }));
		else if (i % 3 === 1) entries.push(toolResultEntry("r".repeat(800)));
		else entries.push(assistantEntry("a".repeat(400)));
	}
	const started = performance.now();
	const result = selectCut(entries, params({ keepRecentTokens: 2_000 }));
	const elapsed = performance.now() - started;
	console.log(`[CUT-06] selectCut over ${entries.length} entries: ${elapsed.toFixed(1)}ms`);
	assert.ok(elapsed <= 1_000, `selectCat took ${elapsed}ms`);
	assert.ok(result.status === "ok" || result.status === "native-equivalent");
});

test("CUT-07: a throwing signal counts 0 and never affects the others", () => {
	const throwing: BoundarySignal = {
		name: "run-closed",
		weight: () => {
			throw new Error("signal bug");
		},
	};
	const entries = [userEntry("u".repeat(400)), assistantEntry("a".repeat(400))];
	const verdict = bestBoundarySignal([throwing], { entries, index: 0, idleGapMs: 600_000 }, { "run-closed": 100 });
	assert.deepEqual(verdict, { name: "none", weight: 0 });
	// With the generic signals alongside, the user boundary still fires.
	const mixed = bestBoundarySignal(
		[throwing, { name: "user", weight: () => 1 }],
		{ entries, index: 0, idleGapMs: 600_000 },
		{ "run-closed": 100, user: 80 },
	);
	assert.deepEqual(mixed, { name: "user", weight: 80 });
	// selectCut tolerates a throwing signal without propagating.
	const result = selectCut(entries, params({ keepRecentTokens: 50, signals: [throwing] }));
	assert.ok(result.status === "ok" || result.status === "native-equivalent");
});

test("CUT-08: capacity-first property — semantic candidates outside tailMax are never selected", () => {
	let infeasibleCount = 0;
	let okCount = 0;
	for (let seed = 1; seed <= 2000; seed += 1) {
		const rng = mulberry32(seed + 500_000);
		const entries = randomSession(rng);
		const suffix = suffixTokenSums(entries);
		const keep = 100 + Math.floor(rng() * 1_000);
		// 15% of seeds: tailMax strictly below keep (→ infeasible branch);
		// otherwise a window from tight to wide exercising the capacity filter.
		const tailMax = rng() < 0.15 ? keep - Math.floor(rng() * 400) - 1 : keep + Math.floor(rng() * 8_000);
		const result = selectCut(
			entries,
			params({ keepRecentTokens: keep, feasibility: { feasible: true, effectiveSummaryTokens: 0, expectedGrowth: 0, tailMax, neededTn: 0 } }),
		);
		const label = `seed ${seed} (keep=${keep}, tailMax=${tailMax})`;
		if (tailMax < keep) {
			assert.equal(result.status, "infeasible", `${label}: tailMax < keep must be infeasible`);
			infeasibleCount += 1;
			continue;
		}
		const cap = Math.min(keep + 40_000, tailMax);
		const hasCandidate = entries.some(
			(_, i) =>
				entries[i].sourceEntry.type !== "compaction" &&
				entries[i].messages.some((m) => CUT_POINT_ROLES.has(m.role)) &&
				suffix[i] >= keep &&
				suffix[i] <= cap,
		);
		if (hasCandidate) {
			assert.equal(result.status, "ok", `${label}: candidate exists → ok (not fallback)`);
			okCount += 1;
			assert.ok(result.cut.tailTokens <= cap, `${label}: tail ${result.cut.tailTokens} > cap ${cap}`);
			assert.ok(result.cut.tailTokens >= keep, `${label}: tail < keep`);
			assertLegalCut(entries, result.cut.firstKeptEntryIndex, label);
		} else {
			assert.equal(result.status, "native-equivalent", `${label}: no candidate → native fallback`);
		}
	}
	assert.ok(infeasibleCount > 100, "fixture should exercise the infeasible branch");
	assert.ok(okCount > 1000, "fixture should exercise the ok branch");
});

test("CUT-08 (spec fixture): default params at T_n=40K → infeasible; relaxed keep → feasible cut", () => {
	const defaultFeasibility = jointFeasibility({
		tn: 40_000,
		keepRecentTokens: 20_000,
		summaryTokenEstimate: 12_000,
		precomputeRatio: 0.6,
		applyRatio: 0.75,
		targetPostRatio: 0.45,
	});
	assert.equal(defaultFeasibility.feasible, false);
	const entries: ProjectedEntry[] = [];
	for (let i = 0; i < 400; i += 1) {
		entries.push(assistantEntry("a".repeat(400), { toolCalls: 1 }));
		entries.push(toolResultEntry("r".repeat(400)));
	}
	const infeasible = selectCut(entries, params({ keepRecentTokens: 20_000, feasibility: defaultFeasibility }));
	assert.equal(infeasible.status, "infeasible");
	assert.ok(infeasible.neededTn !== undefined && infeasible.neededTn > 40_000);

	const relaxed = jointFeasibility({
		tn: 40_000,
		keepRecentTokens: 4_000,
		summaryTokenEstimate: 3_000,
		precomputeRatio: 0.6,
		applyRatio: 0.75,
		targetPostRatio: 0.45,
	});
	assert.equal(relaxed.feasible, true);
	const ok = selectCut(entries, params({ keepRecentTokens: 4_000, feasibility: relaxed }));
	assert.equal(ok.status, "ok");
	assert.ok(ok.cut.tailTokens >= 4_000);
	assert.ok(ok.cut.tailTokens <= relaxed.tailMax);
});
