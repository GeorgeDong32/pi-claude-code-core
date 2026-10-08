/**
 * goal-lifecycle.test.ts — SPEC 2026-10-07 P2-2 §4.4: the verb transition
 * table against RECORDING ports (no FakeHost — the module owns state and
 * calls ports only). Each verb's effect sequence is pinned; the end-to-end
 * behavior stays pinned by the existing goal suites (statemachine/pool/core
 * …), which must pass UNCHANGED through the migration.
 *
 * Step 3: the drafting intents / turn flags / get_goal nudge counters are
 * event-owned — the resetNudge and releaseStaleTweakGate ports are gone
 * (internalized), so their traces moved from port calls to state
 * assertions (getGoalNudgeCount / tweakDraftingFor) and one interface
 * test per event tag.
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
		appendFocusEntry: (id, reason) => calls.push(`entry:${id ?? "-"}:${reason}`),
		appendLedger: (_ctx, event) => calls.push(`ledger:${(event as { type: string }).type}`),
		persist: () => calls.push("persist"),
		syncTools: () => calls.push("sync"),
		updateUI: () => calls.push("ui"),
		nowIso: () => "2026-10-08T00:00:00.000Z",
		mergeGoalPromptFromDisk: (_ctx, goal) => goal,
		archiveGoal: (_ctx, goal) => {
			calls.push("archive");
			return { ...goal, archivedPath: `.pi/goals/archive/${goal.id}.md` };
		},
		readActiveGoalPool: () => diskPool,
		beginClock: () => calls.push("begin-clock"),
	};
	let diskPool = new Map<string, GoalRecord>();
	const setDisk = (m: Map<string, GoalRecord>) => {
		diskPool = m;
	};
	return { ports, calls, setDisk };
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
		"halt", "pause-clock",
		`entry:${b.id}:created`,
		"persist", "ui",
	]);
	// Step 3: nudge resets + stale-gate release are internal now — pinned
	// through the report's effect strings and the state projections.
	assert.ok(report.effects.includes(`nudge-reset:${a.id}`));
	assert.ok(report.effects.includes("release-stale-tweak-gate"));
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
		"halt", "pause-clock",
		"halt", "pause-clock",
		`forget:${a.id}`,
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
		"halt", "pause-clock",
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

// ---------- P2-2 Step 2: complete / terminate ----------

test("complete: the update_goal approved-verdict effect order (same-id terminal)", () => {
	const { ports, calls } = recordingPorts();
	const lc = createGoalLifecycle(ports);
	const a = goal("cmp");
	lc.adopt(a);
	calls.length = 0;
	const report = lc.complete(a, ctx);
	assert.equal(report.kind, "complete");
	assert.equal(report.previousGoalId, a.id);
	assert.equal(report.nextGoalId, null);
	assert.ok(report.record, "report carries the terminal record for display");
	assert.equal(report.record!.status, "complete");
	assert.equal(report.record!.stopReason, "agent");
	// setGoal leg (no focus change): halt + pause via the complete-status
	// conditions, carry forgotten, persist(=archive in the adapter), ui;
	// then the inline-block tail: nudge, pool removal, focus entry, sync,
	// ui, ledger.
	assert.deepEqual(calls, [
		"halt", "pause-clock", `forget:${a.id}`, "persist", "ui",
		`entry:-:completed`, "sync", "ui", "ledger:goal_completed",
	]);
	assert.equal(lc.focusedId, null, "the completed goal leaves the pool");
	assert.equal(lc.pool.has(a.id), false);
	calls.length = 0;
	// A second complete with nothing focused: still a no-crash no-op shape
	// (setGoal(null-destined) leg only). Guarded by the adapter's gate.
	const bare = lc.complete(goal("bare"), ctx);
	assert.equal(bare.previousGoalId, null);
	assert.ok(calls.includes("ledger:goal_completed"));
});

test("terminate clear (user): archive → ledger(user cleared) → nudge → setGoal(null) effects", () => {
	const events: Array<Record<string, unknown>> = [];
	const { ports, calls } = recordingPorts();
	ports.appendLedger = (_ctx, event) => {
		events.push(event);
		calls.push(`ledger:${(event as { type: string }).type}`);
	};
	const lc = createGoalLifecycle(ports);
	const a = goal("tc");
	lc.adopt(a);
	calls.length = 0;
	const report = lc.terminate("clear", ctx, { note: "done with it" });
	assert.equal(report.kind, "terminate");
	assert.equal(report.previousGoalId, a.id);
	assert.ok(report.record, "archived record rides the report");
	assert.equal(report.record!.status, "paused", "user clear archives non-complete as paused");
	assert.equal(report.record!.stopReason, "user");
	assert.equal(events[0]?.type, "goal_aborted");
	assert.equal(events[0]?.reason, "user cleared: done with it", "old appendUserTerminationEvent wording preserved");
	assert.deepEqual(calls, [
		"archive", "ledger:goal_aborted",
		"halt", "pause-clock",
		"entry:-:cleared",
		"halt", "pause-clock", `forget:${a.id}`,
		"persist", "ui",
	]);
	assert.equal(lc.focusedId, null);
});

test("terminate abort (agent): aborted record built, raw reason ledger, focus reason aborted", () => {
	const events: Array<Record<string, unknown>> = [];
	const { ports, calls } = recordingPorts();
	ports.appendLedger = (_ctx, event) => {
		events.push(event);
		calls.push(`ledger:${(event as { type: string }).type}`);
	};
	const lc = createGoalLifecycle(ports);
	const a = goal("ta");
	lc.adopt(a);
	calls.length = 0;
	const report = lc.terminate("abort", ctx, { by: "agent", reason: "objective obsolete" });
	assert.ok(report.record);
	assert.equal(report.record!.pauseReason, "Aborted: objective obsolete");
	assert.equal(report.record!.stopReason, "agent");
	assert.equal(report.record!.autoContinue, false);
	assert.equal(events[0]?.reason, "objective obsolete", "agent ledger keeps the raw reason");
	assert.ok(calls.includes("archive"));
	assert.ok(calls.includes("ledger:goal_aborted"));
});

test("terminate with nothing focused: ledger still records, no archive/nudge", () => {
	const events: Array<Record<string, unknown>> = [];
	const { ports, calls } = recordingPorts();
	ports.appendLedger = (_ctx, event) => {
		events.push(event);
		calls.push(`ledger:${(event as { type: string }).type}`);
	};
	const lc = createGoalLifecycle(ports);
	const report = lc.terminate("clear", ctx);
	assert.equal(report.record, undefined);
	assert.equal(events[0]?.goalId, "unknown");
	assert.deepEqual(calls, ["ledger:goal_aborted", "halt", "pause-clock", "persist", "ui"]);
});


// ---------- P2-2 Step 3: the closed event entry (one interface test per tag) ----------

function eventLifecycle() {
	const { ports, calls } = recordingPorts();
	return { lc: createGoalLifecycle(ports), calls };
}

test("event restore: clears the per-turn flags; drafting + nudge survive (as today)", () => {
	const { lc } = eventLifecycle();
	const a = goal("rv");
	lc.adopt(a);
	lc.handle({ tag: "tool-call", toolName: "get_goal", input: {} }); // count BEFORE drafting starts
	lc.handle({ tag: "draft-start", kind: "goal", focus: "goal", topic: "t", startedAt: 1 });
	lc.handle({ tag: "turn-stopped", goalId: a.id });
	lc.handle({ tag: "restore" });
	assert.equal(lc.turnStoppedFor, null);
	assert.equal(lc.goalWorkToolCalledThisTurn, false);
	assert.equal(lc.confirmationIntent !== null, true, "drafting survives a restore");
	assert.equal(lc.getGoalNudgeCount(a.id), 1, "nudge counters survive a restore");
});

test("event turn-start: resets both per-turn flags", () => {
	const { lc } = eventLifecycle();
	lc.handle({ tag: "turn-stopped", goalId: "g1" });
	lc.handle({ tag: "turn-start" });
	assert.equal(lc.turnStoppedFor, null);
	assert.equal(lc.goalWorkToolCalledThisTurn, false);
});

test("event turn-stopped: pins the four-real-stop lock value (D3=A)", () => {
	const { lc } = eventLifecycle();
	lc.handle({ tag: "turn-stopped", goalId: "g9" });
	assert.equal(lc.turnStoppedFor, "g9");
	lc.handle({ tag: "turn-stopped", goalId: null });
	assert.equal(lc.turnStoppedFor, null);
});

test("event tool-call: post-stop block verdict, nudge counting, progress credit", () => {
	const { lc } = eventLifecycle();
	const a = goal("tk");
	lc.adopt(a);
	// post-stop block: only read-only inspection passes
	lc.handle({ tag: "turn-stopped", goalId: a.id });
	const blocked = lc.handle({ tag: "tool-call", toolName: "write", input: { path: "x" } });
	assert.equal(blocked && blocked.blocked, true);
	assert.ok(blocked!.reason!.includes(a.id));
	const allowed = lc.handle({ tag: "tool-call", toolName: "get_goal", input: {} });
	assert.equal(allowed && (allowed as { blocked?: boolean }).blocked, undefined);
	// get_goal nudge counting on an active, non-drafting goal — note the
	// post-stop get_goal above ALREADY counted (old behavior: the allowed
	// read-only inspection still passes the nudge-count block).
	lc.handle({ tag: "turn-start" });
	lc.handle({ tag: "tool-call", toolName: "get_goal", input: {} });
	lc.handle({ tag: "tool-call", toolName: "get_goal", input: {} });
	assert.equal(lc.getGoalNudgeCount(a.id), 3);
	// meaningful progress clears the counter and raises the work flag
	lc.handle({ tag: "tool-call", toolName: "edit", input: { path: "f.ts" } });
	assert.equal(lc.getGoalNudgeCount(a.id), 0);
	assert.equal(lc.goalWorkToolCalledThisTurn, true);
	// G3 exceptions: echo bash and .pi/goals reads are NOT progress
	lc.handle({ tag: "turn-start" });
	lc.handle({ tag: "tool-call", toolName: "bash", input: { command: "echo hi" } });
	lc.handle({ tag: "tool-call", toolName: "read", input: { path: ".pi/goals/active_goal_x.md" } });
	assert.equal(lc.goalWorkToolCalledThisTurn, false);
	// drafting suspends nudge counting
	lc.handle({ tag: "draft-start", kind: "goal", focus: "goal", topic: "t", startedAt: 1 });
	lc.handle({ tag: "tool-call", toolName: "get_goal", input: {} });
	assert.equal(lc.getGoalNudgeCount(a.id), 0);
});

test("event usage-accounted / agent-settled: routing pins — owned state untouched", () => {
	const { lc } = eventLifecycle();
	const a = goal("ua");
	lc.adopt(a);
	lc.handle({ tag: "draft-start", kind: "tweak", goalId: a.id });
	lc.handle({ tag: "turn-stopped", goalId: a.id });
	lc.handle({ tag: "tool-call", toolName: "get_goal", input: {} });
	const before = { tweak: lc.tweakDraftingFor, stopped: lc.turnStoppedFor, nudge: lc.getGoalNudgeCount(a.id), work: lc.goalWorkToolCalledThisTurn };
	lc.handle({ tag: "usage-accounted" });
	lc.handle({ tag: "agent-settled" });
	assert.deepEqual({ tweak: lc.tweakDraftingFor, stopped: lc.turnStoppedFor, nudge: lc.getGoalNudgeCount(a.id), work: lc.goalWorkToolCalledThisTurn }, before);
});

test("event draft-start/cancel/applied: both intents, kind-specific cancels", () => {
	const { lc } = eventLifecycle();
	lc.handle({ tag: "draft-start", kind: "goal", focus: "sisyphus", topic: "the plan", startedAt: 42 });
	assert.deepEqual(lc.confirmationIntent, { focus: "sisyphus", originalTopic: "the plan", startedAt: 42 });
	lc.handle({ tag: "draft-start", kind: "tweak", goalId: "g7" });
	assert.equal(lc.tweakDraftingFor, "g7");
	assert.equal(lc.isDrafting, true);
	// kind-specific cancel (CORE-05): only the goal intent clears
	lc.handle({ tag: "draft-cancel", kind: "goal" });
	assert.equal(lc.confirmationIntent, null);
	assert.equal(lc.tweakDraftingFor, "g7");
	// bare cancel clears both (the /goal-clear drafting branch)
	lc.handle({ tag: "draft-cancel" });
	assert.equal(lc.tweakDraftingFor, null);
	assert.equal(lc.isDrafting, false);
	// applied variants
	lc.handle({ tag: "draft-start", kind: "goal", focus: "goal", topic: "x", startedAt: 1 });
	lc.handle({ tag: "draft-applied", kind: "goal" });
	assert.equal(lc.confirmationIntent, null);
	lc.handle({ tag: "draft-start", kind: "tweak", goalId: "g8" });
	lc.handle({ tag: "draft-applied", kind: "tweak" });
	assert.equal(lc.tweakDraftingFor, null);
});

test("event nudge-reset: the adapter-side resets (pause/resume/create/tweak/user-turn)", () => {
	const { lc } = eventLifecycle();
	const a = goal("nr");
	lc.adopt(a);
	lc.handle({ tag: "tool-call", toolName: "get_goal", input: {} });
	lc.handle({ tag: "tool-call", toolName: "get_goal", input: {} });
	assert.equal(lc.getGoalNudgeCount(a.id), 2);
	lc.handle({ tag: "nudge-reset", goalId: a.id });
	assert.equal(lc.getGoalNudgeCount(a.id), 0);
	lc.handle({ tag: "nudge-reset", goalId: undefined });
	lc.handle({ tag: "nudge-reset", goalId: null });
});

test("event dispose: clears all event-owned state", () => {
	const { lc } = eventLifecycle();
	const a = goal("dp");
	lc.adopt(a);
	lc.handle({ tag: "draft-start", kind: "tweak", goalId: a.id });
	lc.handle({ tag: "turn-stopped", goalId: a.id });
	lc.handle({ tag: "tool-call", toolName: "get_goal", input: {} });
	lc.handle({ tag: "dispose" });
	assert.equal(lc.confirmationIntent, null);
	assert.equal(lc.tweakDraftingFor, null);
	assert.equal(lc.turnStoppedFor, null);
	assert.equal(lc.goalWorkToolCalledThisTurn, false);
	assert.equal(lc.getGoalNudgeCount(a.id), 0);
});

test("stale tweak gate: setGoal/focus release it internally (no write-back port)", () => {
	const { lc, calls } = eventLifecycle();
	const a = goal("sg-a");
	const b = goal("sg-b");
	lc.adopt(a);
	lc.handle({ tag: "draft-start", kind: "tweak", goalId: a.id });
	lc.setGoal(b, ctx); // focus moved to b: a's gate is stale
	assert.equal(lc.tweakDraftingFor, null);
	lc.handle({ tag: "draft-start", kind: "tweak", goalId: b.id });
	lc.setGoal({ ...b, usage: { ...b.usage, tokensUsed: 3 } }, ctx); // same id: gate kept
	assert.equal(lc.tweakDraftingFor, b.id);
	assert.equal(lc.focusedId, b.id);
	assert.ok(!calls.some((c) => c.startsWith("gate:")));
});

// ---------- P2-2 Step 4: create / pause / resume / unfocus / reconcileFromDisk ----------

test("create: setGoal leg + begin-clock + nudge + intent clear + ledger goal_created", () => {
	const { ports, calls } = recordingPorts();
	const lc = createGoalLifecycle(ports);
	lc.handle({ tag: "draft-start", kind: "goal", focus: "goal", topic: "pending", startedAt: 1 });
	calls.length = 0;
	const report = lc.create({ objective: "=== Goal ===\nObjective: new", autoContinue: true, sisyphus: false }, ctx);
	assert.equal(report.kind, "create");
	assert.equal(lc.focusedId, report.nextGoalId);
	assert.ok(lc.focused() !== null);
	assert.ok(calls.includes("begin-clock"));
	assert.ok(calls.includes("ledger:goal_created"));
	assert.equal(lc.confirmationIntent, null, "committed goal clears a pending intent");
	assert.equal(lc.getGoalNudgeCount(report.nextGoalId!), 0);
});

test("pause(user): merge → stamp paused/user → setGoal → ledger goal_paused", () => {
	const events: Array<Record<string, unknown>> = [];
	const { ports, calls } = recordingPorts();
	ports.appendLedger = (_ctx, event) => {
		events.push(event);
		calls.push(`ledger:${(event as { type: string }).type}`);
	};
	const lc = createGoalLifecycle(ports);
	const a = goal("pz");
	lc.adopt(a);
	calls.length = 0;
	const report = lc.pause({ ...a, autoContinue: false, pauseReason: "user: blocked" }, ctx, "user");
	assert.equal(report.kind, "pause");
	assert.equal(lc.focused()!.status, "paused");
	assert.equal(lc.focused()!.stopReason, "user");
	assert.equal(events[0]?.type, "goal_paused");
	assert.equal(events[0]?.reason, "user");
	assert.ok(calls.includes("persist"));
});

test("resume: stamp active + setGoal + begin-clock + nudge + ledger goal_resumed", () => {
	const { ports, calls } = recordingPorts();
	const lc = createGoalLifecycle(ports);
	const a = goal("rs", { status: "paused" });
	lc.adopt(a);
	lc.handle({ tag: "tool-call", toolName: "get_goal", input: {} });
	calls.length = 0;
	const report = lc.resume(a, ctx);
	assert.equal(report.kind, "resume");
	assert.equal(lc.focused()!.status, "active");
	assert.equal(lc.focused()!.autoContinue, true);
	assert.ok(calls.includes("begin-clock"));
	assert.ok(calls.includes("ledger:goal_resumed"));
	assert.equal(lc.getGoalNudgeCount(a.id), 0);
});

test("unfocus: the named focus(null) form (entry + unfocused ledger)", () => {
	const { ports, calls } = recordingPorts();
	const lc = createGoalLifecycle(ports);
	const a = goal("uf");
	lc.adopt(a);
	calls.length = 0;
	const report = lc.unfocus(ctx, "cleared");
	assert.equal(report.kind, "focus");
	assert.equal(lc.focusedId, null);
	assert.ok(calls.includes("ledger:goal_unfocused"));
	assert.ok(calls.includes(`entry:-:cleared`));
});

test("reconcileFromDisk: vanish path clears stale gate + halts; memory-usage merge keeps counters", () => {
	const { ports, calls, setDisk } = recordingPorts();
	const lc = createGoalLifecycle(ports);
	// An activePath-holding record whose disk file has gone away — the
	// orphan-memory branch (no activePath) would keep it instead.
	const a = { ...goal("rc-a"), activePath: ".pi/goals/active_goal_rc-a.md" };
	lc.adopt(a);
	lc.handle({ tag: "draft-start", kind: "tweak", goalId: a.id });
	calls.length = 0;
	// Disk pool no longer has the focused goal and the record holds an
	// activePath → the vanish branch: silent unfocus + halt + gate clear.
	setDisk(new Map<string, GoalRecord>());
	assert.equal(lc.reconcileFromDisk(ctx), false);
	assert.equal(lc.focusedId, null);
	assert.equal(lc.tweakDraftingFor, null, "vanish path clears the stale tweak gate");
	assert.ok(calls.includes("halt"));
	assert.ok(calls.includes("sync"));
	assert.ok(calls.includes("ui"));

	// Separate lifecycle: focused + disk goal present + preserveMemoryUsage —
	// the merge branch keeps the memory-side monotonic usage counters.
	const lc2 = createGoalLifecycle(ports);
	const mem = { ...goal("rc-a"), activePath: ".pi/goals/active_goal_rc-a.md", usage: { tokensUsed: 50, activeSeconds: 9, costUsed: 0 } };
	lc2.adopt(mem);
	const freshGoal = { ...mem, usage: { tokensUsed: 7, activeSeconds: 2, costUsed: 0 } };
	setDisk(new Map([[freshGoal.id, freshGoal]]));
	assert.equal(lc2.reconcileFromDisk(ctx, { preserveMemoryUsage: true }), true);
	assert.equal(lc2.focusedId, mem.id);
	assert.equal(lc2.focused()!.usage.tokensUsed, 50, "memory usage survives the disk merge");
	// Vanish left no focus behind: a fresh reconcile only swaps the pool.
	assert.equal(lc.reconcileFromDisk(ctx), true);
	assert.equal(lc.focusedId, null, "no focus re-pick — focus resolution belongs to loadState");
});

// ---------- review P2/P3 follow-ups: failure injection + orphan branch ----------

test("storage failure: a throwing archive port propagates out of terminate (old parity)", () => {
	// The pre-refactor archiveCurrentGoal called archiveGoalFile unwrapped —
	// an atomicWriteGoalFile failure crashed the clear/abort path mid-way.
	// The verb keeps that contract (spec §4.2: 与现状对拍; never report a
	// failed disk write as success), so we pin the PROPAGATION plus the
	// intermediate state (no unfocus, no ledger, no persist happened yet).
	const { ports, calls } = recordingPorts();
	ports.archiveGoal = () => {
		throw new Error("disk full");
	};
	const lc = createGoalLifecycle(ports);
	const a = goal("tf");
	lc.adopt(a);
	assert.throws(() => lc.terminate("clear", ctx, { note: "n" }), /disk full/);
	assert.equal(lc.focusedId, a.id, "no unfocus on a failed archive");
	assert.deepEqual(calls.filter((c) => c.startsWith("ledger") || c === "persist" || c === "ui"), []);
});

test("verbs survive a throwing ledger port (best-effort pinned)", () => {
	const { ports, calls } = recordingPorts();
	ports.appendLedger = () => {
		throw new Error("ledger io");
	};
	const lc = createGoalLifecycle(ports);
	const a = goal("lf");
	lc.adopt(a);
	assert.doesNotThrow(() => lc.complete(a, ctx));
	assert.equal(lc.focusedId, null);
	calls.length = 0;
	lc.adopt(goal("lf2"));
	assert.doesNotThrow(() => lc.terminate("abort", ctx, { by: "agent", reason: "r" }));
	assert.doesNotThrow(() => lc.create({ objective: "=== Goal ===\nObjective: x", autoContinue: true, sisyphus: false }, ctx));
	assert.doesNotThrow(() => {
		const g = lc.focused();
		if (g) lc.pause(g, ctx, "user");
	});
});

test("reconcileFromDisk orphan-memory branch keeps an activePath-less focused record", () => {
	const { ports, setDisk } = recordingPorts();
	const lc = createGoalLifecycle(ports);
	// No activePath → the disk pool losing it must NOT unfocus (the record
	// only ever lived in memory; keep it focused in the fresh pool).
	const orphan = goal("orphan-no-path");
	lc.adopt(orphan);
	setDisk(new Map<string, GoalRecord>()); // disk pool empty
	assert.equal(lc.reconcileFromDisk(ctx), true);
	assert.equal(lc.focusedId, orphan.id, "orphan memory goal stays focused");
	assert.ok(lc.pool.has(orphan.id));
});
