/**
 * goal-lifecycle.test.ts — SPEC 2026-10-07 P2-2 §4.4: the verb transition
 * table against RECORDING ports (no FakeHost — the module owns state and
 * calls ports only). Each verb's effect sequence is pinned; the end-to-end
 * behavior stays pinned by the existing goal suites (statemachine/pool/core
 * …), which must pass UNCHANGED through the migration.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createGoalLifecycle, type GoalLifecyclePorts } from "../goal-lifecycle.ts";
import type { GoalRecord } from "../goal-record.ts";
import { createGoal } from "../goal-record.ts";

function recordingPorts() {
	const calls: string[] = [];
	const ports: GoalLifecyclePorts = {
		haltContinuation: () => calls.push("halt"),
		pauseClock: () => calls.push("pause-clock"),
		forgetCarry: (id) => calls.push(`forget:${id}`),
		resetNudge: (id) => calls.push(`nudge:${id ?? "-"}`),
		releaseStaleTweakGate: (id) => calls.push(`gate:${id ?? "-"}`),
		appendFocusEntry: (id, reason) => calls.push(`entry:${id ?? "-"}:${reason}`),
		appendLedger: (_ctx, event) => calls.push(`ledger:${(event as { type: string }).type}`),
		persist: () => calls.push("persist"),
		syncTools: () => calls.push("sync"),
		updateUI: () => calls.push("ui"),
		nowIso: () => "2026-10-08T00:00:00.000Z",
	};
	return { ports, calls };
}

function goal(idSeed: string, opts: { status?: "active" | "paused" | "complete"; autoContinue?: boolean } = {}): GoalRecord {
	const g = createGoal({ objective: `=== Goal ===\nObjective: ${idSeed}`, autoContinue: opts.autoContinue ?? true, sisyphus: false }, Date.UTC(2026, 9, 8));
	return { ...g, status: opts.status ?? "active" } as GoalRecord;
}

const ctx = { cwd: "/w" };

test("setGoal A -> B (focus change): full effect order, focus entry only with reason", () => {
	const { ports, calls } = recordingPorts();
	const lc = createGoalLifecycle(ports);
	const a = goal("a");
	const b = goal("b");
	lc.adopt(a);
	calls.length = 0;
	const report = lc.setGoal(b, ctx, { focusReason: "created" });
	assert.equal(lc.focusedId, b.id);
	assert.equal(report.previousGoalId, a.id);
	assert.equal(report.nextGoalId, b.id);
	assert.deepEqual(calls, [
		"halt", "pause-clock", `nudge:${a.id}`, `nudge:${b.id}`,
		`entry:${b.id}:created`,
		`gate:${b.id}`,
		"persist", "ui",
	]);
});

test("setGoal to null (cleared): carry forgotten; sync path when persist=false", () => {
	const { ports, calls } = recordingPorts();
	const lc = createGoalLifecycle(ports);
	const a = goal("a");
	lc.adopt(a);
	calls.length = 0;
	lc.setGoal(null, ctx);
	// next=null: the focus-change block AND the inactive/paused conditions
	// BOTH fire (the old code called the same clears twice — idempotent).
	assert.deepEqual(calls, [
		"halt", "pause-clock", `nudge:${a.id}`, "nudge:-",
		"halt", "pause-clock",
		`forget:${a.id}`,
		"gate:-",
		"persist", "ui",
	]);
	calls.length = 0;
	lc.setGoal(goal("c"), ctx, { persist: false });
	assert.ok(calls.includes("sync"), "no-persist branch calls syncTools");
	assert.ok(!calls.includes("persist"));
});

test("setGoal to a COMPLETED goal forgets the carry; paused keeps it", () => {
	const done = recordingPorts();
	const lcDone = createGoalLifecycle(done.ports);
	const doneSrc = goal("done-src");
	lcDone.adopt(doneSrc);
	done.calls.length = 0;
	lcDone.setGoal(goal("done", { status: "complete" }), ctx);
	assert.ok(done.calls.includes(`forget:${doneSrc.id}`), "completed next forgets the previous carry");

	const paused = recordingPorts();
	const lcPaused = createGoalLifecycle(paused.ports);
	const pSrc = goal("p-src");
	lcPaused.adopt(pSrc);
	paused.calls.length = 0;
	lcPaused.setGoal(goal("p", { status: "paused" }), ctx);
	assert.ok(!paused.calls.includes(`forget:${pSrc.id}`), "paused next KEEPS the carry");
	// two pause-clock port calls: focus-change block + the paused-condition
	assert.equal(paused.calls.filter((c) => c === "pause-clock").length, 2);
});

test("setGoal same goal, status active->active with autoContinue: no focus-change effects", () => {
	const { ports, calls } = recordingPorts();
	const lc = createGoalLifecycle(ports);
	const a = goal("same");
	lc.adopt(a);
	calls.length = 0;
	lc.setGoal({ ...a, usage: { ...a.usage, tokensUsed: 5 } }, ctx);
	// same id: no halt/pause/nudge/gate/entry; active+autoContinue: no extra halt
	assert.deepEqual(calls.filter((c) => c.startsWith("halt") || c.startsWith("nudge") || c.startsWith("gate") || c.startsWith("entry")), []);
	assert.deepEqual(calls, ["persist", "ui"]);
});

test("focus: valid id focuses with ledger; invalid id unfocuses silently-ish; no change -> no halt", () => {
	const { ports, calls } = recordingPorts();
	const lc = createGoalLifecycle(ports);
	const a = goal("fa");
	const b = goal("fb");
	lc.adopt(a);
	lc.setFocusedSilently(null);
	calls.length = 0;
	lc.focus(a.id, ctx, "selected");
	assert.equal(lc.focusedId, a.id);
	assert.deepEqual(calls, [
		"halt", "pause-clock", `nudge:-`, `nudge:${a.id}`, `gate:${a.id}`,
		`entry:${a.id}:selected`, "ledger:goal_focused", "sync", "ui",
	]);
	calls.length = 0;
	lc.focus("no-such-id", ctx, "cleared");
	assert.equal(lc.focusedId, null);
	assert.ok(calls.includes("ledger:goal_unfocused"));
	calls.length = 0;
	lc.focus(null, ctx, "selected");
	// already unfocused, no previous -> no ledger, but entry/sync/ui still run
	assert.deepEqual(calls, ["entry:-:selected", "sync", "ui"]);
});

test("silent primitives move data without verb effects", () => {
	const { ports, calls } = recordingPorts();
	const lc = createGoalLifecycle(ports);
	const a = goal("sa");
	const fresh = new Map([[a.id, a]]);
	lc.replacePool(fresh);
	lc.setFocusedSilently(a.id);
	lc.setFocusedSilently("missing");
	assert.equal(lc.focusedId, null, "setFocusedSilently validates pool membership");
	lc.setFocusedSilently(a.id);
	lc.removeFromPool(a.id);
	assert.equal(lc.focusedId, null, "removeFromPool drops a dangling focus");
	assert.deepEqual(calls, []);
});
