/**
 * B7 step 1 (arch): the continuation loop state machine, driven directly —
 * the loop's turn sequence was previously assertable only through the full
 * FakeHost statemachine harness (which keeps pinning the wiring, zero
 * changes). Flat node:test.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { createContinuationLoop, type ContinuationDeps, type ContinuationProbe } from "../goal-continuation.ts";
import type { GoalRecord } from "../goal-record.ts";

function goal(overrides: Partial<GoalRecord> = {}): GoalRecord {
	return {
		id: "g1",
		status: "active",
		autoContinue: true,
		objective: "ship it",
	} as unknown as GoalRecord;
}

interface Harness {
	deps: ContinuationDeps;
	probe: ContinuationProbe;
	sent: Array<{ prompt: string; goalId: string }>;
	dispatches: number;
}

function harness(overrides: Partial<ContinuationDeps> = {}, probeOverrides: Partial<ContinuationProbe> = {}): Harness {
	const sent: Array<{ prompt: string; goalId: string }> = [];
	let dispatches = 0;
	const deps: ContinuationDeps = {
		getGoal: () => goal(),
		isDrafting: () => false,
		isSubagentChild: () => false,
		promptFor: (g) => `next: ${g.objective}`,
		sendFollowUp: (prompt, g) => {
			sent.push({ prompt, goalId: g.id });
		},
		onDispatch: () => {
			dispatches += 1;
		},
		...overrides,
	};
	const probe: ContinuationProbe = {
		isIdle: () => true,
		hasPendingMessages: () => false,
		...probeOverrides,
	};
	return { deps, probe, sent, dispatches };
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 5));

test("idle probe: queue dispatches the follow-up once (delay 0)", async () => {
	const h = harness();
	const loop = createContinuationLoop(h.deps);
	loop.queue(h.probe);
	await tick();
	assert.equal(h.sent.length, 1);
	assert.equal(h.sent[0]?.prompt, "next: ship it");
	assert.equal(loop.queuedFor, "g1");
	assert.equal(loop.scheduledFor, null);
});

test("gates: drafting sessions, subagent children, and inactive goals never arm", async () => {
	{
		const h = harness({ isDrafting: () => true });
		const loop = createContinuationLoop(h.deps);
		loop.queue(h.probe);
		await tick();
		assert.equal(h.sent.length, 0);
	}
	{
		const h = harness({ isSubagentChild: () => true });
		const loop = createContinuationLoop(h.deps);
		loop.queue(h.probe);
		await tick();
		assert.equal(h.sent.length, 0);
	}
	{
		const h = harness({ getGoal: () => ({ ...goal(), status: "paused" } as GoalRecord) });
		const loop = createContinuationLoop(h.deps);
		loop.queue(h.probe);
		await tick();
		assert.equal(h.sent.length, 0);
	}
});

test("busy probe retries until idle, then dispatches", async () => {
	const h = harness({}, { isIdle: () => false });
	const loop = createContinuationLoop(h.deps, 10);
	loop.queue(h.probe);
	await tick();
	assert.equal(h.sent.length, 0, "busy: no dispatch yet");
	assert.equal(loop.scheduledFor, "g1");
	h.probe.isIdle = () => true; // becomes idle
	await new Promise<void>((resolve) => setTimeout(resolve, 25));
	assert.equal(h.sent.length, 1);
});

test("goal replaced before dispatch: the send is dropped, queued marker cleared", async () => {
	let current = goal();
	const h = harness({ getGoal: () => current });
	const loop = createContinuationLoop(h.deps);
	loop.queue(h.probe);
	// swap the goal out from under the scheduled send
	current = { ...goal({}), id: "g2" } as GoalRecord;
	await tick();
	assert.equal(h.sent.length, 0);
	assert.equal(loop.queuedFor, null);
});

test("duplicate queue without force is a no-op; force re-arms", async () => {
	const h = harness();
	const loop = createContinuationLoop(h.deps);
	loop.queue(h.probe, true);
	await tick();
	assert.equal(h.sent.length, 1);
	loop.queue(h.probe); // queuedFor === g1 -> dropped
	await tick();
	assert.equal(h.sent.length, 1);
	loop.queue(h.probe, true);
	await tick();
	assert.equal(h.sent.length, 2);
});

test("halt and stopTimer: full stop vs timer-only", async () => {
	const h = harness();
	const loop = createContinuationLoop(h.deps, 10);
	loop.queue(h.probe);
	loop.halt();
	await new Promise<void>((resolve) => setTimeout(resolve, 25));
	assert.equal(h.sent.length, 0);
	assert.equal(loop.queuedFor, null);

	loop.queue(h.probe);
	loop.stopTimer();
	await new Promise<void>((resolve) => setTimeout(resolve, 25));
	assert.equal(h.sent.length, 0);
	assert.equal(loop.queuedFor, null, "stopTimer also drops nothing queued — nothing was dispatched");
});

test("clearQueued re-arms the loop for a fresh queue (turn-end path)", async () => {
	const h = harness();
	const loop = createContinuationLoop(h.deps);
	loop.queue(h.probe);
	await tick();
	assert.equal(h.sent.length, 1);
	loop.queue(h.probe); // queued marker blocks
	await tick();
	assert.equal(h.sent.length, 1);
	loop.clearQueued();
	loop.queue(h.probe);
	await tick();
	assert.equal(h.sent.length, 2);
});
