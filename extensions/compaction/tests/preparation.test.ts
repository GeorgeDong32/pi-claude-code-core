/*
 * Preparation tests (SPEC SC §5.5 SUM-01/SUM-02, task W3).
 *
 * Requirement → test map:
 *   SUM-01 → differential vs the dist-internal prepareCompaction oracle
 *            (test-only deep import): cut/slices/previousSummary equal; the
 *            context_edit fixture proves edited-away content never re-enters
 *            the summary input (H15)
 *   SUM-02 → fileOps differential: assistant toolCalls + toolResult
 *            nestedCalls + previous PI-generated compaction's lists seed
 *            the sets identically to the oracle
 * Fixtures are synthetic (INV-7). Usage objects always carry `cost`
 * (W0 fixture fact #2: combineUsage dereferences usage.cost.input).
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { buildSessionProjection, findTurnStartIndex, SessionManager } from "@earendil-works/pi-coding-agent";
// Test-only oracle deep import (S2 precedent) — production never does this.
import { prepareCompaction } from "../../../node_modules/@earendil-works/pi-coding-agent/dist/core/compaction/compaction.js";

import { buildPreparation, computeFileLists } from "../preparation.ts";
import type { CutSelection } from "../types.ts";

const COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };

function userMsg(text: string) {
	return { role: "user" as const, content: [{ type: "text" as const, text }], timestamp: Date.now() };
}
function assistantMsg(text: string, toolCalls: Array<{ name: string; path: string }> = []) {
	const content: Array<Record<string, unknown>> = [{ type: "text", text }];
	for (const call of toolCalls) {
		content.push({ type: "toolCall", id: `c-${call.name}-${call.path}`, name: call.name, arguments: { path: call.path } });
	}
	return {
		role: "assistant" as const,
		content,
		timestamp: Date.now(),
		stopReason: "stop" as const,
		usage: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 20, cost: { ...COST } },
	};
}
function toolResultMsg(nested: Array<{ name: string; path: string }> = []) {
	return {
		role: "toolResult" as const,
		content: [{ type: "toolResult", toolCallId: "c-x", output: "ok" }],
		nestedCalls: { calls: nested.map((n) => ({ name: n.name, arguments: { path: n.path } })) },
		timestamp: Date.now(),
	} as never;
}

/** Derive OUR CutSelection from the oracle's own cut (same cut → the slice
 * differential then compares message assembly only). The oracle's
 * turnStartIndex is branch-relative — map both positions by entry id. */
function cutFromOracle(
	oracle: NonNullable<ReturnType<typeof prepareCompaction>>,
	projection: ReturnType<typeof buildSessionProjection>,
	branch: ReturnType<SessionManager["getBranch"]>,
): CutSelection {
	const index = projection.entries.findIndex((entry) => entry.sourceEntry.id === oracle.firstKeptEntryId);
	assert.ok(index >= 0, "oracle cut exists in projection");
	let turnStartIndex = -1;
	if (oracle.isSplitTurn) {
		// The oracle's preparation does not carry turnStartIndex (it stays on
		// the internal cutPoint) — derive it with the public
		// findTurnStartIndex from the branch, then map by id.
		const firstKeptBranchIndex = branch.findIndex((entry) => (entry as { id?: string }).id === oracle.firstKeptEntryId);
		const startBranchIndex = findTurnStartIndex(branch, firstKeptBranchIndex, 0);
		const startId = (branch[startBranchIndex] as { id?: string } | undefined)?.id;
		const mapped = startId !== undefined ? projection.entries.findIndex((e) => e.sourceEntry.id === startId) : -1;
		assert.ok(mapped >= 0, "oracle turn start exists in projection");
		turnStartIndex = mapped;
	}
	return {
		firstKeptEntryId: oracle.firstKeptEntryId,
		firstKeptEntryIndex: index,
		isSplitTurn: oracle.isSplitTurn,
		turnStartIndex,
		tailTokens: 0,
		boundaryClass: "user",
		score: 0,
	};
}

