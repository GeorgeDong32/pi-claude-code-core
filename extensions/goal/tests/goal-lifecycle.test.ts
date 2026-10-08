/**
 * goal-lifecycle.test.ts — SPEC 2026-10-07 P2-2 §4.4 + the C5 follow-up
 * (2026-10-09): the verb transition table against RECORDING ports (no
 * FakeHost — the module owns state and calls ports only), plus the
 * ENCAPSULATION acceptance suite.
 *
 * Encapsulation red evidence (pre-fix, recorded 2026-10-09 against c8429f4):
 * mutating focused().objective / pool.get(id).usage.tokensUsed / a pool Map
 * set / confirmationIntent.originalTopic / a setGoal input alias ALL reached
 * owned state, and adopt/replacePool/setFocusedSilently/removeFromPool were
 * public. The suite below pins every one of those as FAILED bypass routes.
 *
 * Seeding goes through REAL verbs (restore with a disk pool + focus entry) —
 * the silent primitives are module-internal now and not reachable from here.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createGoalLifecycle, type GoalLifecycle, type GoalLifecyclePorts } from "../goal-lifecycle.ts";
import type { GoalFocusEntry, GoalRecord } from "../goal-record.ts";
import { createGoal } from "../goal-record.ts";

function recordingPorts() {
	const calls: string[] = [];
	let mergeCalls = 0;
	const ports: GoalLifecyclePorts = {
		haltContinuation: () => calls.push("halt"),
		pauseClock: () => calls.push("pause-clock"),
		forgetCarry: (id) => calls.push(`forget:${id}`),
		appendFocusEntry: (id, reason) => calls.push(`entry:${id ?? "-"}:${reason}`),
		appendLedger: (_ctx, event) => calls.push(`ledger:${(event as { type: string }).type}`),
		syncTools: () => calls.push("sync"),
		updateUI: () => calls.push("ui"),
		nowIso: () => "2026-10-08T00:00:00.000Z",
		mergeGoalPromptFromDisk: (_ctx, goal) => {
			mergeCalls++;
			return goal;
		},
		archiveGoal: (_ctx, goal) => {
			calls.push("archive");
			return { ...goal, archivedPath: `.pi/goals/archive/${goal.id}.md` };
		},
		writeActiveGoalFile: (_ctx, goal) => {
			calls.push("write");
			return { ...goal, activePath: `.pi/goals/active_goal_${goal.id}.md` };
		},
		readActiveGoalPool: () => diskPool,
		appendStateEntry: (goal) => calls.push(`state-entry${goal ? "" : ":null"}`),
		beginClock: () => calls.push("begin-clock"),
	};
	let diskPool = new Map<string, GoalRecord>();
	const setDisk = (m: Map<string, GoalRecord>) => {
		diskPool = m;
	};
	return { ports, calls, setDisk, mergeCalls: () => mergeCalls };
}

function goal(idSeed: string, opts: { status?: "active" | "paused" | "complete"; autoContinue?: boolean } = {}): GoalRecord {
	const g = createGoal({ objective: `=== Goal ===\nObjective: ${idSeed}`, autoContinue: opts.autoContinue ?? true, sisyphus: false }, Date.UTC(2026, 9, 8));
	return { ...g, status: opts.status ?? "active" } as GoalRecord;
}

const ctx = { cwd: "/w" };

type Recording = ReturnType<typeof recordingPorts>;

function makeLifecycle(): Recording & { lc: GoalLifecycle } {
	const rec = recordingPorts();
	return { ...rec, lc: createGoalLifecycle(rec.ports) };
}

/** Seed via the REAL restore verb: disk pool + explicit focus entry (no
 * extra migrated/selected entry, no ledger). `goals[0]` becomes focused. */
function seedFocused(rec: Recording & { lc: GoalLifecycle }, ...goals: GoalRecord[]): void {
	const first = goals[0]!;
	rec.setDisk(new Map(goals.map((g) => [g.id, g])));
	const focusEntry: GoalFocusEntry = { version: 1, focusedGoalId: first.id, reason: "selected" };
	rec.lc.restore(ctx, { childSession: false, focusEntry, legacyGoal: null });
	rec.calls.length = 0;
}

// ---------- C5 follow-up: encapsulation acceptance ----------
//
// Red evidence captured against the pre-fix module (c8429f4, 2026-10-09):
// every mutation below CHANGED owned state through the then-live references.
// These tests pin the fixed module: all of them must FAIL to bypass.

test("encapsulation: mutating focused()/pool projections never reaches owned state", () => {
	const rec = makeLifecycle();
	const a = goal("enc-a");
	seedFocused(rec, a);
	// 1. mutate the focused() return (top-level + nested usage)
	const stolen = rec.lc.focused()!;
	stolen.objective = "MUTATED-VIA-FOCUSED";
	stolen.usage.tokensUsed = 999;
	assert.equal(rec.lc.focused()!.objective, a.objective);
	assert.equal(rec.lc.focused()!.usage.tokensUsed, a.usage.tokensUsed);
	// 2. mutate a pool record (nested usage object) and the pool Map itself
	(rec.lc.pool.get(a.id)!).usage.tokensUsed = 999;
	assert.equal(rec.lc.focused()!.usage.tokensUsed, a.usage.tokensUsed);
	(rec.lc.pool as Map<string, GoalRecord>).set("evil", a);
	(rec.lc.pool as Map<string, GoalRecord>).delete(a.id);
	assert.equal(rec.lc.pool.has("evil"), false, "the pool getter returns a copy — Map writes land on the copy only");
	assert.equal(rec.lc.pool.has(a.id), true);
	assert.equal(rec.lc.focusedId, a.id, "focus untouched by pool-copy writes");
	// 3. two pool reads are independent copies
	const p1 = rec.lc.pool.get(a.id)!;
	const p2 = rec.lc.pool.get(a.id)!;
	p1.objective = "POOL-COPY-CROSS-TALK";
	assert.equal(p2.objective, a.objective);
});

