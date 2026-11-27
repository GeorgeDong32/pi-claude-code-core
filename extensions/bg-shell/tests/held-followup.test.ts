import assert from "node:assert/strict";
import { after, afterEach, beforeEach, describe, it } from "node:test";

import {
	cleanup,
	type FakeProcesses,
	fakeClock,
	fakeProcesses,
	resetRegistry,
	restoreProcesses,
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

describe("completion follow-up while the agent is busy", () => {
	it("appends the status row at once, holds the message, and sends it on agent_settled", async () => {
		const s = session();
		await s.fire("agent_start", {});
		const id = await start(s, "echo hi");
		procs.of(id).exit(0);
		await clock.until(() => s.entries.length > 0);
		assert.equal(s.entries.length, 1);
		assert.equal(s.entries[0]!.type, "cc-core-bg-shell-task");
		assert.equal(s.sent.length, 0, "no follow-up while the run is active");
		await clock.tick(3);
		assert.equal(s.sent.length, 0, "still held after more poller ticks");
		await s.fire("agent_settled", {});
		assert.equal(s.sent.length, 1);
		assert.equal(s.sent[0]!.message.customType, "cc-core-bg-shell");
		assert.equal((s.sent[0]!.options as { triggerTurn?: boolean }).triggerTurn, true);
		assert.equal(s.entries.length, 1, "one row, one message");
	});

	it("drops the held message when the model read the end through TaskOutput first", async () => {
		const s = session();
		await s.fire("agent_start", {});
		const id = await start(s, "echo hi");
		procs.of(id).exit(0);
		await clock.until(() => s.entries.length > 0);
		const out = text(await s.toolCall("TaskOutput", { id }));
		assert.match(out, /exited \(code 0\)/);
		await s.fire("agent_settled", {});
		assert.equal(s.sent.length, 0, "the model already knows: no wake-up turn");
		assert.equal(s.entries.length, 1, "and no second row for the read");
	});

	it("a held send that throws stays held and goes out on the next settle", async () => {
		const s = session();
		await s.fire("agent_start", {});
		const id = await start(s, "echo hi");
		procs.of(id).exit(0);
		await clock.until(() => s.entries.length > 0);
		s.faults.failSend = true;
		await s.fire("agent_settled", {});
		assert.equal(s.sent.length, 0);
		s.faults.failSend = false;
		await s.fire("agent_start", {});
		await s.fire("agent_settled", {});
		assert.equal(s.sent.length, 1);
		assert.equal(s.entries.length, 1, "the row was never repeated");
	});

	it("shutdown drops what was held: no message leaks into the next session", async () => {
		const s = session();
		await s.fire("agent_start", {});
		const id = await start(s, "echo hi");
		procs.of(id).exit(0);
		await clock.until(() => s.entries.length > 0);
		await s.shutdown("quit");
		await s.fire("agent_settled", {});
		assert.equal(s.sent.length, 0);
	});

	it("control: with the agent idle the message goes out on the poller tick as before", async () => {
		const s = session();
		const id = await start(s, "echo hi");
		procs.of(id).exit(0);
		await clock.until(() => s.sent.length > 0);
		assert.equal(s.sent.length, 1);
		assert.equal(s.entries.length, 1);
		await s.fire("agent_settled", {});
		assert.equal(s.sent.length, 1, "nothing held, nothing re-sent");
	});
});

describe("completion batching", () => {
	const exits = (ids: string[]) => {
		for (const id of ids) procs.of(id).exit(0);
	};

	it("idle: three exits in one tick → one batch message, three rows, no single-message shape", async () => {
		const s = session();
		const ids = [await start(s, "echo one"), await start(s, "echo two", { description: "second" }), await start(s, "exit 3")];
		exits(ids.slice(0, 2));
		procs.of(ids[2]!).exit(3);
		await clock.until(() => s.sent.length > 0);
		await clock.tick(3);
		assert.equal(s.sent.length, 1, "one wake-up for the tick's completions");
		const { message, options } = s.sent[0]!;
		assert.match(message.content, /^Background tasks finished \(3\):\n/);
		const line = (id: string, who: string, code: number, command: string) =>
			new RegExp(`^- ${id}${who} · exited \\(code ${code}\\) · ran [\\d.]+s · ${command}$`, "m");
		assert.match(message.content, line(ids[0]!, "", 0, "echo one"));
		assert.match(message.content, line(ids[1]!, " \\(second\\)", 0, "echo two"));
		assert.match(message.content, line(ids[2]!, "", 3, "exit 3"));
		assert.match(message.content, new RegExp(`Output: read each with TaskOutput \\(id: ${ids.join(", ")}\\)\\.$`));
		assert.equal(message.customType, "cc-core-bg-shell");
		assert.equal(message.display, false);
		assert.deepEqual(message.details, {
			id: ids[0],
			ids,
			tasks: [
				{ id: ids[0], exitCode: 0, state: "exited" },
				{ id: ids[1], exitCode: 0, state: "exited" },
				{ id: ids[2], exitCode: 3, state: "exited" },
			],
			batch: true,
		});
		assert.equal((options as { deliverAs?: string }).deliverAs, "followUp");
		assert.equal((options as { triggerTurn?: boolean }).triggerTurn, true);
		assert.equal(s.entries.length, 3, "one row per task, appended after the successful send");
	});

	it("a single completion keeps the frozen shape: no batch fields, row after the send", async () => {
		const s = session();
		const id = await start(s, "echo only");
		s.faults.failSend = true;
		procs.of(id).exit(0);
		await clock.until(() => s.faults.sendAttempts >= 1);
		assert.equal(s.sent.length, 0);
		assert.equal(s.entries.length, 0, "the row goes out only with a successful send");
		s.faults.failSend = false;
		await clock.until(() => s.sent.length === 1);
		assert.equal(s.entries.length, 1);
		assert.deepEqual(s.sent[0]!.message.details, { id, exitCode: 0, state: "exited" });
		assert.match(s.sent[0]!.message.content, /^Background task bg-1 finished: exited \(code 0\), ran [\d.]+s\./);
	});

	it("busy: three exits during the run → one batch message on settle", async () => {
		const s = session();
		await s.fire("agent_start", {});
		const ids = [await start(s, "echo a"), await start(s, "echo b"), await start(s, "echo c")];
		exits(ids);
		await clock.until(() => s.entries.length === 3);
		assert.equal(s.sent.length, 0, "held while the run is active");
		await s.fire("agent_settled", {});
		assert.equal(s.sent.length, 1);
		assert.match(s.sent[0]!.message.content, /^Background tasks finished \(3\):/);
		assert.equal(s.entries.length, 3, "rows were already out; the flush adds none");
	});

	it("busy: a task the model read before settle leaves the batch", async () => {
		const s = session();
		await s.fire("agent_start", {});
		const ids = [await start(s, "echo a"), await start(s, "echo b"), await start(s, "echo c")];
		exits(ids);
		await clock.until(() => s.entries.length === 3);
		await s.toolCall("TaskOutput", { id: ids[1] });
		await s.fire("agent_settled", {});
		assert.equal(s.sent.length, 1);
		assert.deepEqual((s.sent[0]!.message.details as { ids: string[] }).ids, [ids[0], ids[2]]);
	});

	it("a failed batch send leaves every item pending: retried on the next tick, rows still once", async () => {
		const s = session();
		const ids = [await start(s, "echo a"), await start(s, "echo b")];
		s.faults.failSend = true;
		exits(ids);
		await clock.until(() => s.faults.sendAttempts >= 1);
		assert.equal(s.sent.length, 0);
		assert.equal(s.entries.length, 0);
		s.faults.failSend = false;
		await clock.until(() => s.sent.length === 1);
		await clock.tick(3);
		assert.equal(s.sent.length, 1, "not re-sent once delivered");
		assert.equal(s.entries.length, 2);
	});

	it("a stop after a failed batch send takes over the report: no completion, one row", async () => {
		const s = session();
		const id = await start(s, "echo done");
		s.faults.failSend = true;
		procs.of(id).write("done\n");
		procs.of(id).exit(0);
		await clock.until(() => s.faults.sendAttempts >= 1);
		assert.equal(s.entries.length, 0);
		s.faults.failSend = false;
		await clock.settle(s.toolCall("TaskStop", { id }));
		await clock.tick(3);
		assert.equal(s.sent.length, 0);
		const rows = s.entries.filter((e) => e.type === "cc-core-bg-shell-task");
		assert.equal(rows.length, 1);
		assert.equal((rows[0]!.data as { state: string }).state, "exited");
	});

	it("a deadline kill outside the poll flushes at once, not on the next tick", async () => {
		const s = session();
		const id = await start(s, "sleep 100", { timeout: 1 });
		await clock.tick(2);
		assert.equal(s.sent.length, 1);
		assert.match(s.sent[0]!.message.content, /killed \(timed out\)/);
	});
});
