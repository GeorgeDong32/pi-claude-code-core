/**
 * P0-CT §4.2 — env / subagent-forwarding contracts (P0-CT-04..06).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { writeForwardedRequest } from "../../extensions/modes/permission-forwarding.ts";
import { clearCoreGlobals, restoreCoreGlobals, snapshotCoreGlobals, snapshotEnv, restoreEnv } from "./fake-host.ts";
import { setupModes } from "./helpers.ts";
import type { SetupResult } from "./helpers.ts";

let globalsSnapshot: Record<string, unknown>;
let envSnapshot: Record<string, string | undefined>;

beforeEach(() => {
	globalsSnapshot = snapshotCoreGlobals();
	clearCoreGlobals();
	envSnapshot = snapshotEnv();
	delete process.env.PERMISSION_MODES_INHERITED_MODE;
	delete process.env.PI_SUBAGENT_PARENT_SESSION;
});

afterEach(() => {
	restoreEnv(envSnapshot);
	restoreCoreGlobals(globalsSnapshot);
});

describe("P0-CT §4.2 env / subagent forwarding", () => {
	let s: SetupResult;

	beforeEach(async () => {
		s = setupModes();
	});

	it("P0-CT-04: after a mode switch, PERMISSION_MODES_INHERITED_MODE reflects the current mode", async () => {
		s.host.flags["permission-mode"] = "auto";
		const ctx = s.host.makeCtx({ cwd: s.cwd, ui: true });
		await s.host.fire("session_start", {}, ctx);
		expect(process.env.PERMISSION_MODES_INHERITED_MODE).toBe("auto");

		s.host.flags["permission-mode"] = "plan";
		await s.host.fire("session_start", {}, ctx);
		expect(process.env.PERMISSION_MODES_INHERITED_MODE).toBe("plan");
	});

	it("P0-CT-05: approval-forwarding on-disk layout matches the sessions/permission-modes-forwarding convention", async () => {
		const agentDir = join(s.tmp, "agent");
		await writeForwardedRequest({
			agentDir,
			targetSessionId: "parent-session-1",
			requesterSessionId: "child-1",
			tool: "write",
			label: "write /tmp/x",
			category: "write",
			input: { path: "/tmp/x" },
			cwd: "/proj",
		});
		const sessionDir = join(agentDir, "sessions", "permission-modes-forwarding", "sessions", "parent-session-1");
		const requestsDir = join(sessionDir, "requests");
		expect(existsSync(requestsDir)).toBe(true);
		const files = readdirSync(requestsDir);
		expect(files.length).toBe(1);
		// responses dir is pre-created for the parent to answer into
		expect(existsSync(join(sessionDir, "responses"))).toBe(true);
	});

	it("P0-CT-06: pm does NOT set PI_SUBAGENT_PARENT_SESSION itself (pin current behavior — consumed, not produced)", async () => {
		expect(process.env.PI_SUBAGENT_PARENT_SESSION).toBeUndefined();
		const ctx = s.host.makeCtx({ cwd: s.cwd, ui: true });
		await s.host.fire("session_start", {}, ctx);
		s.host.flags["permission-mode"] = "auto";
		await s.host.fire("session_start", {}, ctx);
		expect(process.env.PI_SUBAGENT_PARENT_SESSION).toBeUndefined();
	});
});