test("encapsulation: mutating a confirmationIntent projection never reaches owned state", () => {
	const { lc } = makeLifecycle();
	lc.handle({ tag: "draft-start", kind: "goal", focus: "goal", topic: "original topic", startedAt: 1 });
	const stolen = lc.confirmationIntent!;
	stolen.originalTopic = "MUTATED-TOPIC";
	stolen.focus = "sisyphus";
	assert.equal(lc.confirmationIntent!.originalTopic, "original topic");
	assert.equal(lc.confirmationIntent!.focus, "goal");
	assert.deepEqual(lc.confirmationIntent, { focus: "goal", originalTopic: "original topic", startedAt: 1 });
});

test("encapsulation: complete's record intake is cloned — a caller-held alias cannot reach owned state", () => {
	const rec = makeLifecycle();
	const a = goal("enc-c");
	seedFocused(rec, a);
	const report = rec.lc.complete(a, ctx);
	// the caller's own record object (also the verb input)
	a.objective = "MUTATED-INPUT-ALIAS";
	// and the report's record escape
	report.record!.objective = "MUTATED-REPORT-RECORD";
	assert.equal(report.record!.objective === "MUTATED-REPORT-RECORD", true, "the report copy is caller-owned — mutating it is allowed");
	assert.equal(rec.lc.pool.has(a.id), false, "the completed goal is out of the pool; no alias re-adds it");
	// a fresh seed + persistRecord shows the pool value was captured pre-mutation
	const rec2 = makeLifecycle();
	const b = goal("enc-c2");
	seedFocused(rec2, b);
	rec2.lc.persistRecord(ctx);
	b.objective = "MUTATED-SEED-ALIAS";
	assert.equal(rec2.lc.focused()!.objective, "=== Goal ===\nObjective: enc-c2");
});

test("encapsulation: storage port results are cloned at intake — a retained port alias cannot reach owned state", () => {
	const rec = makeLifecycle();
	let retained: GoalRecord | null = null;
	rec.ports.writeActiveGoalFile = (_ctx, g) => {
		const out = { ...g, activePath: `.pi/goals/active_goal_${g.id}.md` };
		retained = out;
		return out;
	};
	const a = goal("enc-p");
	seedFocused(rec, a);
	rec.lc.persistRecord(ctx);
	retained!.objective = "MUTATED-VIA-PORT-RESULT";
	retained!.usage.tokensUsed = 999;
	assert.equal(rec.lc.focused()!.objective, "=== Goal ===\nObjective: enc-p");
	assert.equal(rec.lc.focused()!.usage.tokensUsed, a.usage.tokensUsed);
	// the same isolation holds for pool intake via restore (readActiveGoalPool results)
	let diskRetained: GoalRecord | null = null;
	const diskGoal = goal("enc-disk");
	rec.ports.readActiveGoalPool = () => {
		const m = new Map<string, GoalRecord>();
		m.set(diskGoal.id, diskGoal);
		diskRetained = diskGoal;
		return m;
	};
	rec.lc.restore(ctx, { childSession: false, focusEntry: null, legacyGoal: null });
	diskRetained!.objective = "MUTATED-VIA-DISK-POOL";
	assert.equal(rec.lc.focused()!.objective, "=== Goal ===\nObjective: enc-disk");
});

test("encapsulation: public surface has no silent write entries", () => {
	const { lc } = makeLifecycle();
	const surface = lc as unknown as Record<string, unknown>;
	for (const key of ["adopt", "replacePool", "setFocusedSilently", "removeFromPool", "setGoal", "updateRecord", "setState", "patch"]) {
		assert.equal(surface[key], undefined, `${key} must not be a public entry`);
	}
	assert.equal(typeof surface.handle, "function", "the closed event entry stays");
	assert.equal(typeof surface.create, "function");
});

// ---------- transition table ----------

test("create on empty: full effect order (setGoal leg + clock + nudge + intent clear + ledger)", () => {
	const rec = makeLifecycle();
	const report = rec.lc.create({ objective: "=== Goal ===\nObjective: new", autoContinue: true, sisyphus: false }, ctx);
	assert.equal(report.kind, "create");
	assert.equal(report.nextGoalId, rec.lc.focusedId);
	// setGoal leg: focus change (null→created) + persist sequence + ui
	assert.deepEqual(rec.calls, [
		"halt", "pause-clock",
		`entry:${report.nextGoalId}:created`,
		"write", "state-entry", "sync", "ui", "ui",
		"begin-clock", "ledger:goal_created",
	]);
	assert.ok(report.effects.includes(`nudge-reset:${report.nextGoalId}`));
	assert.ok(report.effects.includes("draft-applied:goal"));
});

test("create A -> B (focus change): full effect order, focus entry only with reason", () => {
	const rec = makeLifecycle();
	const a = goal("a");
	seedFocused(rec, a);
	rec.calls.length = 0;
	const report = rec.lc.create({ objective: "=== Goal ===\nObjective: b", autoContinue: true, sisyphus: false }, ctx);
	assert.equal(rec.lc.focusedId, report.nextGoalId);
	assert.equal(report.previousGoalId, a.id);
	assert.deepEqual(rec.calls, [
		"halt", "pause-clock",
		`entry:${report.nextGoalId}:created`,
		"write", "state-entry", "sync", "ui", "ui",
		"begin-clock", "ledger:goal_created",
	]);
	assert.ok(report.effects.includes(`nudge-reset:${a.id}`));
	assert.ok(report.effects.includes("release-stale-tweak-gate"));
});

