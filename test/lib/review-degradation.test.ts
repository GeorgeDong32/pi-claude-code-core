/**
 * P2-REV-03 — pi-subagents degradation path (red-green).
 *
 * Without the `subagent` tool: /review must fail fast with the install
 * hint (one-time notify) and NOT inject a review directive. All other core
 * functionality is unaffected. With the tool present, /review proceeds
 * past the gate.
 *
 * D-FX-1 (2026-11-14): every case runs in an isolated mkdtemp cwd — never
 * the real repo. On a clean real-repo tree the past-the-gate path runs
 * `git fetch origin <base>` in acquireLocalDiff (5-6s locally, > the
 * vitest 5s test timeout — BH-10 / #131). A recording spy wraps the REAL
 * defaultRunCmd and asserts no `git fetch` escapes into the host
 * environment; the injector is reset in finally (run-cmd test discipline).
 */
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
	(globalThis as Record<string, unknown>).__piCcTui = CCTUI_LIVE; // C2: host-notify leg (after globals reset)
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

/** Recording spy around the REAL defaultRunCmd — observation only, no behavior change. */
function makeRunCmdSpy(): { calls: Array<{ cmd: string; args: string[] }>; fn: RunCmd } {
	const calls: Array<{ cmd: string; args: string[] }> = [];
	const fn: RunCmd = (cmd, args, opts) => {
		calls.push({ cmd, args });
		return defaultRunCmd(cmd, args, opts);
	};
	return { calls, fn };
}

/** D-FX-1: the isolated test cwd must never reach the host's network —
 *  a `git fetch` here means the case leaked outside its sandbox. */
function expectNoGitFetch(calls: Array<{ cmd: string; args: string[] }>): void {
	expect(calls.filter((c) => c.cmd === "git" && c.args[0] === "fetch")).toEqual([]);
}


// C2: these assertions observe the host-notify leg of the shared notify
// entry, which only fires when a cctui replica is live without its own
// queue consumer (the transitional channel). Plant that state.
const CCTUI_LIVE = { active: true, notificationsConsumer: false } as const;
describe("P2-REV-03 pi-subagents degradation", () => {
	it("without the subagent tool, /review refuses with the install hint and no directive", async () => {
		const host = makeReviewHost(); // toolInfos empty → subagent missing
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

			// install hint exactly once; the skip error on every refused call
			const hints = host.notifications.filter((n) => n.includes("pi install npm:pi-subagents"));
			expect(hints.length).toBe(1);
			const skips = host.notifications.filter((n) => n.includes("review skipped"));
			expect(skips.length).toBe(2);
			// still no directive on either call
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
			// past the gate: no degradation warning; the run may end in "nothing
			// to review" or a dry-run echo, but never the install hint
			expect(host.notifications.filter((n) => n.includes("pi install npm:pi-subagents"))).toHaveLength(0);
			// D-FX-1: the non-repo sandbox never reaches the base fetch.
			expectNoGitFetch(spy.calls);
		} finally {
			resetRunCmd();
		}
	});
});
