/*
 * Held completion follow-ups: while an agent run is active the status row goes
 * out at once but the followUp message waits for agent_settled, and is dropped
 * when the model read the end itself first. Idle behaviour is unchanged.
 */
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