test("null-clear effect set (via terminate): carry forgotten; persist and ui legs", () => {
	const rec = makeLifecycle();
	const a = goal("nc");
	seedFocused(rec, a);
	rec.calls.length = 0;
	rec.lc.terminate("clear", ctx);
	// next=null: the focus-change block AND the inactive/paused conditions
	// BOTH fire (the old code called the same clears twice — idempotent).
	assert.deepEqual(rec.calls, [
		"archive", "ledger:goal_aborted",
		"halt", "pause-clock",
		"entry:-:cleared",
		"halt", "pause-clock", `forget:${a.id}`,
		"state-entry:null", "sync", "ui", "ui",
	]);
});

test("same-goal record update (via setUserNote): no focus-change effects, persist-only shape", () => {
	const rec = makeLifecycle();
	const a = goal("same");
	seedFocused(rec, a);
	rec.calls.length = 0;
	rec.lc.setUserNote(ctx, "stand by");
	assert.deepEqual(rec.calls.filter((c) => c.startsWith("halt") || c.startsWith("nudge") || c.startsWith("entry") || c.startsWith("forget")), []);
	assert.deepEqual(rec.calls, ["write", "state-entry", "sync", "ui", "ui"]);
	assert.equal(rec.lc.focused()!.userNote, "stand by");
});

test("focus: valid id focuses with ledger; invalid id unfocuses; no change -> no halt", () => {
	const rec = makeLifecycle();
	const a = goal("fa");
	const b = goal("fb");
	seedFocused(rec, a, b);
	rec.calls.length = 0;
	rec.lc.focus(a.id, ctx, "selected");
	assert.equal(rec.lc.focusedId, a.id);
	assert.deepEqual(rec.calls, [
		`entry:${a.id}:selected`, "ledger:goal_focused", "sync", "ui",
	]);
	rec.calls.length = 0;
	rec.lc.focus("no-such-id", ctx, "cleared");
	assert.equal(rec.lc.focusedId, null);
	assert.ok(rec.calls.includes("ledger:goal_unfocused"));
	rec.calls.length = 0;
	rec.lc.focus(null, ctx, "selected");
	// already unfocused, no previous -> no ledger, but entry/sync/ui still run
	assert.deepEqual(rec.calls, ["entry:-:selected", "sync", "ui"]);
});

test("unfocus: the named focus(null) form (entry + unfocused ledger)", () => {
	const rec = makeLifecycle();
	const a = goal("uf");
	seedFocused(rec, a);
	rec.calls.length = 0;
	const report = rec.lc.unfocus(ctx, "cleared");
	assert.equal(report.kind, "focus");
	assert.equal(rec.lc.focusedId, null);
	assert.ok(rec.calls.includes("ledger:goal_unfocused"));
	assert.ok(rec.calls.includes(`entry:-:cleared`));
});

// ---------- Step 2: complete / terminate ----------

test("complete: the update_goal approved-verdict effect order (same-id terminal)", () => {
	const events: Array<Record<string, unknown>> = [];
	const rec = makeLifecycle();
	rec.ports.appendLedger = (_ctx, event) => {
		events.push(event);
		rec.calls.push(`ledger:${(event as { type: string }).type}`);
	};
	const a = goal("cmp");
	seedFocused(rec, a);
	rec.calls.length = 0;
	const report = rec.lc.complete(a, ctx);
	assert.equal(report.kind, "complete");
	assert.equal(report.previousGoalId, a.id);
	assert.equal(report.nextGoalId, null);
	assert.ok(report.record, "report carries the terminal record for display");
	assert.equal(report.record!.status, "complete");
	assert.equal(report.record!.stopReason, "agent");
	// pre-adopt(audit target) → setGoal leg (same id: halt+pause via the
	// complete-status conditions, carry forgotten, persist=archive inside)
	// → inline-block tail: nudge, pool removal, focus entry, sync, ui, ledger.
	assert.deepEqual(rec.calls, [
		"halt", "pause-clock", `forget:${a.id}`,
		"archive", "state-entry", "sync", "ui", "ui",
		`entry:-:completed`, "sync", "ui", "ledger:goal_completed",
	]);
	assert.equal(rec.lc.focusedId, null, "the completed goal leaves the pool");
	assert.equal(rec.lc.pool.has(a.id), false);
	rec.calls.length = 0;
	// A second complete with nothing focused: the pre-adopt focuses the
	// audited target (the folded adapter adopt), then transitions it — a
	// no-crash shape guarded by the adapter's gate in production.
	const bareGoal = goal("bare");
	const bare = rec.lc.complete(bareGoal, ctx);
	assert.equal(bare.previousGoalId, bareGoal.id, "the folded pre-adopt makes the audited target the previous focus");
	assert.ok(rec.calls.includes("ledger:goal_completed"));
});

test("terminate clear (user): archive → ledger(user cleared) → nudge → setGoal(null) effects", () => {
	const events: Array<Record<string, unknown>> = [];
	const rec = makeLifecycle();
	rec.ports.appendLedger = (_ctx, event) => {
		events.push(event);
		rec.calls.push(`ledger:${(event as { type: string }).type}`);
	};
	const a = goal("tc");
	seedFocused(rec, a);
	rec.calls.length = 0;
	const report = rec.lc.terminate("clear", ctx, { note: "done with it" });
	assert.equal(report.kind, "terminate");
	assert.equal(report.previousGoalId, a.id);
	assert.ok(report.record, "archived record rides the report");
	assert.equal(report.record!.status, "paused", "user clear archives non-complete as paused");
	assert.equal(report.record!.stopReason, "user");
	assert.equal(events[0]?.type, "goal_aborted");
	assert.equal(events[0]?.reason, "user cleared: done with it", "old appendUserTerminationEvent wording preserved");
	assert.deepEqual(rec.calls, [
		"archive", "ledger:goal_aborted",
		"halt", "pause-clock",
		"entry:-:cleared",
		"halt", "pause-clock", `forget:${a.id}`,
		"state-entry:null", "sync", "ui", "ui",
	]);
	assert.equal(rec.lc.focusedId, null);
});

