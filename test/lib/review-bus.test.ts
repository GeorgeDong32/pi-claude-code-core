import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, beforeEach, afterEach } from "vitest";

import { FakeHost, clearCoreGlobals, restoreCoreGlobals, snapshotCoreGlobals } from "../contracts/fake-host.ts";
import { targets } from "../contracts/targets.ts";
import { coreBus } from "../../extensions/bus.ts";
import { resetRunCmd, setRunCmd } from "../../extensions/review/src/run-cmd.ts";
import { setConfigPath } from "../../extensions/review/src/config.ts";

const DIFF = "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n";

let globalsSnapshot: Record<string, unknown>;
let testCwd = "";
let cfgDir = "";

beforeEach(() => {
	globalsSnapshot = snapshotCoreGlobals();
	clearCoreGlobals();
	(globalThis as Record<string, unknown>).__piCcTui = { active: true, notificationsConsumer: false };
	testCwd = mkdtempSync(join(tmpdir(), "pi-review-bus-"));
	cfgDir = mkdtempSync(join(tmpdir(), "pi-review-bus-cfg-"));
	setConfigPath(join(cfgDir, "pi-review.json"));
});

afterEach(() => {
	delete (globalThis as Record<string, unknown>).__piCcTui;
	setConfigPath();
	resetRunCmd();
	if (testCwd) rmSync(testCwd, { recursive: true, force: true });
	if (cfgDir) rmSync(cfgDir, { recursive: true, force: true });
	testCwd = "";
	cfgDir = "";
	restoreCoreGlobals(globalsSnapshot);
});

function makeHost(withSubagent = true): FakeHost {
	const host = new FakeHost();
	if (withSubagent) {
		host.toolInfos.push({
			name: "subagent",
			sourceInfo: { path: "pi-subagents", source: "pi-subagents", scope: "user", origin: "top-level" },
		});
	}
	targets.review.factory(host.asPi());
	return host;
}

function dirtyTreeFake(): void {
	setRunCmd(async (cmd, args) => {
		if (cmd === "git" && args[0] === "status") return { stdout: " M x\n", stderr: "", exitCode: 0 };
		if (cmd === "git" && args[0] === "diff") return { stdout: DIFF, stderr: "", exitCode: 0 };
		if (cmd === "git" && args[0] === "rev-parse") return { stdout: "abc\n", stderr: "", exitCode: 0 };
		return { stdout: "", stderr: "", exitCode: 0 };
	});
}

function reviewStatus(): string {
	return coreBus().snapshot().review.status;
}

async function startLiveRun(host: FakeHost, ctx: Record<string, unknown>): Promise<void> {
	const handler = host.commands.get("review");
	if (!handler) throw new Error("review command not registered");
	dirtyTreeFake();
	await handler("", ctx);
	expect(reviewStatus()).toBe("running");
	expect(host.sentMessages.some((m) => m.message.customType === "pi-review-directive")).toBe(true);
}

describe("R11 — review bus reconciliation", () => {
	it("a live run whose agent turn ends without a report resets running → idle", async () => {
		const host = makeHost();
		const ctx = host.makeCtx({ cwd: testCwd, ui: true });
		await host.fire("session_start", {}, ctx);
		await startLiveRun(host, ctx);

		await host.fire("message_start", {
			message: { role: "custom", customType: "pi-review-directive", content: "x", display: false },
		}, ctx);
		await host.fire("agent_start", {}, ctx);
		await host.fire("agent_end", {}, ctx);
		expect(reviewStatus()).toBe("idle");
	});

	it("arming is keyed to the directive message, not any agent_start (CH-8b)", async () => {
		const host = makeHost();
		const ctx = host.makeCtx({ cwd: testCwd, ui: true });
		await host.fire("session_start", {}, ctx);
		await startLiveRun(host, ctx);

		await host.fire("agent_start", {}, ctx);
		await host.fire("agent_end", { messages: [] }, ctx);
		expect(reviewStatus()).toBe("running");

		await host.fire("message_start", {
			message: { role: "custom", customType: "pi-review-directive", content: "x", display: false },
		}, ctx);
		await host.fire("agent_end", { messages: [] }, ctx);
		expect(reviewStatus()).toBe("idle");
	});

	it("session_start resets a stale running status", async () => {
		const host = makeHost();
		coreBus().publish({ review: { status: "running", lastRunAt: null } });
		const ctx = host.makeCtx({ cwd: testCwd, ui: true });
		await host.fire("session_start", {}, ctx);
		expect(reviewStatus()).toBe("idle");
	});

	it("a new /review invocation resets residual running when no live run is tracked", async () => {
		const host = makeHost();
		coreBus().publish({ review: { status: "running", lastRunAt: null } });
		const ctx = host.makeCtx({ cwd: testCwd, ui: true });
		await host.fire("session_start", {}, ctx);
		resetRunCmd();
		const handler = host.commands.get("review");
		if (!handler) throw new Error("review command not registered");
		await handler("", ctx);
		expect(reviewStatus()).toBe("idle");
	});

	it("done stays done: a landed report is not clobbered by the closing agent_end", async () => {
		const host = makeHost();
		const ctx = host.makeCtx({ cwd: testCwd, ui: true });
		await host.fire("session_start", {}, ctx);
		await startLiveRun(host, ctx);

		coreBus().publish({ review: { status: "done", lastRunAt: Date.now() } });
		await host.fire("agent_start", {}, ctx);
		await host.fire("agent_end", {}, ctx);
		expect(reviewStatus()).toBe("done");
	});

	it("a queued directive is NOT spuriously reset by the previous run's agent_end", async () => {
		const host = makeHost();
		const ctx = host.makeCtx({ cwd: testCwd, ui: true });
		await host.fire("session_start", {}, ctx);

		await startLiveRun(host, ctx);
		await host.fire("message_start", {
			message: { role: "custom", customType: "pi-review-directive", content: "x", display: false },
		}, ctx);
		await host.fire("agent_start", {}, ctx);
		await host.fire("agent_end", {}, ctx);
		expect(reviewStatus()).toBe("idle");

		await startLiveRun(host, ctx);
		await host.fire("agent_end", {}, ctx);
		expect(reviewStatus()).toBe("running");
		await host.fire("message_start", {
			message: { role: "custom", customType: "pi-review-directive", content: "x", display: false },
		}, ctx);
		await host.fire("agent_start", {}, ctx);
		await host.fire("agent_end", {}, ctx);
		expect(reviewStatus()).toBe("idle");
	});
});
