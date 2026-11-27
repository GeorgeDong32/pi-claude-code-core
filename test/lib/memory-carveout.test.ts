import { describe, expect, it, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FakeHost, clearCoreGlobals, snapshotCoreGlobals } from "../contracts/fake-host.ts";
import { resetCoreBusForTests } from "../../extensions/bus.ts";
import { targets } from "../contracts/targets.ts";
import memoryExtension from "../../extensions/memory/index.ts";
import { resolveMemoryPaths } from "../../extensions/memory/paths.ts";

let globalsSnapshot: Record<string, unknown>;
let project: string;
let prevHome: string | undefined;
let home: string;

beforeEach(() => {
	globalsSnapshot = snapshotCoreGlobals();
	clearCoreGlobals();
	resetCoreBusForTests();
	prevHome = process.env.HOME;
	home = mkdtempSync(join(tmpdir(), "carve-home-"));
	project = mkdtempSync(join(tmpdir(), "carve-proj-"));
	process.env.HOME = home;
});

function modesOnly(): FakeHost {
	const host = new FakeHost();
	targets.modes.factory(host.asPi());
	return host;
}

describe("P3-PM-01 memory write carve-out", () => {
	it("ask mode: write into memoryDir skips the dialog (no select, no block)", async () => {
		const host = modesOnly();
		host.flags["permission-mode"] = "ask";
		const ctx = host.makeCtx({ cwd: project, ui: true });
		await host.fire("session_start", {}, ctx);

		const dir = resolveMemoryPaths(project, home).memoryDir;
		const result = await host.fire("tool_call", { toolName: "write", input: { path: join(dir, "note.md"), content: "hi" } }, ctx);
		expect(result).toBeUndefined();
	});

	it("ask mode: write outside memoryDir still prompts (block on Block answer)", async () => {
		const host = modesOnly();
		host.flags["permission-mode"] = "ask";
		const ctx = host.makeCtx({ cwd: project, ui: true });
		await host.fire("session_start", {}, ctx);

		const result = await host.fire(
			"tool_call",
			{ toolName: "write", input: { path: join(project, "outside.md"), content: "hi" } },
			ctx,
		);
		expect(result).toMatchObject({ block: true });
	});

	it("secret guard survives the carve-out: both modules chained, secret memory write blocks", async () => {
		const host = new FakeHost();
		targets.modes.factory(host.asPi());
		memoryExtension(host.asPi());
		host.flags["permission-mode"] = "ask";
		const ctx = host.makeCtx({ cwd: project, ui: true });
		await host.fire("session_start", {}, ctx);

		const dir = resolveMemoryPaths(project, home).memoryDir;
		const result = await host.fire(
			"tool_call",
			{ toolName: "write", input: { path: join(dir, "leak.md"), content: "api_key = sk-abcdef123456abcdef123456" } },
			ctx,
		);
		expect(result).toMatchObject({ block: true, reason: expect.stringContaining("blocked") });
	});
});