test("terminate abort (agent): aborted record built, raw reason ledger, focus reason aborted", () => {
	const events: Array<Record<string, unknown>> = [];
	const rec = makeLifecycle();
	rec.ports.appendLedger = (_ctx, event) => {
		events.push(event);
		rec.calls.push(`ledger:${(event as { type: string }).type}`);
	};
	const a = goal("ta");
	seedFocused(rec, a);
	rec.calls.length = 0;
	const report = rec.lc.terminate("abort", ctx, { by: "agent", reason: "objective obsolete" });
	assert.ok(report.record);
	assert.equal(report.record!.pauseReason, "Aborted: objective obsolete");
	assert.equal(report.record!.stopReason, "agent");
	assert.equal(report.record!.autoContinue, false);
	assert.equal(events[0]?.reason, "objective obsolete", "agent ledger keeps the raw reason");
	assert.ok(rec.calls.includes("archive"));
	assert.ok(rec.calls.includes("ledger:goal_aborted"));
});

test("terminate with nothing focused: ledger still records, no archive/nudge", () => {
	const events: Array<Record<string, unknown>> = [];
	const rec = makeLifecycle();
	rec.ports.appendLedger = (_ctx, event) => {
		events.push(event);
		rec.calls.push(`ledger:${(event as { type: string }).type}`);
	};
	const report = rec.lc.terminate("clear", ctx);
	assert.equal(report.record, undefined);
	assert.equal(events[0]?.goalId, "unknown");
	assert.deepEqual(rec.calls, ["ledger:goal_aborted", "halt", "pause-clock", "state-entry:null", "sync", "ui", "ui"]);
});

// ---------- C5 follow-up: the new path verbs ----------

test("pause(user): merge → stamp paused/user+note → setGoal → ledger goal_paused → nudge reset", () => {
	const events: Array<Record<string, unknown>> = [];
	const rec = makeLifecycle();
	rec.ports.appendLedger = (_ctx, event) => {
		events.push(event);
		rec.calls.push(`ledger:${(event as { type: string }).type}`);
	};
	const a = goal("pz");
	seedFocused(rec, a);
	rec.lc.handle({ tag: "tool-call", toolName: "get_goal", input: {} });
	rec.calls.length = 0;
	const report = rec.lc.pause(ctx, { note: "blocked" });
	assert.equal(report.kind, "pause");
	assert.equal(rec.lc.focused()!.status, "paused");
	assert.equal(rec.lc.focused()!.stopReason, "user");
	assert.equal(rec.lc.focused()!.pauseReason, "user: blocked");
	assert.equal(events[0]?.type, "goal_paused");
	assert.equal(events[0]?.reason, "user");
	assert.equal(rec.lc.getGoalNudgeCount(a.id), 0, "verb resets the nudge chain");
	assert.deepEqual(rec.calls, [
		"halt", "pause-clock",
		"write", "state-entry", "sync", "ui", "ui",
		"ledger:goal_paused",
	]);
	// paused goals KEEP their carry (GO-A): no forget port call
	assert.ok(!rec.calls.some((c) => c.startsWith("forget:")));
	// no-op shape: pausing an already-paused goal does nothing
	rec.calls.length = 0;
	const noop = rec.lc.pause(ctx);
	assert.deepEqual(noop.effects, []);
	assert.deepEqual(rec.calls, []);
});

test("pauseByAgent: policy builder + setGoal + nudge + turn-stopped, NO pause ledger", () => {
	const rec = makeLifecycle();
	const a = goal("pa");
	seedFocused(rec, a);
	rec.calls.length = 0;
	const report = rec.lc.pauseByAgent(ctx, { reason: "missing key", suggestedAction: "set FOO" });
	assert.equal(report.kind, "pause");
	assert.equal(rec.lc.focused()!.pauseReason, "missing key");
	assert.equal(rec.lc.focused()!.pauseSuggestedAction, "set FOO");
	assert.equal(rec.lc.focused()!.stopReason, "agent");
	assert.equal(rec.lc.turnStoppedFor, a.id, "C9: the tool path locks the turn");
	assert.ok(!rec.calls.some((c) => c.startsWith("ledger:")), "the tool path never emitted the pause ledger");
	assert.ok(report.effects.includes(`turn-stopped:${a.id}`));
});

test("resume: stamp active + setGoal + begin-clock + nudge + ledger goal_resumed", () => {
	const rec = makeLifecycle();
	const a = goal("rs", { status: "paused" });
	seedFocused(rec, a);
	rec.lc.handle({ tag: "tool-call", toolName: "get_goal", input: {} });
	rec.calls.length = 0;
	const report = rec.lc.resume(ctx);
	assert.equal(report.kind, "resume");
	assert.equal(rec.lc.focused()!.status, "active");
	assert.equal(rec.lc.focused()!.autoContinue, true);
	assert.equal(rec.lc.getGoalNudgeCount(a.id), 0);
	assert.deepEqual(rec.calls, [
		"write", "state-entry", "sync", "ui", "ui",
		"begin-clock", "ledger:goal_resumed",
	]);
});

