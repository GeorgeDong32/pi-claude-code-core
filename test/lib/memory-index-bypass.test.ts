import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FakeHost, clearCoreGlobals, snapshotCoreGlobals } from "../contracts/fake-host.ts";
import { resetCoreBusForTests } from "../../extensions/bus.ts";
import memoryExtension from "../../extensions/memory/index.ts";
import { resolveMemoryPaths } from "../../extensions/memory/paths.ts";
import { invalidateMemDirCache } from "../../extensions/memory/memdir.ts";
import { layerStats } from "../../extensions/memory/store.ts";
import { needsConsolidation, CONSOLIDATE_DIRECTIVE_TYPE } from "../../extensions/memory/consolidate.ts";
import { MEMORY_INDEX_MAX } from "../../lib/context-budget.ts";

let globalsSnapshot: Record<string, unknown>;
let home: string;
let project: string;
let prevHome: string | undefined;
let dir: string;
let udir: string;

function setup(): FakeHost {
	const host = new FakeHost();
	memoryExtension(host.asPi());
	return host;
}

function put(d: string, file: string, title: string, description = "d"): void {
	mkdirSync(d, { recursive: true });
	writeFileSync(join(d, file), `---\nname: ${title}\ndescription: ${description}\nmetadata:\n  type: project\n---\n\n${title} body`);
	invalidateMemDirCache(d);
}

function handWriteGiantIndex(d: string): number {
	mkdirSync(d, { recursive: true });
	const row = "- [bypass-row](bypass.md) — BYPASS-MARKER filler row padding the index past the lane budget ........\n";
	const body = `# Project memory index (hand-edited)\n\n${row.repeat(320)}`;
	writeFileSync(join(d, "MEMORY.md"), body);
	return Buffer.byteLength(body, "utf8");
}

beforeEach(() => {
	globalsSnapshot = snapshotCoreGlobals();
	clearCoreGlobals();
	resetCoreBusForTests();
	prevHome = process.env.HOME;
	home = mkdtempSync(join(tmpdir(), "membypass-home-"));
	project = mkdtempSync(join(tmpdir(), "membypass-proj-"));
	process.env.HOME = home;
	const p = resolveMemoryPaths(project, home);
	dir = p.memoryDir;
	udir = p.userMemoryDir;
});

afterEach(() => {
	if (prevHome === undefined) delete process.env.HOME;
	else process.env.HOME = prevHome;
	rmSync(home, { recursive: true, force: true });
	rmSync(project, { recursive: true, force: true });
});

describe("FX-3 — MEMORY.md hand-edit bypass (>25K, writer skipped)", () => {
	it("giant hand-written index: injection ≤ lane budget, needsConsolidation counts raw bytes, the manual directive carries the reason", async () => {
		put(dir, "alpha.md", "alpha", "alpha fact");
		put(dir, "beta.md", "beta", "beta fact");
		const host = setup();
		const ctx = host.makeCtx({ cwd: project, ui: true });
		await host.fire("session_start", {}, ctx);
		const bypassBytes = handWriteGiantIndex(dir);
		expect(bypassBytes).toBeGreaterThan(MEMORY_INDEX_MAX);

		const handler = host.handlers.get("before_agent_start")![0] as (e: unknown, c: unknown) => Promise<{ systemPrompt?: string }>;
		const r = (await handler({ systemPrompt: "BASE" }, ctx))!;
		expect(r.systemPrompt).toBeDefined();
		expect(r.systemPrompt).not.toContain("BYPASS-MARKER");
		const indexPart = r.systemPrompt!.slice(r.systemPrompt!.indexOf("Project memory index"));
		expect(Buffer.byteLength(indexPart, "utf8")).toBeLessThanOrEqual(MEMORY_INDEX_MAX);
		expect(indexPart).toContain("- alpha — ");
		expect(r.systemPrompt).not.toContain("- user-pref — ");

		const stats = layerStats(dir);
		expect(stats.indexBytes).toBe(bypassBytes);
		const reason = needsConsolidation(stats, MEMORY_INDEX_MAX);
		expect(reason).toBe(`index ${bypassBytes}/${MEMORY_INDEX_MAX} bytes`);

		await host.fire("turn_end", { turnIndex: 0, message: { role: "assistant" }, toolResults: [] }, ctx);
		expect(host.sentMessages.length).toBe(0);
		await host.commands.get("memory-consolidate")?.("", ctx);
		expect(host.sentMessages.length).toBe(1);
		const sent = host.sentMessages[0]!;
		expect(sent.message.customType).toBe(CONSOLIDATE_DIRECTIVE_TYPE);
		expect((sent.opts as { triggerTurn?: boolean })?.triggerTurn).toBe(true);
		expect((sent.opts as { deliverAs?: string })?.deliverAs).toBe("followUp");
		const content = (sent.message as { content?: string }).content ?? "";
		expect(content).toContain(`index ${bypassBytes}/${MEMORY_INDEX_MAX} bytes`);
		expect(content).toContain(dir);
		expect(content).toContain("memory_consolidate");
	});
});
