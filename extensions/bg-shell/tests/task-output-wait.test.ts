// Behaviour tier: TaskOutput's optional blocking wait (SPEC SR, E4). `block`
// waits for the task to end (seconds budget, default 30, cap 600); a user
// message ends the wait early; an aborted call reads nothing and leaves the
// completion to the poller; a plain read of a finished task claims the
// completion WITH the status row and gzip now (BG-ENTRY-03) — the red this
// batch fixes. Fake processes + fake time, like background.test.ts.
import assert from "node:assert/strict";
import { after, afterEach, beforeEach, describe, it } from "node:test";

import { getRegistry } from "../registry.ts";

import {
	cleanup,
	type FakeProcesses,
	fakeClock,
	fakeProcesses,
	gzipped,
	resetRegistry,
	restoreProcesses,
	type Session,
	session,
	start,
	text,
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

const statusEntry = (s: Session) => s.entries.find((e) => e.type === "cc-core-bg-shell-task");

describe("a plain TaskOutput read of a finished task (E4 claim)", () => {
	it("between exit and the next poll tick it claims the completion WITH the status row and the gzip (BG-ENTRY-03)", async () => {
		const s = session();
		const id = await start(s, "echo done");
		procs.of(id).write("done\n");
		procs.of(id).exit(0);
		// The read lands before any poller tick: the marker is in the log, the
		// registry has not settled. The read itself claims the completion — the
		// status row included, like every other completion the user sees.
		const output = text(await s.toolCall("TaskOutput", { id }));
		assert.match(output, /Task bg-\d+: exited \(code 0\)\.\ndone/);
		assert.equal(s.sent.length, 0); // no completion message: the read is the report
		const entry = statusEntry(s);
		assert.ok(entry, "expected a cc-core-bg-shell-task status entry");
		assert.equal((entry.data as { state: string }).state, "exited");
		assert.equal((entry.data as { exitCode: number }).exitCode, 0);
		await clock.tick(2); // the poller agrees: nothing left to send
		assert.equal(s.sent.length, 0);
		await clock.until(() => gzipped(s, id));
	});

	it("of a still-running task claims nothing", async () => {
		const s = session();
		const id = await start(s, "sleep 30");
		procs.of(id).write("partial\n");
		const output = text(await s.toolCall("TaskOutput", { id }));
		assert.match(output, /running\.\npartial/);
		assert.equal(statusEntry(s), undefined);
		assert.equal(getRegistry().tasks.get(id)?.notified, false);
		await clock.tick(1);
		assert.equal(s.sent.length, 0); // the poller still owes the completion
	});
});

describe("TaskOutput with block: true", () => {
	it("waits until the task ends, returns the output and claims the completion — no followUp is ever sent", async () => {
		const s = session();
		const id = await start(s, "echo done");
		procs.of(id).write("done\n");
		const call = s.toolCall("TaskOutput", { id, block: true });
		assert.equal(getRegistry().tasks.get(id)?.waiting, 1); // the call is blocked on the task
		procs.of(id).exit(0);
		const output = text(await clock.settle(call));
		assert.match(output, /Task bg-\d+: exited \(code 0\)\.\ndone/);
		assert.equal(s.sent.length, 0); // the waiter claimed it
		const entry = statusEntry(s);
		assert.ok(entry);
		await clock.tick(3);
		assert.equal(s.sent.length, 0);
	});

	it("returns at once for an already-finished task, claiming as a plain read does", async () => {
		const s = session();
		const id = await start(s, "echo done");
		procs.of(id).write("done\n");
		procs.of(id).exit(0);
		const output = text(await clock.settle(s.toolCall("TaskOutput", { id, block: true })));
		assert.match(output, /exited \(code 0\)\.\ndone/);
		assert.equal(s.sent.length, 0);
		assert.ok(statusEntry(s));
	});

	it("a poller tick while the wait is in flight sends no completion followUp", async () => {
		const s = session();
		const id = await start(s, "echo done");
		const call = s.toolCall("TaskOutput", { id, block: true });
		procs.of(id).exit(0);
		await clock.tick(1); // the poller sees the exit while the waiter holds the task
		assert.equal(s.sent.length, 0);
		const output = text(await clock.settle(call));
		assert.match(output, /exited \(code 0\)/);
		await clock.tick(3);
		assert.equal(s.sent.length, 0);
	});

	it("times out while the task still runs: the note names the seconds, the completion is not lost", async () => {
		const s = session();
		const id = await start(s, "sleep 30");
		procs.of(id).write("partial\n");
		const output = text(await clock.settle(s.toolCall("TaskOutput", { id, block: true, timeout: 2 })));
		assert.match(output, /partial/);
		assert.match(output, /\[still running after 2 s\]$/);
		assert.equal(getRegistry().tasks.get(id)?.notified, false);
		// The task keeps running; the poller reports it normally when it ends.
		procs.of(id).exit(0);
		await clock.until(() => s.sent.length > 0);
		assert.match(s.sent[0].message.content, /exited \(code 0\)/);
	});

	it("defaults to a 30 s budget when only block is given", async () => {
		const s = session();
		const id = await start(s, "sleep 60");
		const output = text(await clock.settle(s.toolCall("TaskOutput", { id, block: true })));
		assert.match(output, /\[still running after 30 s\]$/);
		assert.equal(s.sent.length, 0);
	});

	it("a deadline kill during the wait is claimed by the waiter, not the poller", async () => {
		const s = session();
		const id = await start(s, "sleep 30", { timeout: 2 }); // the task's own deadline
		procs.of(id).write("dying\n");
		const call = s.toolCall("TaskOutput", { id, block: true }); // waits up to 30 s
		const output = text(await clock.settle(call));
		assert.match(output, /killed \(timed out\)/);
		assert.match(output, /dying/);
		assert.equal(s.sent.length, 0); // the kill's completion was claimed, not sent
		await clock.tick(3);
		assert.equal(s.sent.length, 0);
	});

	it("aborting the call reads nothing and leaves read position and notification untouched; the completion still arrives", async () => {
		const s = session();
		const id = await start(s, "echo done");
		procs.of(id).write("hello\n");
		const controller = new AbortController();
		const call = s.toolCall("TaskOutput", { id, block: true }, controller.signal);
		controller.abort();
		await assert.rejects(call, /^Error: aborted$/);
		const task = getRegistry().tasks.get(id);
		assert.equal(task?.readPosition, 0);
		assert.equal(task?.notified, false);
		procs.of(id).exit(0);
		await clock.until(() => s.sent.length > 0);
		assert.match(s.sent[0].message.content, /exited \(code 0\)/);
		// Nothing was consumed by the aborted read: it all comes in one piece now.
		assert.match(text(await s.toolCall("TaskOutput", { id })), /^Task bg-\d+: exited \(code 0\)\.\nhello$/);
	});

	it("a user message ends the wait with the output so far, without error", async () => {
		const s = session();
		const id = await start(s, "sleep 30");
		procs.of(id).write("so far\n");
		const call = s.toolCall("TaskOutput", { id, block: true });
		assert.equal(getRegistry().tasks.get(id)?.waiting, 1);
		await s.fire("input", {
			type: "input",
			text: "how is it going?",
			source: "interactive",
			streamingBehavior: "steer",
		});
		const output = text(await clock.settle(call));
		assert.match(output, /^Task bg-\d+: running\.\nso far$/);
		assert.doesNotMatch(output, /still running|aborted/);
		assert.equal(getRegistry().tasks.get(id)?.notified, false); // still running: the poller owes the completion
		procs.of(id).exit(0);
		await clock.until(() => s.sent.length > 0);
	});

	it("a user message ending the wait claims the completion when the task ended meanwhile", async () => {
		const s = session();
		const id = await start(s, "echo done");
		procs.of(id).write("done\n");
		const call = s.toolCall("TaskOutput", { id, block: true });
		procs.of(id).exit(0);
		await s.fire("input", {
			type: "input",
			text: "never mind",
			source: "rpc",
			streamingBehavior: "followUp",
		});
		const output = text(await clock.settle(call));
		assert.match(output, /exited \(code 0\)/);
		assert.equal(s.sent.length, 0); // claimed, not sent
		assert.ok(statusEntry(s));
	});

	it("extension-sourced input does not end the wait", async () => {
		const s = session();
		const id = await start(s, "sleep 30");
		const call = s.toolCall("TaskOutput", { id, block: true, timeout: 5 });
		assert.equal(getRegistry().tasks.get(id)?.waiting, 1);
		await s.fire("input", { type: "input", text: "bg", source: "extension", streamingBehavior: "steer" });
		const output = text(await clock.settle(call));
		assert.match(output, /\[still running after 5 s\]$/);
	});
});

describe("TaskOutput block/timeout validation", () => {
	it("a timeout over 600 s throws instead of clamping", async () => {
		const s = session();
		const id = await start(s, "sleep 30");
		await assert.rejects(
			() => s.toolCall("TaskOutput", { id, block: true, timeout: 601 }),
			/^Error: timeout is in seconds \(not ms\); maximum is 600$/,
		);
	});

	it("a timeout without block: true throws", async () => {
		const s = session();
		const id = await start(s, "sleep 30");
		await assert.rejects(() => s.toolCall("TaskOutput", { id, timeout: 30 }), /timeout applies only with block: true/);
	});

	it("an unknown id throws at once, blocking or not", async () => {
		const s = session();
		await assert.rejects(() => s.toolCall("TaskOutput", { id: "bg-99" }), /Unknown task id: bg-99/);
		await assert.rejects(() => s.toolCall("TaskOutput", { id: "bg-99", block: true }), /Unknown task id: bg-99/);
	});
});