test("activate: the session-resume confirmation shape — setGoal only, no merge/ledger/clock/nudge", () => {
	const rec = makeLifecycle();
	// An active record with a stale pause reason: activate stamps active +
	// clears the pause fields; the nudge chain must survive (no reset).
	const a = { ...goal("ac"), pauseReason: "user: stale" };
	seedFocused(rec, a);
	rec.lc.handle({ tag: "tool-call", toolName: "get_goal", input: {} });
	rec.lc.handle({ tag: "tool-call", toolName: "get_goal", input: {} });
	assert.equal(rec.lc.getGoalNudgeCount(a.id), 2);
	rec.calls.length = 0;
	const report = rec.lc.activate(ctx);
	assert.equal(report.kind, "activate");
	assert.equal(rec.lc.focused()!.status, "active");
	assert.equal(rec.lc.focused()!.pauseReason, undefined, "stale pause reason cleared");
	assert.deepEqual(rec.calls, ["write", "state-entry", "sync", "ui", "ui"]);
	assert.ok(!rec.calls.some((c) => c.startsWith("ledger:")), "no goal_resumed ledger on this path (historical shape)");
	assert.ok(!rec.calls.includes("begin-clock"), "no verb-level clock begin (the session flow calls beginAccounting itself)");
	assert.equal(rec.lc.getGoalNudgeCount(a.id), 2, "nudge counter NOT reset by the session activation");
});

test("applyUsage: the accounting result adoption — clone + delta + updatedAt, no port effects", () => {
	const rec = makeLifecycle();
	const a = goal("au");
	seedFocused(rec, a);
	rec.calls.length = 0;
	rec.lc.applyUsage({ tokens: 120, cost: 0.5, seconds: 3 });
	assert.deepEqual(rec.calls, [], "pure state adoption — no ports fire");
	const after = rec.lc.focused()!;
	assert.equal(after.usage.tokensUsed, 120);
	assert.equal(after.usage.costUsed, 0.5);
	assert.equal(after.usage.activeSeconds, 3);
	assert.equal(after.updatedAt, "2026-10-08T00:00:00.000Z");
});

test("recordAuditAttempt: stamp auditAttempts + persist (count survives a rejected audit)", () => {
	const rec = makeLifecycle();
	const a = goal("ra");
	seedFocused(rec, a);
	rec.calls.length = 0;
	rec.lc.recordAuditAttempt(ctx, 2);
	assert.equal(rec.lc.focused()!.auditAttempts, 2);
	assert.deepEqual(rec.calls, ["write", "state-entry", "sync", "ui"]);
});

test("applyTweak: authoritative write (no objective re-read), gate clear, fresh chain, turn lock", () => {
	const rec = makeLifecycle();
	const a = goal("tw");
	seedFocused(rec, a);
	rec.lc.handle({ tag: "draft-start", kind: "tweak", goalId: a.id });
	rec.lc.handle({ tag: "tool-call", toolName: "get_goal", input: {} });
	rec.calls.length = 0;
	const report = rec.lc.applyTweak(ctx, "=== Goal ===\nObjective: revised");
	assert.equal(report.kind, "tweak");
	assert.equal(rec.lc.focused()!.objective, "=== Goal ===\nObjective: revised");
	assert.equal(rec.lc.focused()!.pauseReason, undefined, "prior agent pause reason cleared");
	assert.equal(rec.lc.tweakDraftingFor, null, "gate cleared — the tool cannot be re-used");
	assert.equal(rec.lc.getGoalNudgeCount(a.id), 0, "fresh nudge chain");
	assert.equal(rec.lc.turnStoppedFor, a.id, "C9: tweak locks the turn");
	assert.equal(rec.mergeCalls(), 0, "the tweak write is upstream of the disk — NO objective merge re-read");
	assert.deepEqual(rec.calls, ["write", "state-entry", "sync", "ui"]);
	assert.ok(report.effects.includes(`write-active-file:${a.id}`));
});

test("retireForReplacement: archive (result discarded) + clear with persist, NO goal_aborted ledger", () => {
	const rec = makeLifecycle();
	const a = goal("rr");
	seedFocused(rec, a);
	rec.calls.length = 0;
	const report = rec.lc.retireForReplacement(ctx);
	assert.equal(report.kind, "retire");
	assert.ok(rec.calls.includes("archive"));
	assert.ok(rec.calls.includes(`entry:-:cleared`));
	assert.ok(!rec.calls.some((c) => c.startsWith("ledger:")), "historical boundary #119⑤: no goal_aborted on replace");
	assert.equal(rec.lc.focusedId, null);
});

test("restore: pool from disk, focus resolution, migrated entry, complete-removal, halted runtime", () => {
	const rec = makeLifecycle();
	const open = goal("rv-open");
	const done = goal("rv-done", { status: "complete" });
	rec.setDisk(new Map([[open.id, open], [done.id, done]]));
	// No focus entry; the complete record never counts as open, so exactly
	// ONE open goal remains -> resolveSessionFocus auto-picks it and the
	// selected focus entry is appended (the old loadState behavior).
	const focusedId = rec.lc.restore(ctx, { childSession: false, focusEntry: null, legacyGoal: null });
	assert.equal(focusedId, open.id);
	assert.equal(rec.lc.pool.has(done.id), false, "completed records leave the pool");
	assert.equal(rec.lc.pool.has(open.id), true);
	assert.ok(rec.calls.includes(`entry:${open.id}:selected`));
	assert.ok(rec.calls.includes("halt"));
	assert.ok(rec.calls.includes("pause-clock"));
	assert.ok(rec.calls.includes("sync"));
	assert.ok(rec.calls.includes("ui"));

	// Legacy adoption: no focus entry, a legacy non-complete record not in
	// the pool -> adopted, focused, and the migrated focus entry appended.
	rec.calls.length = 0;
	const legacy = goal("rv-legacy");
	const focused2 = rec.lc.restore(ctx, { childSession: false, focusEntry: null, legacyGoal: legacy });
	assert.equal(focused2, legacy.id);
	assert.equal(rec.lc.focusedId, legacy.id);
	assert.ok(rec.calls.includes(`entry:${legacy.id}:migrated`));

	// Child session: the pool stays EMPTY (GH-02) whatever the disk says.
	rec.calls.length = 0;
	const focused3 = rec.lc.restore(ctx, { childSession: true, focusEntry: null, legacyGoal: null });
	assert.equal(focused3, null);
	assert.equal(rec.lc.pool.size, 0);
});

