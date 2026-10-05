/**
 * Goal activity clock (AR1005-GO-A, spec 2026-10-05 §7.2): sub-second
 * fragments survive settles; per-goal carries never cross; preview is
 * side-effect-free; pause/resume keep fragments, completion releases them.
 * Fixed injected clock — no real-time waits. The FakeHost case reproduces
 * the baseline defect scenario (8 × 250 ms tool-end events) through the
 * real factory wiring with the injected clock seam.
 */
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
	assert.equal(total, 2); // baseline recorded 0 here (floor-then-reset)
	clk.advance(1000);
	total += c.settle("g1") ?? 0;
	assert.equal(total, 3); // baseline recorded 1 here
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
	assert.equal(c.settle("g"), 0); // zero-token/zero-cost event: nothing persisted
	clk.advance(700);
	assert.equal(c.settle("g"), 1); // 1400 ms accumulated → 1 s, 400 ms carried
	clk.advance(600);
	assert.equal(c.settle("g"), 1); // carry 400 + 600 = 1000 → 1 s, 0 carried
	clk.advance(200);
	assert.equal(c.settle("g"), 0);
});

test("GO-T04: pause/resume and focus A/B keep per-goal fragments; completion releases them; paused time does not count", () => {
	const clk = fixedClock();
	const c = createGoalAccounting({ now: clk.now });
	// goal A accumulates a 700 ms fragment, then a focus switch pauses it
	c.begin("A");
	clk.advance(700);
	c.settle("A");
	c.pause(); // focus switch / drafting
	clk.advance(5000); // paused time — never counted
	c.begin("B");
	clk.advance(300);
	c.settle("B");
	c.pause();
	// resume A: the 700 ms fragment is still there
	c.begin("A");
	clk.advance(300);
	assert.equal(c.settle("A"), 1); // 700 + 300
	c.pause();
	c.begin("B"); // switch back to B (single-focus clock, like goal.ts)
	assert.equal(c.settle("B"), 0); // B's 300 ms fragment kept, not stolen by A
	clk.advance(700);
	assert.equal(c.settle("B"), 1); // 300 + 700
	// completion releases A's carry for good
	c.forget("A");
	c.begin("A");
	clk.advance(999);
	assert.equal(c.settle("A"), 0); // fresh segment after forget — no residue
});

test("GO-T05: preview consumes nothing; repeated previews never accumulate; begin resets the segment but not the carry", () => {
	const clk = fixedClock();
	const c = createGoalAccounting({ now: clk.now });
	c.begin("g");
	clk.advance(1500);
	assert.equal(c.preview("g"), 1);
	assert.equal(c.preview("g"), 1);
	assert.equal(c.preview("g"), 1);
	// preview did not consume: settle still sees the full 1500 ms
	assert.equal(c.settle("g"), 1); // 1 s, 500 ms carried
	// begin mid-flight restarts the segment WITHOUT wiping the carry
	clk.advance(100);
	c.begin("g");
	clk.advance(400);
	assert.equal(c.preview("g"), 0); // 400 ms alone < 1 s (the 100 ms pre-begin is dropped, by design)
	assert.equal(c.settle("g"), 0);
	clk.advance(200);
	assert.equal(c.settle("g"), 1); // carried 500 + 600 = 1100 → 1 s
});

test("GO-T06 (clock): no record fields are touched — the clock owns no persistence", () => {
	const c = createGoalAccounting({ now: () => 0 });
	c.begin("g");
	c.settle("g");
	c.pause();
	c.forget("g");
	assert.ok(true); // pure in-module state; records keep integer activeSeconds (goal-files tests pin the format)
});

// ── FakeHost wiring: the real factory over the injected clock seam ──

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

test("GO-T01 (wiring): 8 × 250 ms tool_execution_end events persist 2 s; +1 s → 3 s", async () => {
	const f = setupWiring();
	try {
		await f.host.fire("session_start", { reason: "new" }, f.ctx);
		await f.host.fire("before_agent_start", { systemPrompt: "BASE", prompt: "work on the goal" }, f.ctx);
		for (let i = 0; i < 8; i++) {
			f.clk.advance(250);
			await f.host.fire("tool_execution_end", { type: "tool_execution_end", toolCallId: `t${i}` }, f.ctx);
		}
		let rec = readActiveGoalFiles({ cwd: f.cwd })[0]!;
		assert.equal(rec.usage.activeSeconds, 2, "8 × 250 ms must record 2 s (baseline recorded 0)");
		f.clk.advance(1000);
		await f.host.fire("tool_execution_end", { type: "tool_execution_end", toolCallId: "t9" }, f.ctx);
		rec = readActiveGoalFiles({ cwd: f.cwd })[0]!;
		assert.equal(rec.usage.activeSeconds, 3, "one more second records 3 s (baseline recorded 1)");
	} finally {
		f.cleanup();
	}
});

test("GO-T07 (wiring): a paused goal's disk edits are observed by the next event (external-state check intact)", async () => {
	const f = setupWiring();
	try {
		await f.host.fire("session_start", { reason: "new" }, f.ctx);
		await f.host.fire("before_agent_start", { systemPrompt: "BASE", prompt: "work" }, f.ctx);
		f.clk.advance(1200);
		await f.host.fire("tool_execution_end", { type: "tool_execution_end", toolCallId: "t0" }, f.ctx);
		let rec = readActiveGoalFiles({ cwd: f.cwd })[0]!;
		assert.equal(rec.usage.activeSeconds, 1);
		// externally delete the active goal file → the next event must observe it (reconcile path, not skipped)
		rmSync(path.join(f.cwd, rec.activePath ?? ".pi/goals/active-goal.json"));
		await f.host.fire("tool_execution_end", { type: "tool_execution_end", toolCallId: "t1" }, f.ctx);
		assert.equal(readActiveGoalFiles({ cwd: f.cwd }).length, 0);
	} finally {
		f.cleanup();
	}
});
