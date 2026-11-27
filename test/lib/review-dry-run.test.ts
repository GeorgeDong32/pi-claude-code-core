import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, beforeEach, afterEach } from "vitest";

import { FakeHost, clearCoreGlobals, restoreCoreGlobals, snapshotCoreGlobals } from "../contracts/fake-host.ts";
import { targets } from "../contracts/targets.ts";
import { defaultRunCmd, resetRunCmd, setRunCmd, type RunCmd } from "../../extensions/review/src/run-cmd.ts";
import { setConfigPath } from "../../extensions/review/src/config.ts";

const PR_URL = "https://github.com/o/r/pull/77";
const DIFF = "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n";

let globalsSnapshot: Record<string, unknown>;
let testCwd = "";
let cfgDir = "";

beforeEach(() => {
	globalsSnapshot = snapshotCoreGlobals();
	clearCoreGlobals();
	(globalThis as Record<string, unknown>).__piCcTui = { active: true, notificationsConsumer: false };
	testCwd = mkdtempSync(join(tmpdir(), "pi-review-dryrun-"));
	cfgDir = mkdtempSync(join(tmpdir(), "pi-review-dryrun-cfg-"));
	writeFileSync(join(cfgDir, "pi-review.json"), JSON.stringify({ schemaVersion: 1 }), "utf-8");
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

const ghOnlyDryRun: RunCmd = async (cmd, args) => {
	if (cmd === "gh" && args[0] === "pr" && args[1] === "view") {
		return {
			stdout: JSON.stringify({ number: "77", baseRefName: "main", baseRefOid: "aaa", headRefOid: "bbb" }),
			stderr: "",
			exitCode: 0,
		};
	}
	if (cmd === "gh" && args[0] === "pr" && args[1] === "diff") {
		return { stdout: DIFF, stderr: "", exitCode: 0 };
	}
	if (cmd === "git" && (args[0] === "clone" || args[0] === "fetch")) {
		throw new Error(`dry run must not run git ${args[0]}`);
	}
	return defaultRunCmd(cmd, args, { cwd: process.cwd() });
};

describe("R12 — PR dry run is metadata-only", () => {
	it("/review --no-spawn <PR> renders 'not cloned (dry run)' without any clone/fetch", async () => {
		const host = new FakeHost();
		host.toolInfos.push({
			name: "subagent",
			sourceInfo: { path: "pi-subagents", source: "pi-subagents", scope: "user", origin: "top-level" },
		});
		targets.review.factory(host.asPi());
		const calls: string[] = [];
		setRunCmd(async (cmd, args, opts) => {
			calls.push(`${cmd} ${args.slice(0, 2).join(" ")}`);
			return ghOnlyDryRun(cmd, args, opts);
		});
		const ctx = host.makeCtx({ cwd: testCwd, ui: true });
		await host.fire("session_start", {}, ctx);

		const handler = host.commands.get("review");
		if (!handler) throw new Error("review command not registered");
		await handler(`--no-spawn ${PR_URL}`, ctx);

		const echoes = host.sentMessages.filter((m) => m.message.customType === "pi-review");
		expect(echoes.length).toBeGreaterThan(0);
		const dryRunText = echoes.map((m) => String(m.message.content)).join("\n");
		expect(dryRunText).toContain("workspace: not cloned (dry run)");
		expect(dryRunText).toContain("historyAvailable: not computed (dry run)");
		expect(dryRunText).toContain("rules: not computed (dry run)");
		expect(calls.some((c) => c === "gh pr view")).toBe(true);
		expect(calls.some((c) => c === "gh pr diff")).toBe(true);
		expect(calls.some((c) => c.startsWith("git clone") || c.startsWith("git fetch"))).toBe(false);
	});
});
