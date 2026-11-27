import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createGoalAccounting } from "../goal-accounting.ts";
import goalExtension from "../goal.ts";
import { writeActiveGoalFile, readActiveGoalFiles } from "../storage/goal-files.ts";
import { createGoal } from "../goal-record.ts";
import { FakeHost } from "../../../test/contracts/fake-host.ts";
import { resetCoreBusForTests } from "../../bus.ts";

function fixedClock(startMs = 0) {
	let t = startMs;
	return { now: () => t, advance: (ms: number) => (t += ms) };
}

test("GO-T01: 8 × 250 ms settles record 2 s; one more second records 3 s", () => {
	const clk = fixedClock();
	const c = createGoalAccounting({ now: clk.now });
	c.begin("g1");
	let total = 0;
	for (let i = 0; i < 8; i++) {
		clk.advance(250);
		total += c.settle("g1") ?? 0;
	}
	assert.equal(total, 2);
	clk.advance(1000);
	total += c.settle("g1") ?? 0;
	assert.equal(total, 3);
});

test("GO-T02: identical active time yields identical seconds across event frequencies", () => {
	const a = fixedClock();
	const ca = createGoalAccounting({ now: a.now });
	ca.begin("g");
	let sa = 0;
	for (let i = 0; i < 40; i++) {
		a.advance(100);
		sa += ca.settle("g") ?? 0;
	}
	const b = fixedClock();
	const cb = createGoalAccounting({ now: b.now });
	cb.begin("g");
	let sb = 0;
	b.advance(4000);
	sb += cb.settle("g") ?? 0;
	assert.equal(sa, 4);
	assert.equal(sb, 4);
});

test("GO-T03: a zero settle keeps the carry — fragments are never reset", () => {
	const clk = fixedClock();
	const c = createGoalAccounting({ now: clk.now });
	c.begin("g");
	clk.advance(700);
	assert.equal(c.settle("g"), 0);
	clk.advance(700);
	assert.equal(c.settle("g"), 1);
	clk.advance(600);
	assert.equal(c.settle("g"), 1);
	clk.advance(200);
	assert.equal(c.settle("g"), 0);
});

test("GO-T04: pause/resume and focus A/B keep per-goal fragments; completion releases them; paused time does not count", () => {
	const clk = fixedClock();
	const c = createGoalAccounting({ now: clk.now });
	c.begin("A");
	clk.advance(700);
	c.settle("A");
	c.pause();
	clk.advance(5000);
	c.begin("B");
	clk.advance(300);
	c.settle("B");
	c.pause();
	c.begin("A");
	clk.advance(300);
	assert.equal(c.settle("A"), 1);
	c.pause();
	c.begin("B");
	assert.equal(c.settle("B"), 0);
	clk.advance(700);
	assert.equal(c.settle("B"), 1);
	c.forget("A");
	c.begin("A");
	clk.advance(999);
	assert.equal(c.settle("A"), 0);
});

test("GO-T05: preview consumes nothing; repeated previews never accumulate; begin resets the segment but not the carry", () => {
	const clk = fixedClock();
	const c = createGoalAccounting({ now: clk.now });
	c.begin("g");
	clk.advance(1500);
	assert.equal(c.preview("g"), 1);
	assert.equal(c.preview("g"), 1);
	assert.equal(c.preview("g"), 1);
	assert.equal(c.settle("g"), 1);
	clk.advance(100);
	c.begin("g");
	clk.advance(400);
	assert.equal(c.preview("g"), 0);
	assert.equal(c.settle("g"), 0);
	clk.advance(200);
	assert.equal(c.settle("g"), 1);
});

test("GO-T06 (clock): no record fields are touched — the clock owns no persistence", () => {
	const c = createGoalAccounting({ now: () => 0 });
	c.begin("g");
	c.settle("g");
	c.pause();
	c.forget("g");
	assert.ok(true);
});


function setupWiring() {
	resetCoreBusForTests();
	const cwd = mkdtempSync(path.join(tmpdir(), "pi-goal-clock-"));
	const clk = fixedClock(1_000_000);
	const host = new FakeHost();
	goalExtension(host.asPi(), { now: clk.now });
	const ctx = host.makeCtx({ cwd, ui: false, sessionEntries: [] });
	writeActiveGoalFile({ cwd }, createGoal({ objective: "=== Goal ===\nObjective: ship the clock", autoContinue: false, sisyphus: false }, Date.UTC(2026, 9, 5)));
	return { cwd, host, ctx, clk, cleanup: () => rmSync(cwd, { recursive: true, force: true }) };
}