test("restore: per-turn flags cleared; drafting + nudge survive (as today)", () => {
	const rec = makeLifecycle();
	const a = goal("rvf");
	seedFocused(rec, a);
	rec.lc.handle({ tag: "tool-call", toolName: "get_goal", input: {} });
	rec.lc.handle({ tag: "draft-start", kind: "goal", focus: "goal", topic: "t", startedAt: 1 });
	rec.lc.handle({ tag: "turn-stopped", goalId: a.id });
	rec.calls.length = 0;
	rec.setDisk(new Map([[a.id, a]]));
	rec.lc.restore(ctx, { childSession: false, focusEntry: { version: 1, focusedGoalId: a.id, reason: "selected" }, legacyGoal: null });
	assert.equal(rec.lc.turnStoppedFor, null);
	assert.equal(rec.lc.goalWorkToolCalledThisTurn, false);
	assert.equal(rec.lc.confirmationIntent !== null, true, "drafting survives a restore");
	assert.equal(rec.lc.getGoalNudgeCount(a.id), 1, "nudge counters survive a restore");
});

test("syncObjectiveFromDisk: value-compare through the clone boundary; readCtx fast path", () => {
	const rec = makeLifecycle();
	const a = goal("so");
	seedFocused(rec, a);
	// Identity-merge port (nothing to merge): no change, no write.
	assert.equal(rec.lc.syncObjectiveFromDisk(ctx), false);
	// A disk objective change rides the merge port result.
	rec.ports.mergeGoalPromptFromDisk = (_ctx, g) => ({ ...g, objective: "=== Goal ===\nObjective: from disk" });
	assert.equal(rec.lc.syncObjectiveFromDisk(ctx), true);
	assert.equal(rec.lc.focused()!.objective, "=== Goal ===\nObjective: from disk");
	// readCtx fast path (AR1005-GO-B): the already-parsed disk goal wins, no merge call.
	const before = rec.mergeCalls();
	assert.equal(rec.lc.syncObjectiveFromDisk(ctx, { goal: { ...a, objective: "=== Goal ===\nObjective: parsed" } }), true);
	assert.equal(rec.mergeCalls(), before);
	assert.equal(rec.lc.focused()!.objective, "=== Goal ===\nObjective: parsed");
	// readCtx with a null goal: no change.
	assert.equal(rec.lc.syncObjectiveFromDisk(ctx, { goal: null }), false);
});

test("persistRecord: stamp → sync → write → adopt canonical → state entry → sync → ui", () => {
	const rec = makeLifecycle();
	const a = goal("pr");
	seedFocused(rec, a);
	rec.calls.length = 0;
	rec.lc.persistRecord(ctx);
	assert.deepEqual(rec.calls, ["write", "state-entry", "sync", "ui"]);
	// ctx-less persist: no disk write, no UI — entry + sync only.
	rec.calls.length = 0;
	rec.lc.persistRecord();
	assert.deepEqual(rec.calls, ["state-entry", "sync"]);
});

test("refreshDisplayFromDisk: changed objective stamps + state entry; unchanged stays lean", () => {
	const rec = makeLifecycle();
	const a = goal("rd");
	seedFocused(rec, a);
	rec.calls.length = 0;
	rec.lc.refreshDisplayFromDisk(ctx);
	assert.deepEqual(rec.calls, ["sync", "ui"], "no change: no state entry");
	rec.ports.mergeGoalPromptFromDisk = (_ctx, g) => ({ ...g, objective: "=== Goal ===\nObjective: newer" });
	rec.calls.length = 0;
	rec.lc.refreshDisplayFromDisk(ctx);
	assert.deepEqual(rec.calls, ["state-entry", "sync", "ui"]);
	assert.equal(rec.lc.focused()!.objective, "=== Goal ===\nObjective: newer");
	// nothing focused / complete: early return, NO sync/ui (old shape)
	rec.ports.appendLedger = (_c, e) => rec.calls.push(`ledger:${(e as { type: string }).type}`);
	rec.lc.terminate("clear", ctx);
	rec.calls.length = 0;
	rec.lc.refreshDisplayFromDisk(ctx);
	assert.deepEqual(rec.calls, []);
});

// ---------- the closed event entry (one interface test per tag) ----------

test("event turn-start: resets both per-turn flags", () => {
	const { lc } = makeLifecycle();
	lc.handle({ tag: "turn-stopped", goalId: "g1" });
	lc.handle({ tag: "turn-start" });
	assert.equal(lc.turnStoppedFor, null);
	assert.equal(lc.goalWorkToolCalledThisTurn, false);
});

test("event turn-stopped: pins the four-real-stop lock value (D3=A)", () => {
	const { lc } = makeLifecycle();
	lc.handle({ tag: "turn-stopped", goalId: "g9" });
	assert.equal(lc.turnStoppedFor, "g9");
	lc.handle({ tag: "turn-stopped", goalId: null });
	assert.equal(lc.turnStoppedFor, null);
});

