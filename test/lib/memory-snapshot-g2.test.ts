/**
 * Entropy-control G2 [C14] post-check integration: un-consolidated mass
 * deletion vs this session's start snapshot surfaces ONE notice at
 * agent_end; a normal consolidation run stays silent (docs/zh/entropy-control-spec.md).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeHost, clearCoreGlobals, restoreCoreGlobals, snapshotCoreGlobals } from "../contracts/fake-host.ts";
import memoryExtension from "../../extensions/memory/index.ts";

const CCTUI_LIVE = { active: true, notificationsConsumer: false } as const;

let home: string;
let project: string;
let prevHome: string | undefined;
let globalsSnapshot: Record<string, unknown>;

beforeEach(() => {
	globalsSnapshot = snapshotCoreGlobals();
	clearCoreGlobals();
	(globalThis as Record<string, unknown>).__piCcTui = CCTUI_LIVE;
	home = mkdtempSync(join(tmpdir(), "g2i-home-"));
	project = mkdtempSync(join(tmpdir(), "g2i-proj-"));
	process.env.HOME = home;
});

afterEach(() => {
	delete (globalThis as Record<string, unknown>).__piCcTui;
	if (prevHome === undefined) delete process.env.HOME;
	else process.env.HOME = prevHome;
	rmSync(home, { recursive: true, force: true });
	rmSync(project, { recursive: true, force: true });
	restoreCoreGlobals(globalsSnapshot);
});

const valid = (t: string): string => `---\nname: ${t}\ndescription: d\nmetadata:\n  type: project\n---\n\nbody ${t}`;

describe("G2-C14 mass-deletion post-check", () => {
	function boot() {
		const host = new FakeHost();
		memoryExtension(host.asPi());
		return host;
	}

	it("three fs-deleted files (no memory_consolidate) trigger the notice naming the snapshot location", async () => {
		const host = boot();
		const ctx = host.makeCtx({ cwd: project, ui: true });
		// project memory dir for this cwd: seeded via the real path derivation —
		// plant files through the layer the extension itself resolves.
		const { resolveMemoryPaths } = await import("../../extensions/memory/paths.ts");
		const layer = resolveMemoryPaths(project, home);
		mkdirSync(layer.memoryDir, { recursive: true });
		for (const n of ["a", "b", "c"]) writeFileSync(join(layer.memoryDir, `${n}.md`), valid(n));
		await host.fire("session_start", {}, ctx);
		for (const n of ["a", "b", "c"]) rmSync(join(layer.memoryDir, `${n}.md`));
		await host.fire("agent_end", {}, ctx);
		const hits = host.notifications.filter((n) => n.includes("without memory_consolidate"));
		expect(hits.length).toBe(1);
		expect(hits[0]).toContain("rollback snapshots");
	});

	it("a normal consolidation (via the tool) stays silent", async () => {
		const host = boot();
		const ctx = host.makeCtx({ cwd: project, ui: true });
		const { resolveMemoryPaths } = await import("../../extensions/memory/paths.ts");
		const layer = resolveMemoryPaths(project, home);
		mkdirSync(layer.memoryDir, { recursive: true });
		writeFileSync(join(layer.memoryDir, "a.md"), valid("a"));
		writeFileSync(join(layer.memoryDir, "b.md"), valid("b"));
		await host.fire("session_start", {}, ctx);
		const tool = host.tools.get("memory_consolidate")!;
		const merged = `---\nname: ab\ndescription: merged\nmetadata:\n  type: project\n---\n\nbody a+b`;
		await tool.execute("t1", { writes: [{ file: "ab.md", content: merged, merged_from: ["a.md", "b.md"] }], deletes: ["a.md", "b.md"] }, undefined, undefined, ctx);
		await host.fire("agent_end", {}, ctx);
		expect(host.notifications.filter((n) => n.includes("without memory_consolidate")).length).toBe(0);
	});
});
