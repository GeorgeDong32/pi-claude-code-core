/*
 * rex-flow ledger + signal tests (SPEC SC §5.6 LED-05/05b/05c, CUT-04,
 * INV-6; task W7) and long-task signals (W8).
 *
 * Requirement → test map:
 *   LED-05  → "open runs full detail / closed one-line / other-open count"
 *   LED-05b → "three layouts discovered", "cross-project decoy excluded",
 *             "association (a) explicit", "association (b) repo+observed",
 *             "unassociated → sentinel-only", "too-large → reason code"
 *   LED-05c → "run-closed signal fires after the first plain assistant
 *             following a run-done sentinel" (and CUT-04 via selectCut)
 *   LED-06  → association drives narrativeHeader wording (covered in W6;
 *             here: state.associated is the switch)
 *   INV-6   → read-only + 2 MiB cap (too-large fixture) + fail-open
 *   W8      → goal-step / git-commit / verified signal units
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { buildFlowLedger, observeSession, previousLedgerRunIds } from "../ledger/rex-flow.ts";
import { runClosedSignal } from "../signals/rex-flow.ts";
import { gitCommitSignal, goalStepSignal, verifiedSignal } from "../signals/long-task.ts";
import { selectCut } from "../cutpoint.ts";
import { jointFeasibility } from "../policy.ts";
import { DEFAULT_COMPACTION_CORE_SETTINGS, type CompactionSettings } from "../settings.ts";
import { assistantEntry, userEntry, toolResultEntry } from "./helpers.ts";
import type { ProjectedEntry } from "../types.ts";
import type { CompressedRegionView } from "../ledger/types.ts";

const FIXTURES = join(import.meta.dirname ?? ".", "..", "..", "..", "test", "fixtures", "compaction", "rex-flow");

function settings(over: Partial<CompactionSettings> = {}): CompactionSettings {
	return { ...DEFAULT_COMPACTION_CORE_SETTINGS, ...over };
}

/** A region that OBSERVED r2 via a sentinel line. */
function regionWithSentinel(runId = "r2"): CompressedRegionView {
	return {
		entries: [
			userEntry("kick off"),
			assistantEntry("===FLOW-REPORT=== r2/t1 worker:ready progress 40%"),
			toolResultEntry("ok"),
			assistantEntry("work continues"),
		],
	};
	void runId;
}

/** A cwd with a git origin config for association rule (b). */
function gitCwd(repo: string): string {
	const dir = mkdtempSync(join(tmpdir(), "sc-git-"));
	mkdirSync(join(dir, ".git"), { recursive: true });
	writeFileSync(join(dir, ".git", "config"), `[remote "origin"]\n\turl = git@github.com:${repo}.git\n`);
	return dir;
}

