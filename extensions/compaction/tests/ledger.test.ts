/*
 * Ledger tests (SPEC SC §5.6, task W6).
 *
 * Requirement → test map:
 *   LED-01 → "degradation ladder" (each step degrades in order; Tier A
 *            id+status survive every level ≤ maxOpenItems)
 *   LED-02 → "directives classification + budget ladder" (standing/normal/
 *            flow-dispatch; oldest normal folds first; standing last;
 *            pointer lines carry entryId; +K older count)
 *   LED-02b → "carry-over across rounds" (≥3 rounds, standing survives,
 *            pointer lines never disappear)
 *   LED-03 → "goal section reuses the goal module's formatter" (source
 *            shape, focused + other-open + terminal)
 *   LED-04 → "verification + background scans" (test command verdict,
 *            commit subject, in-flight bg items)
 *   LED-06 → "narrative header variants" (trusted board vs sentinel-only)
 *   LED-07 → "provider isolation" (a throwing provider → unavailable, not
 *            a throw; others intact)
 *   LED-08 → "self-check" (Tier A/B findable; sabotage → ok:false)
 *   INV-8  → block ≤ COMPACTION_LEDGER_MAX after the ladder
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { COMPACTION_LEDGER_MAX } from "../../../lib/context-budget.ts";
import { assembleLedger, narrativeHeader } from "../ledger/assemble.ts";
import { collectDirectives, isFlowDispatch, isStanding, parseCarriedDirectives, renderDirectives } from "../ledger/directives.ts";
import { goalSection } from "../ledger/goal.ts";
import { bgSection } from "../ledger/bg.ts";
import { scanVerification } from "../ledger/verification.ts";
import { renderFileActivity } from "../ledger/files.ts";
import { DEFAULT_COMPACTION_CORE_SETTINGS, type CompactionSettings } from "../settings.ts";
import type {
	BgItem,
	CompressedRegionView,
	GoalLedgerState,
	LedgerDirective,
	LedgerProviders,
} from "../ledger/types.ts";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { createGoal, type GoalRecord } from "../../goal/goal-record.ts";
import type { GoalLedgerEvent } from "../../goal/goal-ledger.ts";

function userEntry(id: string, text: string, timestamp = "2026-11-09T10:00:00Z"): CompressedRegionView["entries"][number] {
	const message = { role: "user", content: [{ type: "text", text }] } as unknown as AgentMessage;
	return { sourceEntry: { type: "message", id, parentId: null, timestamp } as never, messages: [message] };
}

function assistantEntry(id: string, toolCalls: Array<{ name: string; arguments: Record<string, unknown> }>, text = ""): CompressedRegionView["entries"][number] {
	const content: Array<Record<string, unknown>> = text ? [{ type: "text", text }] : [];
	for (const call of toolCalls) content.push({ type: "toolCall", id: `c-${id}-${call.name}`, ...call });
	const message = { role: "assistant", content } as unknown as AgentMessage;
	return { sourceEntry: { type: "message", id, parentId: null, timestamp: "2026-11-09T10:00:01Z" } as never, messages: [message] };
}

function toolResultEntry(id: string, output: string): CompressedRegionView["entries"][number] {
	const message = { role: "toolResult", content: [{ type: "toolResult", toolCallId: id, output }] } as unknown as AgentMessage;
	return { sourceEntry: { type: "message", id, parentId: null, timestamp: "2026-11-09T10:00:02Z" } as never, messages: [message] };
}

function settings(over: Partial<CompactionSettings> = {}): CompactionSettings {
	return { ...DEFAULT_COMPACTION_CORE_SETTINGS, ...over };
}

test("LED-02: classification — standing/normal/flow-dispatch", () => {
	assert.equal(isStanding("以后必须用 pnpm", DEFAULT_COMPACTION_CORE_SETTINGS.standingPatterns), true);
	assert.equal(isStanding("never push directly", DEFAULT_COMPACTION_CORE_SETTINGS.standingPatterns), true);
	assert.equal(isStanding("帮我看下这个文件", DEFAULT_COMPACTION_CORE_SETTINGS.standingPatterns), false);
	assert.equal(isFlowDispatch("【worker】读 dispatch-7.json 后按其中派单开工"), true);
	assert.equal(isFlowDispatch("===FLOW-DISPATCH=== r9"), true);
	assert.equal(isFlowDispatch("普通的用户消息"), false);
	const region: CompressedRegionView = {
		entries: [
			userEntry("u1", "必须先跑测试再提交"),
			userEntry("u2", "【worker】读 .rex-flow/x/dispatch/r9 后按其中派单开工"),
			userEntry("u3", "顺便看下日志"),
		],
	};
	const directives = collectDirectives(region, DEFAULT_COMPACTION_CORE_SETTINGS.standingPatterns);
	assert.deepEqual(directives.map((d) => [d.class, d.entryId]), [
		["standing", "u1"],
		["flow-dispatch", "u2"],
		["normal", "u3"],
	]);
});

test("LED-02: budget ladder — oldest normal folds first (head→pointer), standing last, +K count", () => {
	const directive = (id: string, text: string, klass: LedgerDirective["class"] = "normal"): LedgerDirective => ({
		class: klass, text, entryId: id, time: "2026-11-09T10:00:00Z",
	});
	// Newest-first ordering is derived internally from input order (oldest → newest).
	const directives = [
		directive("n1", "o".repeat(200)), // oldest normal
		directive("n2", "t".repeat(200)),
		directive("s1", "始终用中文回复，必须在提交前运行完整测试套件并且不要跳过任何检查步骤", "standing"),
	];
	const rendered = renderDirectives(directives, { directivesMax: 260, perDirectiveMax: 1500, maxDirectiveLines: 100, foldHeadChars: 20 });
	// n1 (oldest normal) folded to head+pointer; standing s1 still verbatim.
	assert.ok(rendered.lines.some((line) => line.startsWith(`- oooo`) && line.includes(`[#n1 @2026-11-09T10:00:00Z]`)), rendered.lines.join("\n"));
	assert.ok(rendered.lines.some((line) => line.includes("始终用中文回复")));
	assert.equal(rendered.degradation.collapsed >= 1, true);

	// Squeeze harder: everything to pointer-only, standing included.
	const squeezed = renderDirectives(directives, { directivesMax: 1, perDirectiveMax: 1500, maxDirectiveLines: 100, foldHeadChars: 20 });
	assert.ok(squeezed.lines.every((line) => line.startsWith("- (see session)") || line.startsWith("+")));
	assert.ok(squeezed.lines.some((line) => line.includes("#s1 @")));

	// Line-count cap: +K older directives count line.
	const many = Array.from({ length: 12 }, (_, i) => directive(`m${i}`, `directive ${i}`));
	const capped = renderDirectives(many, { directivesMax: 100_000, perDirectiveMax: 1500, maxDirectiveLines: 5, foldHeadChars: 20 });
	assert.ok(capped.lines.at(-1)!.startsWith("+7 older directives — originals remain in the session file"));
});

test("LED-02b: carry-over — directives survive ≥3 compaction rounds; pointer lines never disappear", () => {
	const round1 = assembleLedger({
		region: { entries: [userEntry("u1", "必须保持 pnpm，不要用 npm"), userEntry("u2", "看一下 README")] },
		providers: {},
		settings: settings(),
	});
	assert.match(round1.block, /必须保持 pnpm/);
	const round2 = assembleLedger({
		region: { entries: [userEntry("u3", "继续修 bug")] },
		providers: { previousSummary: `narrative\n${round1.block}\nmore narrative` },
		settings: settings(),
	});
	assert.match(round2.block, /必须保持 pnpm/); // standing survives round 2
	const round3 = assembleLedger({
		region: { entries: [userEntry("u4", "跑一下测试")] },
		providers: { previousSummary: `n${round2.block}` },
		settings: settings(),
	});
	assert.match(round3.block, /必须保持 pnpm/); // …and round 3
	// Corrupt/unknown block → silently dropped, no directives carried.
	const dropped = parseCarriedDirectives("<cc-core-ledger v=\"99\">…</cc-core-ledger>");
	assert.deepEqual(dropped.directives, []);
});

test("LED-03: goal section reuses the goal module's formatter (focused + other open + terminal)", () => {
	const goal = (id: string, status: GoalRecord["status"]): GoalRecord =>
		Object.assign(createGoal({ objective: `=== Goal ===\nObjective: goal ${id}`, autoContinue: true, sisyphus: false }, Date.UTC(2026, 10, 9)), { id, status });
	const g1 = goal("g1", "active");
	const g2 = goal("g2", "paused");
	const g3 = goal("g3", "complete");
	const events: GoalLedgerEvent[] = [
		{ type: "goal_created", goalId: "g1", objective: "o", sisyphus: false, autoContinue: true, at: "2026-11-09T10:00:00Z" },
		{ type: "goal_completed", goalId: "g3", at: "2026-11-09T10:00:01Z" },
	];
	const state: GoalLedgerState = {
		goalsById: new Map([["g1", g1], ["g2", g2], ["g3", g3]]),
		focusedGoalId: "g1",
		ledgerEvents: events,
	};
	const section = goalSection(state);
	assert.deepEqual(section.identities.map((i) => i.id).sort(), ["g1", "g2"]); // Tier A: open only
	assert.deepEqual(section.closedIds, ["g3"]);
	assert.ok(section.openLines.some((line) => line.includes("FOCUSED GOAL")));
	assert.ok(section.openLines.some((line) => line.includes("OTHER OPEN GOALS")));
});

test("LED-04: verification scan — test verdict + commit subject", () => {
	const region: CompressedRegionView = {
		entries: [
			assistantEntry("a1", [{ name: "bash", arguments: { command: "pnpm run test" } }]),
			toolResultEntry("t1", "ℹ pass 39\nexit code: 0"),
			assistantEntry("a2", [{ name: "bash", arguments: { command: 'git commit -m "fix: ledger degradation"' } }]),
			toolResultEntry("t2", "[main abc1234] fix: ledger degradation"),
		],
	};
	const verification = scanVerification(region);
	assert.equal(verification.lastTest?.command, "pnpm run test");
	assert.equal(verification.lastTest?.result, "pass");
	assert.equal(verification.lastCommit?.subject, "fix: ledger degradation");
});

test("LED-04: background one-liners + identities", () => {
	const items: BgItem[] = [
		{ id: "bg-3", kind: "bg", status: "running", label: "pnpm run dev", timeoutMs: 7_200_000 },
		{ id: "watch-1", kind: "flow-watch", status: "listening", label: "r7/t1" },
	];
	const section = bgSection(items);
	assert.equal(section.lines.length, 2);
	assert.match(section.lines[0], /bg-3 \[bg\] running/);
	assert.deepEqual(section.identities.map((i) => i.id), ["bg-3", "watch-1"]);
});

test("LED-06: narrative header variants", () => {
	assert.match(narrativeHeader(true), /以台账为准/);
	assert.match(narrativeHeader(false), /可能不全/);
});

test("LED-07: a throwing provider degrades to unavailable; others intact", () => {
	const result = assembleLedger({
		region: { entries: [userEntry("u1", "必须跑测试")] },
		providers: {
			goal: () => {
				throw new Error("goal state exploded");
			},
			bg: () => [{ id: "bg-9", kind: "bg", status: "running", label: "x" }],
		},
		settings: settings(),
	});
	assert.doesNotThrow(() => JSON.stringify(result));
	assert.ok(result.block.includes("bg-9"));
	assert.ok(result.selfCheck.ok, result.selfCheck.missing.join(","));
});

test("LED-08 + LED-01: self-check passes; degradation ladder keeps Tier A id+status within maxOpenItems and INV-8 holds", () => {
	const goal = (id: string): GoalRecord =>
		Object.assign(createGoal({ objective: `=== Goal ===\nObjective: goal ${id}`, autoContinue: true, sisyphus: false }, 0), { id });
	const goals = new Map(Array.from({ length: 8 }, (_, i) => [`g${i}`, goal(`g${i}`)]));
	const region: CompressedRegionView = {
		entries: [
			...Array.from({ length: 30 }, (_, i) => userEntry(`u${i}`, `normal directive number ${i} with some padding text to eat budget ${"x".repeat(80)}`)),
			userEntry("u-standing", "必须始终先运行测试"),
		],
	};
	const result = assembleLedger({
		region,
		providers: {
			goal: () => ({ goalsById: goals, focusedGoalId: "g0", ledgerEvents: [] }),
			bg: () => [{ id: "bg-1", kind: "bg", status: "running", label: "dev server" }],
		},
		settings: settings({ directivesMax: 800 }),
	});
	assert.ok(result.selfCheck.ok, `missing: ${result.selfCheck.missing.slice(0, 5).join(",")}`);
	for (const id of ["g0", "g7", "bg-1"]) assert.ok(result.block.includes(id), `${id} must survive the ladder`);
	assert.ok(result.block.includes("running")); // rendered status (statusLabel) survives
	assert.ok(result.block.length <= COMPACTION_LEDGER_MAX, `INV-8: ${result.block.length} > ${COMPACTION_LEDGER_MAX}`);
	assert.ok(result.degradation.directivesCollapsed + result.degradation.directivesPointerOnly > 0);

	// maxOpenItems overflow → external pointer (⑥) + telemetry count.
	const manyGoals = new Map(Array.from({ length: 70 }, (_, i) => [`g${i}`, goal(`g${i}`)]));
	const overflow = assembleLedger({
		region: { entries: [] },
		providers: { goal: () => ({ goalsById: manyGoals, focusedGoalId: "g0", ledgerEvents: [] }) },
		settings: settings({ maxOpenItems: 60 }),
	});
	assert.ok(overflow.block.includes("+10 more open items"));
	assert.equal(overflow.degradation.openOverflow, 10);
});

test("LED-08: a directive folded past recognition fails the self-check (no verbatim, no pointer)", () => {
	// An entry with an EMPTY id folded by the budget ladder has neither a
	// verbatim line nor a `[#entryId @time]` pointer — exactly the bug class
	// the self-check exists to catch (do-not-propose signal).
	const longText = `${"必须".repeat(2)} always run the tests before committing ${"padding ".repeat(60)}`;
	const result = assembleLedger({
		region: { entries: [userEntry("", longText)] }, // empty entryId → pointer impossible
		providers: {},
		settings: settings({ directivesMax: 1 }), // force folding
	});
	assert.equal(result.selfCheck.ok, false);
	assert.ok(result.selfCheck.missing.some((m) => m.startsWith("tierB:")), result.selfCheck.missing.join(","));
});

test("files: renderFileActivity caps lists and counts overflow", () => {
	const activity = {
		modifiedFiles: ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts", "f.ts", "g.ts", "h.ts"],
		readFiles: ["r1.ts"],
	};
	const rendered = renderFileActivity(activity, 6);
	assert.equal(rendered.lines.filter((l) => l.startsWith("modified:")).length, 6);
	assert.equal(rendered.overflow, 2 + 0);
});