test("event tool-call: post-stop block verdict, nudge counting, progress credit", () => {
	const rec = makeLifecycle();
	const a = goal("tk");
	seedFocused(rec, a);
	// post-stop block: only read-only inspection passes
	rec.lc.handle({ tag: "turn-stopped", goalId: a.id });
	const blocked = rec.lc.handle({ tag: "tool-call", toolName: "write", input: { path: "x" } });
	assert.equal(blocked && blocked.blocked, true);
	assert.ok(blocked!.reason!.includes(a.id));
	const allowed = rec.lc.handle({ tag: "tool-call", toolName: "get_goal", input: {} });
	assert.equal(allowed && (allowed as { blocked?: boolean }).blocked, undefined);
	// get_goal nudge counting on an active, non-drafting goal — note the
	// post-stop get_goal above ALREADY counted (old behavior: the allowed
	// read-only inspection still passes the nudge-count block).
	rec.lc.handle({ tag: "turn-start" });
	rec.lc.handle({ tag: "tool-call", toolName: "get_goal", input: {} });
	rec.lc.handle({ tag: "tool-call", toolName: "get_goal", input: {} });
	assert.equal(rec.lc.getGoalNudgeCount(a.id), 3);
	// meaningful progress clears the counter and raises the work flag
	rec.lc.handle({ tag: "tool-call", toolName: "edit", input: { path: "f.ts" } });
	assert.equal(rec.lc.getGoalNudgeCount(a.id), 0);
	assert.equal(rec.lc.goalWorkToolCalledThisTurn, true);
	// G3 exceptions: echo bash and .pi/goals reads are NOT progress
	rec.lc.handle({ tag: "turn-start" });
	rec.lc.handle({ tag: "tool-call", toolName: "bash", input: { command: "echo hi" } });
	rec.lc.handle({ tag: "tool-call", toolName: "read", input: { path: ".pi/goals/active_goal_x.md" } });
	assert.equal(rec.lc.goalWorkToolCalledThisTurn, false);
	// drafting suspends nudge counting
	rec.lc.handle({ tag: "draft-start", kind: "goal", focus: "goal", topic: "t", startedAt: 1 });
	rec.lc.handle({ tag: "tool-call", toolName: "get_goal", input: {} });
	assert.equal(rec.lc.getGoalNudgeCount(a.id), 0);
});

test("event usage-accounted / agent-settled: routing pins — owned state untouched", () => {
	const rec = makeLifecycle();
	const a = goal("ua");
	seedFocused(rec, a);
	rec.lc.handle({ tag: "draft-start", kind: "tweak", goalId: a.id });
	rec.lc.handle({ tag: "turn-stopped", goalId: a.id });
	rec.lc.handle({ tag: "tool-call", toolName: "get_goal", input: {} });
	const before = { tweak: rec.lc.tweakDraftingFor, stopped: rec.lc.turnStoppedFor, nudge: rec.lc.getGoalNudgeCount(a.id), work: rec.lc.goalWorkToolCalledThisTurn };
	rec.lc.handle({ tag: "usage-accounted" });
	rec.lc.handle({ tag: "agent-settled" });
	assert.deepEqual({ tweak: rec.lc.tweakDraftingFor, stopped: rec.lc.turnStoppedFor, nudge: rec.lc.getGoalNudgeCount(a.id), work: rec.lc.goalWorkToolCalledThisTurn }, before);
});

