import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, beforeEach, afterEach } from "vitest";

import {
	FakeHost,
	clearCoreGlobals,
	restoreCoreGlobals,
	snapshotCoreGlobals,
} from "../contracts/fake-host.ts";
import { targets } from "../contracts/targets.ts";
import { defaultRunCmd, resetRunCmd, setRunCmd, type RunCmd } from "../../extensions/review/src/run-cmd.ts";

let globalsSnapshot: Record<string, unknown>;
let testCwd = "";

beforeEach(() => {
	globalsSnapshot = snapshotCoreGlobals();
	clearCoreGlobals();
	(globalThis as Record<string, unknown>).__piCcTui = CCTUI_LIVE;
	testCwd = mkdtempSync(join(tmpdir(), "pi-review-degradation-"));
});

afterEach(() => {
	delete (globalThis as Record<string, unknown>).__piCcTui;
	if (testCwd) {
		rmSync(testCwd, { recursive: true, force: true });
		testCwd = "";
	}
});

function makeReviewHost(): FakeHost {
	const host = new FakeHost();
	targets.review.factory(host.asPi());
	return host;
}

async function runReview(host: FakeHost, ctx: Record<string, unknown>, args = ""): Promise<void> {
	const handler = host.commands.get("review");
	if (!handler) throw new Error("review command not registered");
	await handler(args, ctx);
}

function makeRunCmdSpy(): { calls: Array<{ cmd: string; args: string[] }>; fn: RunCmd } {
	const calls: Array<{ cmd: string; args: string[] }> = [];
	const fn: RunCmd = (cmd, args, opts) => {
		calls.push({ cmd, args });
		return defaultRunCmd(cmd, args, opts);
	};
	return { calls, fn };
}

function expectNoGitFetch(calls: Array<{ cmd: string; args: string[] }>): void {
	expect(calls.filter((c) => c.cmd === "git" && c.args[0] === "fetch")).toEqual([]);
}


const CCTUI_LIVE = { active: true, notificationsConsumer: false } as const;
describe("P2-REV-03 pi-subagents degradation", () => {
	it("without the subagent tool, /review refuses with the install hint and no directive", async () => {
		const host = makeReviewHost();
		const spy = makeRunCmdSpy();
		setRunCmd(spy.fn);
		try {
			const ctx = host.makeCtx({ cwd: testCwd, ui: true });
			await host.fire("session_start", {}, ctx);

			await runReview(host, ctx);

			const directive = host.sentMessages.find(
				(m) => m.message.customType === "pi-review-directive",
			);
			expect(directive).toBeUndefined();
			const warned = host.notifications.filter((n) => n.includes("pi-subagents"));
			expect(warned.length).toBeGreaterThan(0);
			expect(warned[0]).toContain("pi install npm:pi-subagents");
			expectNoGitFetch(spy.calls);
		} finally {
			resetRunCmd();
		}
	});

	it("the degradation notice is shown at most once, later calls still refuse", async () => {
		const host = makeReviewHost();
		const spy = makeRunCmdSpy();
		setRunCmd(spy.fn);
		try {
			const ctx = host.makeCtx({ cwd: testCwd, ui: true });
			await host.fire("session_start", {}, ctx);
			await runReview(host, ctx);
			await runReview(host, ctx);

			const hints = host.notifications.filter((n) => n.includes("pi install npm:pi-subagents"));
			expect(hints.length).toBe(1);
			const skips = host.notifications.filter((n) => n.includes("review skipped"));
			expect(skips.length).toBe(2);
			expect(
				host.sentMessages.filter((m) => m.message.customType === "pi-review-directive"),
			).toHaveLength(0);
			expectNoGitFetch(spy.calls);
		} finally {
			resetRunCmd();
		}
	});

	it("with the subagent tool present, /review proceeds past the gate", async () => {
		const host = makeReviewHost();
		host.toolInfos.push({
			name: "subagent",
			sourceInfo: { path: "pi-subagents", source: "pi-subagents", scope: "user", origin: "top-level" },
		});
		const spy = makeRunCmdSpy();
		setRunCmd(spy.fn);
		try {
			const ctx = host.makeCtx({ cwd: testCwd, ui: true });
			await host.fire("session_start", {}, ctx);

			await runReview(host, ctx);
			expect(host.notifications.filter((n) => n.includes("pi install npm:pi-subagents"))).toHaveLength(0);
			expectNoGitFetch(spy.calls);
		} finally {
			resetRunCmd();
		}
	});
});