test("LED-05b: three board layouts are discovered (dashed / ws-root-named / legacy)", () => {
	for (const [home, repo] of [
		[join(FIXTURES, "home-a"), "acme/proj-a"],
		[join(FIXTURES, "home-b"), "acme/proj-b"],
		[join(FIXTURES, "home-c"), "acme/proj-c"],
	] as const) {
		const cwd = gitCwd(repo);
		try {
			// Observe a run id that actually exists on THAT home's board.
			const observedRun = home.endsWith("home-a") ? "r2" : home.endsWith("home-b") ? "r9" : "r5";
			const region = { entries: [userEntry("start"), assistantEntry(`===FLOW-REPORT=== ${observedRun} t1 ready`)] };
			const result = buildFlowLedger({ cwd, homeDir: home, settings: settings(), region });
			assert.equal(result.state.associated, true, `${home}: board must associate`);
			assert.ok(result.state.openRuns.length >= 1);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	}
});

test("LED-05b: the cross-project decoy NEVER leaks (other project's only-active board)", () => {
	// cwd is project A (origin acme/proj-a); the decoy board (other/proj-B,
	// run r77) sits in the same home. The session observed r2 (project A).
	const cwd = gitCwd("acme/proj-a");
	try {
		const result = buildFlowLedger({ cwd, homeDir: join(FIXTURES, "home-a"), settings: settings(), region: regionWithSentinel() });
		assert.equal(result.state.associated, true);
		const all = JSON.stringify(result.state);
		assert.ok(!all.includes("DECOY"), "the decoy project's content must never appear");
		assert.ok(!all.includes("r77"));
		// Project A's own open run r2 IS present with full detail.
		const r2 = result.state.openRuns.find((run) => run.runId === "r2");
		assert.ok(r2, "observed run r2 must have a detail row");
		assert.equal(r2?.tasks.length, 2);
		assert.equal(r2?.openGates.length, 1);
		assert.match(r2?.openGates[0]?.question ?? /$/, /row cap/);
		// r1 (done) is a one-liner with merged counts.
		assert.ok(result.state.closed.some((item) => item.id === "r1" && /1\/1 merged/.test(item.detail ?? "")));
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("LED-05b (a): an explicit settings boardPath associates WITHOUT a repo match", () => {
	const cwd = gitCwd("unrelated/repo");
	try {
		const result = buildFlowLedger({
			cwd,
			homeDir: join(FIXTURES, "home-b"), // enumeration also finds it, but repo differs
			settings: settings({ ledger: { rexFlow: { enabled: true, boardPath: join(FIXTURES, "home-b", ".rex-flow", "projects", "Users-x-proj-b", "board.json") } } }),
			region: { entries: [userEntry("go"), assistantEntry("===FLOW-REPORT=== r9/t1 doing")] },
		});
		assert.equal(result.state.associated, true); // rule (a): the session configured it
		assert.equal(result.state.openRuns[0]?.runId, "r9");
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("LED-05b (b): repo match WITHOUT an observed run does NOT associate", () => {
	const cwd = gitCwd("acme/proj-a");
	try {
		const result = buildFlowLedger({ cwd, homeDir: join(FIXTURES, "home-a"), settings: settings(), region: { entries: [userEntry("plain session")] } });
		assert.equal(result.state.associated, false);
		assert.equal(result.reason, "board-unassociated");
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("LED-05b/INV-6: an oversized board is refused with a reason code (2 MiB cap, fail-open)", () => {
	const cwd = gitCwd("nobody/x");
	try {
		const result = buildFlowLedger({
			cwd,
			homeDir: join(FIXTURES, "home-a"),
			settings: settings({ ledger: { rexFlow: { enabled: true, boardPath: join(FIXTURES, "home-a", ".rex-flow", "projects", "--big--", "board.json") } } }),
			region: regionWithSentinel(),
		});
		assert.equal(result.state.associated, false);
		assert.equal(result.reason, "board-corrupt"); // oversized folds into the corrupt/undreadable bucket
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("LED-05b: no boards at all → board-none, sentinel-only state", () => {
	const emptyHome = mkdtempSync(join(tmpdir(), "sc-empty-"));
	const cwd = gitCwd("a/b");
	try {
		const result = buildFlowLedger({ cwd, homeDir: emptyHome, settings: settings(), region: regionWithSentinel() });
		assert.equal(result.state.associated, false);
		assert.equal(result.reason, "board-none");
		assert.ok(result.state.sentinels.length >= 1);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
		rmSync(emptyHome, { recursive: true, force: true });
	}
});

test("LED-05: unobserved open runs on a trusted board collapse to the count line", () => {
	const cwd = gitCwd("acme/proj-b");
	try {
		const region = { entries: [userEntry("go"), assistantEntry("===FLOW-REPORT=== r9/t1 doing")] };
		const result = buildFlowLedger({ cwd, homeDir: join(FIXTURES, "home-b"), settings: settings(), region });
		assert.equal(result.state.openRuns.length, 1);
		assert.equal(result.state.otherOpenRuns, 0); // r9 is the only run and it IS observed
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("LED-02b: previousLedgerRunIds carries run ids across compactions", () => {
	const ids = previousLedgerRunIds(`narrative\n<cc-core-ledger v="1">\n## Open work\n[flow r7 · executing] x\n  r7/t1 doing\n</cc-core-ledger>`);
	assert.ok(ids.has("r7"));
	assert.deepEqual([...previousLedgerRunIds("no block")], []);
});

test("observeSession picks up --board args and dispatch paths", () => {
	const region: CompressedRegionView = {
		entries: [userEntry("run flow-board --board /tmp/b1 and read /x/.rex-flow/projects/--p--/dispatch/r2.json then start")],
	};
	const observation = observeSession(region);
	assert.ok(observation.usedBoardHints.includes("/tmp/b1"));
	assert.ok(observation.usedBoardHints.some((hint) => hint.endsWith("--p--")));
});

test("LED-05c: run-closed fires only after the FIRST plain assistant post run-done", () => {
	// Realistic shape: the sentinel rides a toolResult (flow-board output).
	const toolTurn = assistantEntry("query board", { toolCalls: 1 });
	const sentinelResult = toolResultEntry("===FLOW-REPORT=== r2 run-done all tasks merged");
	const plain1 = assistantEntry("run r2 wrapped, summarizing results now");
	const plain2 = assistantEntry("later chat");
	const entries = [userEntry("go"), toolTurn, sentinelResult, plain1, plain2];
	const fire = (index: number) => runClosedSignal.weight({ entries, index, idleGapMs: 600_000 });
	assert.equal(fire(entries.indexOf(plain1)), 1); // first plain assistant after the sentinel
	assert.equal(fire(entries.indexOf(plain2)), 0); // later plain assistants do NOT re-fire
	assert.equal(fire(entries.indexOf(toolTurn)), 0); // toolCall turns never fire
});

test("CUT-04: a run-closed boundary inside the window WINS the cut", () => {
	const entries: ProjectedEntry[] = [
		userEntry("kick off"),
		assistantEntry("query board", { toolCalls: 1 }),
		toolResultEntry("===FLOW-REPORT=== r2 run-done merged"),
		assistantEntry("wrap-up prose for the closed run"),
		assistantEntry("z".repeat(400)),
	];
	const feasibility = jointFeasibility({ tn: 8_000, keepRecentTokens: 20, summaryTokenEstimate: 50, precomputeRatio: 0.6, applyRatio: 0.75, targetPostRatio: 0.45 });
	const result = selectCut(entries, {
		keepRecentTokens: 20,
		keepSlackTokens: 2_000,
		feasibility,
		weights: { "run-closed": 100, "goal-step": 90, user: 80, "git-commit": 60, verified: 55, "idle-gap": 50, "plain-turn": 30, "tool-turn": 10 },
		lambda: 20,
		idleGapMs: 600_000,
		signals: [runClosedSignal],
	});
	assert.equal(result.status, "ok");
	assert.equal(result.cut.boundaryClass, "run-closed");
	// The cut is the first legal cut after the run-closed boundary (the
	// wrap-up plain assistant) — the trailing z entry.
	assert.equal(result.cut.firstKeptEntryId, entries[4].sourceEntry.id);
});

test("W8 signals: goal-step / git-commit / verified", () => {
	const goalEntry = {
		sourceEntry: { type: "custom", id: "g-1", parentId: null, timestamp: "2026-11-09T10:00:00Z", customType: "pi-goal-event" },
		messages: [],
	} as unknown as ProjectedEntry;
	assert.equal(goalStepSignal.weight({ entries: [goalEntry], index: 0, idleGapMs: 600_000 }), 1);

	const commitEntry = {
		sourceEntry: { type: "message", id: "c-1", parentId: null, timestamp: "2026-11-09T10:00:00Z" },
		messages: [{ role: "assistant", content: [{ type: "toolCall", id: "t1", name: "bash", arguments: { command: "git commit -m x" } }] }],
	} as unknown as ProjectedEntry;
	assert.equal(gitCommitSignal.weight({ entries: [commitEntry], index: 0, idleGapMs: 600_000 }), 1);

	const testTurn = {
		sourceEntry: { type: "message", id: "t-1", parentId: null, timestamp: "2026-11-09T10:00:00Z" },
		messages: [{ role: "assistant", content: [{ type: "toolCall", id: "t1", name: "bash", arguments: { command: "pnpm run test" } }] }],
	} as unknown as ProjectedEntry;
	const passResult = {
		sourceEntry: { type: "message", id: "tr-1", parentId: null, timestamp: "2026-11-09T10:00:01Z" },
		messages: [{ role: "toolResult", content: [{ type: "toolResult", toolCallId: "t1", output: "exit code: 0" }] }],
	} as unknown as ProjectedEntry;
	assert.equal(verifiedSignal.weight({ entries: [testTurn, passResult], index: 1, idleGapMs: 600_000 }), 1);
	const failResult = {
		sourceEntry: { type: "message", id: "tr-2", parentId: null, timestamp: "2026-11-09T10:00:01Z" },
		messages: [{ role: "toolResult", content: [{ type: "toolResult", toolCallId: "t1", output: "exit code: 1 failed" }] }],
	} as unknown as ProjectedEntry;
	assert.equal(verifiedSignal.weight({ entries: [testTurn, failResult], index: 1, idleGapMs: 600_000 }), 0);
});