test("event draft-start/cancel/applied: both intents, kind-specific cancels", () => {
	const { lc } = makeLifecycle();
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

test("event nudge-reset: the adapter-side user-turn reset", () => {
	const rec = makeLifecycle();
	const a = goal("nr");
	seedFocused(rec, a);
	rec.lc.handle({ tag: "tool-call", toolName: "get_goal", input: {} });
	rec.lc.handle({ tag: "tool-call", toolName: "get_goal", input: {} });
	assert.equal(rec.lc.getGoalNudgeCount(a.id), 2);
	rec.lc.handle({ tag: "nudge-reset", goalId: a.id });
	assert.equal(rec.lc.getGoalNudgeCount(a.id), 0);
	rec.lc.handle({ tag: "nudge-reset", goalId: undefined });
	rec.lc.handle({ tag: "nudge-reset", goalId: null });
});

test("event dispose: clears all event-owned state", () => {
	const rec = makeLifecycle();
	const a = goal("dp");
	seedFocused(rec, a);
	rec.lc.handle({ tag: "draft-start", kind: "tweak", goalId: a.id });
	rec.lc.handle({ tag: "turn-stopped", goalId: a.id });
	rec.lc.handle({ tag: "tool-call", toolName: "get_goal", input: {} });
	rec.lc.handle({ tag: "dispose" });
	assert.equal(rec.lc.confirmationIntent, null);
	assert.equal(rec.lc.tweakDraftingFor, null);
	assert.equal(rec.lc.turnStoppedFor, null);
	assert.equal(rec.lc.goalWorkToolCalledThisTurn, false);
	assert.equal(rec.lc.getGoalNudgeCount(a.id), 0);
});

test("stale tweak gate: focus moves release it internally (no write-back port)", () => {
	const rec = makeLifecycle();
	const a = goal("sg-a");
	const b = goal("sg-b");
	seedFocused(rec, a, b);
	rec.lc.handle({ tag: "draft-start", kind: "tweak", goalId: a.id });
	rec.calls.length = 0;
	rec.lc.focus(b.id, ctx, "selected"); // focus moved to b: a's gate is stale
	assert.equal(rec.lc.tweakDraftingFor, null);
	rec.lc.handle({ tag: "draft-start", kind: "tweak", goalId: b.id });
	rec.calls.length = 0;
	rec.lc.setUserNote(ctx, "n"); // same-id setGoal path: gate kept
	assert.equal(rec.lc.tweakDraftingFor, b.id);
	assert.equal(rec.lc.focusedId, b.id);
	assert.ok(!rec.calls.some((c) => c.startsWith("gate:")));
});

// ---------- reconcileFromDisk (Step 4) + failure injection ----------

test("reconcileFromDisk: vanish path clears stale gate + halts; memory-usage merge keeps counters", () => {
	const rec = makeLifecycle();
	// An activePath-holding record whose disk file has gone away — the
	// orphan-memory branch (no activePath) would keep it instead.
	const a = { ...goal("rc-a"), activePath: ".pi/goals/active_goal_rc-a.md" };
	seedFocused(rec, a);
	rec.lc.handle({ tag: "draft-start", kind: "tweak", goalId: a.id });
	rec.calls.length = 0;
	// Disk pool no longer has the focused goal and the record holds an
	// activePath → the vanish branch: silent unfocus + halt + gate clear.
	rec.setDisk(new Map<string, GoalRecord>());
	assert.equal(rec.lc.reconcileFromDisk(ctx), false);
	assert.equal(rec.lc.focusedId, null);
	assert.equal(rec.lc.tweakDraftingFor, null, "vanish path clears the stale tweak gate");
	assert.ok(rec.calls.includes("halt"));
	assert.ok(rec.calls.includes("sync"));
	assert.ok(rec.calls.includes("ui"));

	// Separate lifecycle: focused + disk goal present + preserveMemoryUsage —
	// the merge branch keeps the memory-side monotonic usage counters.
	const rec2 = makeLifecycle();
	const mem = { ...goal("rc-a"), activePath: ".pi/goals/active_goal_rc-a.md", usage: { tokensUsed: 50, activeSeconds: 9, costUsed: 0 } };
	seedFocused(rec2, mem);
	const freshGoal = { ...mem, usage: { tokensUsed: 7, activeSeconds: 2, costUsed: 0 } };
	rec2.setDisk(new Map([[freshGoal.id, freshGoal]]));
	assert.equal(rec2.lc.reconcileFromDisk(ctx, { preserveMemoryUsage: true }), true);
	assert.equal(rec2.lc.focusedId, mem.id);
	assert.equal(rec2.lc.focused()!.usage.tokensUsed, 50, "memory usage survives the disk merge");
	// Vanish left no focus behind: a fresh reconcile only swaps the pool.
	assert.equal(rec.lc.reconcileFromDisk(ctx), true);
	assert.equal(rec.lc.focusedId, null, "no focus re-pick — focus resolution belongs to restore");
});

test("reconcileFromDisk orphan-memory branch keeps an activePath-less focused record", () => {
	const rec = makeLifecycle();
	// No activePath → the disk pool losing it must NOT unfocus (the record
	// only ever lived in memory; keep it focused in the fresh pool).
	const orphan = goal("orphan-no-path");
	seedFocused(rec, orphan);
	rec.setDisk(new Map<string, GoalRecord>()); // disk pool empty
	assert.equal(rec.lc.reconcileFromDisk(ctx), true);
	assert.equal(rec.lc.focusedId, orphan.id, "orphan memory goal stays focused");
	assert.ok(rec.lc.pool.has(orphan.id));
});

test("storage failure: a throwing archive port propagates out of terminate (old parity)", () => {
	// The pre-refactor archiveCurrentGoal called archiveGoalFile unwrapped —
	// an atomicWriteGoalFile failure crashed the clear/abort path mid-way.
	// The verb keeps that contract (spec §4.2: 与现状对拍; never report a
	// failed disk write as success), so we pin the PROPAGATION plus the
	// intermediate state (no unfocus, no ledger, no persist happened yet).
	const rec = makeLifecycle();
	rec.ports.archiveGoal = () => {
		throw new Error("disk full");
	};
	const a = goal("tf");
	seedFocused(rec, a);
	assert.throws(() => rec.lc.terminate("clear", ctx, { note: "n" }), /disk full/);
	assert.equal(rec.lc.focusedId, a.id, "no unfocus on a failed archive");
	assert.deepEqual(rec.calls.filter((c) => c.startsWith("ledger") || c === "write" || c.startsWith("state-entry") || c === "ui"), []);
});

test("storage failure: a throwing write port propagates out of applyTweak and persistRecord (old parity)", () => {
	const rec = makeLifecycle();
	rec.ports.writeActiveGoalFile = () => {
		throw new Error("disk full");
	};
	const a = goal("wf");
	seedFocused(rec, a);
	assert.throws(() => rec.lc.applyTweak(ctx, "=== Goal ===\nObjective: x"), /disk full/);
	assert.equal(rec.lc.focused()!.objective, a.objective, "no state change on a failed write");
	const rec2 = makeLifecycle();
	rec2.ports.writeActiveGoalFile = () => {
		throw new Error("disk full");
	};
	seedFocused(rec2, goal("wf2"));
	assert.throws(() => rec2.lc.persistRecord(ctx), /disk full/);
});

test("verbs survive a throwing ledger port (best-effort pinned)", () => {
	const rec = makeLifecycle();
	rec.ports.appendLedger = () => {
		throw new Error("ledger io");
	};
	const a = goal("lf");
	seedFocused(rec, a);
	assert.doesNotThrow(() => rec.lc.complete(a, ctx));
	assert.equal(rec.lc.focusedId, null);
	rec.calls.length = 0;
	seedFocused(rec, goal("lf2"));
	assert.doesNotThrow(() => rec.lc.terminate("abort", ctx, { by: "agent", reason: "r" }));
	assert.doesNotThrow(() => rec.lc.create({ objective: "=== Goal ===\nObjective: x", autoContinue: true, sisyphus: false }, ctx));
	assert.doesNotThrow(() => rec.lc.pause(ctx));
	assert.doesNotThrow(() => rec.lc.resume(ctx));
});
