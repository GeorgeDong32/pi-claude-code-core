// BG-ENTRY-03: the user-visible task status row — CC task_status attachment
// parity. Every completion appends a display-only session entry (never sent to
// the LLM), and the registered renderer draws the CC GenericTaskStatus shape:
// `⏺ Task "cmd" completed in background` in dim, before the agent's response.
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
		assert.equal(s.sent.length, 0); // no completion message on a user stop
		assert.ok(s.entries.length >= 1, "a stopped row was appended");
		assert.equal((s.entries[0]!.data as TaskStatusData).state, "killed");
	});

	it("appendStatusEntry is fail-open: a throwing appendEntry never propagates", () => {
		const pi = { appendEntry: () => { throw new Error("session closed"); } } as never;
		appendStatusEntry(pi, fakeTask()); // must not throw
	});
});