test("SUM-01 differential: slices/cut/previousSummary match the oracle (plain session)", () => {
	const dir = mkdtempSync(join(tmpdir(), "sc-prep-"));
	try {
		const sm = SessionManager.inMemory(dir);
		sm.appendMessage(userMsg("first user turn with a fairly long body") as never);
		sm.appendMessage(assistantMsg("assistant reply one ".repeat(60)) as never);
		sm.appendMessage(userMsg("second user turn ".repeat(40)) as never);
		sm.appendMessage(assistantMsg("assistant reply two ".repeat(60)) as never);
		sm.appendMessage(userMsg("third user turn, the kept tail") as never);
		sm.appendMessage(assistantMsg("final reply") as never);
		const settings = { enabled: true, reserveTokens: 16000, keepRecentTokens: 60 };
		const branch = sm.getBranch();
		const oracle = prepareCompaction(branch, settings);
		assert.ok(oracle, "oracle defined");
		const projection = buildSessionProjection(branch);
		const mine = buildPreparation({
			projection,
			cut: cutFromOracle(oracle, projection, branch),
			settings,
		});
		assert.ok(mine);
		assert.equal(mine.firstKeptEntryId, oracle.firstKeptEntryId);
		assert.equal(mine.isSplitTurn, oracle.isSplitTurn);
		assert.deepEqual(mine.messagesToSummarize, oracle.messagesToSummarize);
		assert.deepEqual(mine.turnPrefixMessages, oracle.turnPrefixMessages);
		assert.deepEqual(computeFileLists(mine.fileOps), { readFiles: [], modifiedFiles: [] });
		assert.ok(mine.tokensBefore > 0);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("SUM-01/SUM-02 differential: prior pi compaction seeds previousSummary + fileOps; toolCalls match", () => {
	const dir = mkdtempSync(join(tmpdir(), "sc-prep2-"));
	try {
		const sm = SessionManager.inMemory(dir);
		// History that the PRIOR compaction will summarize.
		sm.appendMessage(userMsg("old turn one with plenty of text ".repeat(20)) as never);
		sm.appendMessage(assistantMsg("old reply", [{ name: "read", path: "/a/read-only.ts" }, { name: "write", path: "/a/written.ts" }]) as never);
		sm.appendMessage(toolResultMsg([{ name: "edit", path: "/a/edited.ts" }]) as never);
		const keptFrom = sm.getBranch().at(-1)!;
		// PI-generated prior compaction (fromHook falsy) with its own lists.
		sm.appendCompaction(
			"previous narrative summary",
			(keptFrom as { id: string }).id,
			50_000,
			{ readFiles: ["/a/prev-read.ts"], modifiedFiles: ["/a/prev-mod.ts"] },
			false,
		);
		// Post-compaction conversation that WE will summarize now.
		sm.appendMessage(userMsg("new turn one ".repeat(30)) as never);
		sm.appendMessage(assistantMsg("new reply one ".repeat(50), [{ name: "read", path: "/a/read-only.ts" }, { name: "edit", path: "/a/new-edit.ts" }]) as never);
		sm.appendMessage(toolResultMsg() as never);
		sm.appendMessage(userMsg("new turn two ".repeat(30)) as never);
		sm.appendMessage(assistantMsg("new reply two ".repeat(50)) as never);

		const settings = { enabled: true, reserveTokens: 16000, keepRecentTokens: 80 };
		const branch = sm.getBranch();
		const oracle = prepareCompaction(branch, settings);
		assert.ok(oracle);
		const projection = buildSessionProjection(branch);
		const mine = buildPreparation({
			projection,
			cut: cutFromOracle(oracle, projection, branch),
			settings,
			previousSummaryNarrative: "previous narrative summary",
		});
		assert.ok(mine);
		assert.equal(mine.previousSummary, oracle.previousSummary);
		assert.deepEqual(mine.messagesToSummarize, oracle.messagesToSummarize);
		// SUM-02: sets seeded from prev pi compaction + live tool calls;
		// computeFileLists must equal the oracle's extraction end-to-end.
		assert.deepEqual(computeFileLists(mine.fileOps), {
			readFiles: [...(oracle.fileOps as { read: Set<string> }).read].filter(
				(f) => !new Set([...(oracle.fileOps as { written: Set<string> }).written, ...(oracle.fileOps as { edited: Set<string> }).edited]).has(f),
			).sort(),
			modifiedFiles: [...new Set([...(oracle.fileOps as { written: Set<string> }).written, ...(oracle.fileOps as { edited: Set<string> }).edited])].sort(),
		});
		// Spot-check the expected members (seeded + live). NOTE: /a/written.ts
		// and /a/edited.ts live in the PRIOR compaction's region — they reach
		// the lists only through the seeded pi-generated details, not the
		// already-summarized messages.
		const lists = computeFileLists(mine.fileOps);
		assert.ok(lists.modifiedFiles.includes("/a/prev-mod.ts"));
		assert.ok(lists.modifiedFiles.includes("/a/new-edit.ts"));
		assert.ok(lists.readFiles.includes("/a/prev-read.ts"));
		assert.ok(lists.readFiles.includes("/a/read-only.ts"));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("SUM-01 H15: a context_edit removing an entry keeps its text OUT of the summary input (both sides)", () => {
	const dir = mkdtempSync(join(tmpdir(), "sc-prep3-"));
	try {
		const sm = SessionManager.inMemory(dir);
		sm.appendMessage(userMsg("turn one ".repeat(30)) as never);
		const target = sm.appendMessage(assistantMsg("SECRET EDITED AWAY CONTENT ".repeat(20)) as never);
		sm.appendMessage(userMsg("turn two ".repeat(30)) as never);
		sm.appendMessage(assistantMsg("reply two ".repeat(40)) as never);
		sm.appendMessage(userMsg("turn three kept tail") as never);
		sm.appendContextEdit(target, null); // remove the assistant entry from context

		const settings = { enabled: true, reserveTokens: 16000, keepRecentTokens: 50 };
		const branch = sm.getBranch();
		const oracle = prepareCompaction(branch, settings);
		assert.ok(oracle);
		const projection = buildSessionProjection(branch);
		const mine = buildPreparation({
			projection,
			cut: cutFromOracle(oracle, projection, branch),
			settings,
		});
		assert.ok(mine);
		assert.deepEqual(mine.messagesToSummarize, oracle.messagesToSummarize);
		const allText = mine.messagesToSummarize
			.map((m) => (Array.isArray((m as { content?: unknown[] }).content) ? (m as { content: Array<{ text?: string }> }).content.map((b) => b.text ?? "").join("") : ""))
			.join(" ");
		assert.ok(!allText.includes("SECRET EDITED AWAY"), "edited-away content must not feed the summarizer (H15)");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("SUM-01: nothing to summarize → undefined (mirrors prepareCompaction)", () => {
	const dir = mkdtempSync(join(tmpdir(), "sc-prep4-"));
	try {
		const sm = SessionManager.inMemory(dir);
		sm.appendMessage(userMsg("single short turn") as never);
		const settings = { enabled: true, reserveTokens: 16000, keepRecentTokens: 50 };
		const branch = sm.getBranch();
		const oracle = prepareCompaction(branch, settings);
		const projection = buildSessionProjection(branch);
		// Cut at index 0 → everything summarized; cut at the last message with
		// keep 0 → the same. Use a cut that leaves nothing to summarize.
		const last = projection.entries.length - 1;
		const mine = buildPreparation({
			projection,
			cut: {
				firstKeptEntryId: projection.entries[last].sourceEntry.id,
				firstKeptEntryIndex: last,
				isSplitTurn: false,
				turnStartIndex: -1,
				tailTokens: 0,
				boundaryClass: "user",
				score: 0,
			},
			settings,
		});
		// The oracle with the same cut would summarize everything; ours at the
		// last entry has an empty history → undefined is the mirror of the
		// oracle's empty-message guard.
		assert.equal(mine, undefined);
		assert.equal(oracle === undefined || Array.isArray(oracle.messagesToSummarize), true);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
