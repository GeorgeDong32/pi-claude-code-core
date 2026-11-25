/*
 * Stall watchdog: no output growth for 45 s and a prompt-looking last line →
 * one nudge per task on its own channel (never `notified`), sent alone even
 * when completions are batched, dropped if the task ended before the flush.
 */
import assert from "node:assert/strict";
import { after, afterEach, beforeEach, describe, it } from "node:test";

import { getRegistry } from "../registry.ts";
import {
	cleanup,
	type FakeProcesses,
	fakeClock,
	fakeProcesses,
	resetRegistry,
	restoreProcesses,
	session,
	start,
} from "./harness.ts";

let clock: ReturnType<typeof fakeClock>;
let procs: FakeProcesses;

beforeEach(() => {
	procs = fakeProcesses();
	clock = fakeClock();
});
afterEach(() => {
	clock.restore();
	resetRegistry();
	restoreProcesses();
});
after(cleanup);

/** A poll tick is 2 s; the first tick records the output size, so 45 s of stillness lands inside 24 ticks. */
const STALL_TICKS = 24;

describe("stall watchdog", () => {
	it("45 s without growth + a prompt-looking last line → one nudge, no status row", async () => {
		const s = session();
		const id = await start(s, "npm init", { description: "init" });
		procs.of(id).write("This utility will walk you through creating a package.json file.\nContinue?\n");
		await clock.tick(STALL_TICKS);
		assert.equal(s.sent.length, 1);
		const { message, options } = s.sent[0]!;
		assert.equal(message.customType, "cc-core-bg-shell");
		assert.equal(message.display, false);
		assert.match(message.content, /^Background task bg-1 \(init\) appears to be waiting for interactive input \(no output for 45s\)\.\nLast output:\n/);
		assert.match(message.content, /Continue\?\n\nThe command is likely blocked on an interactive prompt\. Stop it with TaskStop \(id: bg-1\)/);
		assert.match(message.content, /TaskOutput \(id: bg-1\) reads more\.$/);
		assert.equal(message.details?.id, id);
		assert.equal(message.details?.state, "running");
		assert.equal(message.details?.stall, true);
		assert.equal("exitCode" in (message.details ?? {}) && message.details?.exitCode !== undefined, false);
		assert.equal((options as { deliverAs?: string }).deliverAs, "followUp");
		assert.equal((options as { triggerTurn?: boolean }).triggerTurn, true);
		assert.equal(s.entries.length, 0, "a nudge appends no row: rows are for ends");
	});

	it("a merely slow task whose last line is not a prompt stays silent, however long", async () => {
		const s = session();
		const id = await start(s, "cargo build");
		procs.of(id).write("Compiling core v1.0.0\n");
		await clock.tick(STALL_TICKS);
		await clock.tick(30);
		assert.equal(s.sent.length, 0);
	});

	it("output growth restarts the 45 s clock, even when the new last line is itself a prompt", async () => {
		const s = session();
		const id = await start(s, "sh setup");
		procs.of(id).write("Continue?\n");
		await clock.tick(20); // 40 s: 38 s after the first tick recorded the size
		assert.equal(s.sent.length, 0);
		procs.of(id).write("Continue?\n"); // growth at 40 s; the tail reads the same, only the clock restarts
		await clock.tick(4); // 48 s: 46 s after the first record, 6 s after the growth → silent
		assert.equal(s.sent.length, 0, "the stall clock restarted at the growth");
		await clock.tick(STALL_TICKS); // 45 s+ after the growth, no further output → reported
		assert.equal(s.sent.length, 1);
		assert.match(s.sent[0]!.message.content, /Continue\?/);
	});

	it("one nudge per task: still stalled 60 s later, nothing more", async () => {
		const s = session();
		const id = await start(s, "sh setup");
		procs.of(id).write("Continue?\n");
		await clock.tick(STALL_TICKS);
		assert.equal(s.sent.length, 1);
		await clock.tick(30);
		assert.equal(s.sent.length, 1);
	});

	it("the task ends after the nudge: the completion still goes out, with its row", async () => {
		const s = session();
		const id = await start(s, "sh setup");
		procs.of(id).write("Continue?\n");
		await clock.tick(STALL_TICKS);
		procs.of(id).exit(1);
		await clock.until(() => s.sent.length > 1);
		assert.equal(s.sent.length, 2);
		assert.match(s.sent[1]!.message.content, /^Background task bg-1 finished: exited \(code 1\)/);
		assert.equal(s.entries.length, 1);
	});

	it("busy: the nudge is held until agent_settled and never marks the task notified", async () => {
		const s = session();
		await s.fire("agent_start", {});
		const id = await start(s, "sh setup");
		procs.of(id).write("Continue?\n");
		await clock.tick(STALL_TICKS);
		assert.equal(s.sent.length, 0, "held while the run is active");
		assert.equal(getRegistry().tasks.get(id)?.notified, false);
		await s.fire("agent_settled", {});
		assert.equal(s.sent.length, 1);
		assert.match(s.sent[0]!.message.content, /waiting for interactive input/);
		procs.of(id).exit(0);
		await clock.until(() => s.sent.length > 1);
		assert.match(s.sent[1]!.message.content, /^Background task bg-1 finished: exited \(code 0\)/);
	});

	it("ended before the nudge flushes: the nudge is dropped and only the completion goes out", async () => {
		const s = session();
		await s.fire("agent_start", {});
		const id = await start(s, "sh setup");
		procs.of(id).write("Continue?\n");
		await clock.tick(STALL_TICKS); // nudge held
		procs.of(id).exit(0);
		await clock.until(() => s.entries.length === 1); // completion held too (row first)
		await s.fire("agent_settled", {});
		assert.equal(s.sent.length, 1);
		assert.match(s.sent[0]!.message.content, /^Background task bg-1 finished: exited \(code 0\)/);
	});

	it("one flush carries a stall and a completion for different tasks: the nudge first, the batch second", async () => {
		const s = session();
		await s.fire("agent_start", {});
		const stuck = await start(s, "sh setup");
		const quick = await start(s, "echo done");
		procs.of(stuck).write("Continue?\n");
		await clock.tick(STALL_TICKS); // nudge held
		procs.of(quick).exit(0);
		await clock.until(() => s.entries.length === 1); // completion held (row first)
		await s.fire("agent_settled", {});
		assert.equal(s.sent.length, 2);
		assert.match(s.sent[0]!.message.content, /^Background task bg-1 appears to be waiting for interactive input/);
		assert.match(s.sent[1]!.message.content, /^Background task bg-2 finished: exited \(code 0\)/);
	});
});
