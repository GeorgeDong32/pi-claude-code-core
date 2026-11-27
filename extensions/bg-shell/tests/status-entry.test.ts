import assert from "node:assert/strict";
import { after, afterEach, beforeEach, describe, it } from "node:test";

import { appendStatusEntry, STATUS_ENTRY_TYPE, statusData, type TaskStatusData } from "../status-entry.ts";
import type { Task } from "../registry.ts";

import {
	cleanup,
	fakeClock,
	fakeProcesses,
	resetRegistry,
	restoreProcesses,
	session,
	start,
} from "./harness.ts";

let clock: ReturnType<typeof fakeClock>;
let procs: ReturnType<typeof fakeProcesses>;
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

const fakeTask = (over: Partial<Task> = {}): Task =>
	({ id: "bg-9", command: "echo hi", state: "exited", exitCode: 0, startedAt: 1_000, endedAt: 5_000, notified: true, ...over } as unknown as Task);

describe("status entry lifecycle through the real orchestration", () => {
	it("a completion appends exactly one entry with the task's data", async () => {
		const s = session();
		const id = await start(s, "echo one");
		procs.of(id).write("one\n");
		procs.of(id).exit(0);
		await clock.until(() => s.sent.length > 0);
		await clock.tick(2);
		assert.equal(s.entries.length, 1);
		assert.equal(s.entries[0]!.type, STATUS_ENTRY_TYPE);
		const data = s.entries[0]!.data as TaskStatusData;
		assert.equal(data.id, id);
		assert.equal(data.state, "exited");
		assert.equal(data.exitCode, 0);
	});

	it("a user kill appends a stopped row even without a completion message", async () => {
		const s = session();
		const id = await start(s, "sleep 30");
		await clock.settle(s.toolCall("TaskStop", { id }));
		await clock.tick(2);
		assert.equal(s.sent.length, 0);
		assert.ok(s.entries.length >= 1, "a stopped row was appended");
		assert.equal((s.entries[0]!.data as TaskStatusData).state, "killed");
	});

	it("CH E5: stopping an already-finished exit-0 task appends its real end state, once", async () => {
		const s = session();
		const id = await start(s, "echo one");
		procs.of(id).write("one\n");
		procs.of(id).exit(0);
		await clock.settle(s.toolCall("TaskStop", { id }));
		await clock.tick(3);
		assert.equal(s.sent.length, 0);
		assert.equal(s.entries.length, 1, "exactly one status row for the finished task");
		const data = s.entries[0]!.data as TaskStatusData;
		assert.notEqual(data.state, "killed");
		assert.equal(data.state, "exited");
		assert.equal(data.exitCode, 0);
	});

	it("CH E5: stopping an already-notified finished task appends no second row", async () => {
		const s = session();
		const id = await start(s, "echo one");
		procs.of(id).write("one\n");
		procs.of(id).exit(0);
		await clock.until(() => s.sent.length > 0);
		await clock.tick(3);
		assert.equal(s.entries.length, 1, "the completion appended one row");
		await clock.settle(s.toolCall("TaskStop", { id }));
		await clock.tick(3);
		assert.equal(s.entries.length, 1, "a second stop on a finished task appends nothing");
		assert.equal((s.entries[0]!.data as TaskStatusData).state, "exited");
	});

	it("CH-6: two concurrent TaskStops on one running task append exactly one killed row", async () => {
		const s = session();
		const id = await start(s, "sleep 30");
		await Promise.all([clock.settle(s.toolCall("TaskStop", { id })), clock.settle(s.toolCall("TaskStop", { id }))]);
		await clock.tick(3);
		assert.equal(s.sent.length, 0);
		const rows = s.entries.filter((e) => e.type === STATUS_ENTRY_TYPE);
		assert.equal(rows.length, 1, "exactly one killed row for the joined kill");
		assert.equal((rows[0]!.data as TaskStatusData).state, "killed");
	});

	it("CH-6: after a failed send, a user stop pins the one row to the real end state and no message follows", async () => {
		const s = session();
		s.faults.failSend = true;
		const id = await start(s, "echo done");
		procs.of(id).write("done\n");
		procs.of(id).exit(0);
		await clock.until(() => s.faults.sendAttempts >= 1);
		assert.equal(s.sent.length, 0);
		assert.equal(s.entries.length, 0);
		s.faults.failSend = false;
		await clock.settle(s.toolCall("TaskStop", { id }));
		await clock.tick(3);
		assert.equal(s.sent.length, 0, "no completion message after the fault cleared");
		const rows = s.entries.filter((e) => e.type === STATUS_ENTRY_TYPE);
		assert.equal(rows.length, 1, "exactly one status row");
		assert.equal((rows[0]!.data as TaskStatusData).state, "exited", "the row keeps the real end state");
		assert.equal((rows[0]!.data as TaskStatusData).exitCode, 0);
	});

	it("appendStatusEntry is fail-open: a throwing appendEntry never propagates", () => {
		const pi = { appendEntry: () => { throw new Error("session closed"); } } as never;
		appendStatusEntry(pi, fakeTask());
	});
});