test("GO-T01 (wiring): 8 × 250 ms tool_execution_end events record 2 s (agent_end flush); +1 s → 3 s", async () => {
	const f = setupWiring();
	try {
		await f.host.fire("session_start", { reason: "new" }, f.ctx);
		await f.host.fire("before_agent_start", { messageType: "user", systemPrompt: "BASE", prompt: "work on the goal" }, f.ctx);
		for (let i = 0; i < 8; i++) {
			f.clk.advance(250);
			await f.host.fire("tool_execution_end", { type: "tool_execution_end", toolCallId: `t${i}` }, f.ctx);
		}
		await f.host.fire("agent_end", { messages: [] }, f.ctx);
		let rec = readActiveGoalFiles({ cwd: f.cwd })[0]!;
		assert.equal(rec.usage.activeSeconds, 2, "8 × 250 ms must record 2 s (baseline recorded 0)");
		f.clk.advance(1000);
		await f.host.fire("tool_execution_end", { type: "tool_execution_end", toolCallId: "t9" }, f.ctx);
		await f.host.fire("agent_end", { messages: [] }, f.ctx);
		rec = readActiveGoalFiles({ cwd: f.cwd })[0]!;
		assert.equal(rec.usage.activeSeconds, 3, "one more second records 3 s (baseline recorded 1)");
	} finally {
		f.cleanup();
	}
});

test("GO-T07 (wiring): a paused goal's disk edits are observed by the next run boundary (external-state check intact)", async () => {
	const f = setupWiring();
	try {
		await f.host.fire("session_start", { reason: "new" }, f.ctx);
		await f.host.fire("before_agent_start", { messageType: "user", systemPrompt: "BASE", prompt: "work" }, f.ctx);
		f.clk.advance(1200);
		await f.host.fire("tool_execution_end", { type: "tool_execution_end", toolCallId: "t0" }, f.ctx);
		await f.host.fire("agent_end", { messages: [] }, f.ctx);
		let rec = readActiveGoalFiles({ cwd: f.cwd })[0]!;
		assert.equal(rec.usage.activeSeconds, 1);
		rmSync(path.join(f.cwd, rec.activePath ?? ".pi/goals/active-goal.json"));
		await f.host.fire("agent_end", { messages: [] }, f.ctx);
		assert.equal(readActiveGoalFiles({ cwd: f.cwd }).length, 0);
	} finally {
		f.cleanup();
	}
});

import * as fs from "node:fs";
import { _parseGoalFileCountForTests, _resetParseGoalFileCountForTests } from "../storage/goal-files.ts";

test("GO-T09 (BH-E1): a usage event parses ZERO files; the run-boundary flush parses the pool once and sees external edits", async () => {
	resetCoreBusForTests();
	const cwd = mkdtempSync(path.join(tmpdir(), "pi-goal-gob-"));
	const clk = fixedClock(2_000_000);
	const host = new FakeHost();
	goalExtension(host.asPi(), { now: clk.now });
	const focused = writeActiveGoalFile({ cwd }, createGoal({ objective: "=== Goal ===\nObjective: original objective", autoContinue: false, sisyphus: false }, Date.UTC(2026, 9, 5)));
	const ctx = host.makeCtx({ cwd, ui: false, sessionEntries: [{ type: "custom", customType: "pi-goal-focus", data: { version: 1, focusedGoalId: focused.id } }] });
	writeActiveGoalFile({ cwd }, createGoal({ objective: "=== Goal ===\nObjective: another goal", autoContinue: false, sisyphus: false }, Date.UTC(2026, 9, 5)));
	writeActiveGoalFile({ cwd }, createGoal({ objective: "=== Goal ===\nObjective: third goal", autoContinue: false, sisyphus: false }, Date.UTC(2026, 9, 5)));
	try {
		await host.fire("session_start", { reason: "new" }, ctx);
		await host.fire("before_agent_start", { messageType: "user", systemPrompt: "BASE", prompt: "work" }, ctx);
		const focusedAbs = path.join(cwd, focused.activePath ?? "");

		void focusedAbs;
		_resetParseGoalFileCountForTests();
		clk.advance(1500);
		await host.fire("tool_execution_end", { type: "tool_execution_end", toolCallId: "g1" }, ctx);
		assert.equal(_parseGoalFileCountForTests(), 0, `usage event parse count: ${_parseGoalFileCountForTests()}`);
		_resetParseGoalFileCountForTests();
		await host.fire("agent_end", { messages: [] }, ctx);
		assert.equal(_parseGoalFileCountForTests(), 3, `flush parse count: ${_parseGoalFileCountForTests()}`);
		const byId = () => readActiveGoalFiles({ cwd }).find((r) => r.id === focused.id)!;
		assert.equal(byId().usage.activeSeconds, 1);

		const content = fs.readFileSync(focusedAbs, "utf8") as string;
		fs.writeFileSync(focusedAbs, content.replaceAll("original objective", "externally edited objective"));
		clk.advance(1200);
		await host.fire("tool_execution_end", { type: "tool_execution_end", toolCallId: "g2" }, ctx);
		await host.fire("agent_end", { messages: [] }, ctx);
		assert.match(byId().objective, /externally edited objective/);
		assert.equal(byId().usage.activeSeconds, 2);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});
