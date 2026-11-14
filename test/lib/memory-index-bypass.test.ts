/**
 * FX-3 (SPEC 2026-11-14-followup-small-fixes) — the hand-written-index bypass.
 *
 * Writer-side evidence already pinned elsewhere: writer.ts caps the
 * generated index at MEMORY_INDEX_MAX (memory-writer.test.ts), injection
 * clamps per lane (memory-v2-storage lane-budget test, synthetic entries),
 * and the auto-trigger test exercises the COUNT threshold (205 files).
 * None of them covers the residual risk: the model "consolidates" by
 * directly editing MEMORY.md, bypassing the writer entirely.
 *
 * This file drives the REAL hook chain against a >25K hand-written
 * MEMORY.md (mtime newest, dir cache hot — the mid-session bypass state)
 * and pins three properties:
 *   ① injection stays ≤ the lane budget — the index derives from the .md
 *     files only (memdir.isMemoryFile excludes MEMORY.md), the giant
 *     on-disk index never leaks into the prompt;
 *   ② layerStats reads the RAW on-disk bytes → needsConsolidation returns
 *     "index N/25000 bytes" (not a synthetic LayerStats — the real file);
 *   ③ turn_end fires exactly one ConsolidationTrigger directive carrying
 *     that reason, via sendMessage(triggerTurn, followUp).
 */
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

/** The bypass: a direct MEMORY.md write with no writer involvement —
 * >MEMORY_INDEX_MAX bytes, a unique leak-marker, no writer WARNING line.
 * Returns the exact byte length for the ②/③ assertions. */
function handWriteGiantIndex(d: string): number {
	mkdirSync(d, { recursive: true });
	const row = "- [bypass-row](bypass.md) — BYPASS-MARKER filler row padding the index past the lane budget ........\n";
	const body = `# Project memory index (hand-edited)\n\n${row.repeat(320)}`;
	writeFileSync(join(d, "MEMORY.md"), body); // raw writeFileSync — deliberately NOT writeDocument/reindex
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
	it("giant hand-written index: injection ≤ lane budget, needsConsolidation counts raw bytes, turn_end fires the directive", async () => {
		put(dir, "alpha.md", "alpha", "alpha fact");
		put(dir, "beta.md", "beta", "beta fact");
		put(udir, "user-pref.md", "user-pref", "cross-project preference");
		const host = setup();
		const ctx = host.makeCtx({ cwd: project, ui: true });
		// session start reconciles both layers (writer writes the derived index,
		// dir cache goes hot) — the state the mid-session bypass starts from
		await host.fire("session_start", {}, ctx);
		// the model edits MEMORY.md directly, bypassing the writer
		const bypassBytes = handWriteGiantIndex(dir);
		expect(bypassBytes).toBeGreaterThan(MEMORY_INDEX_MAX);

		// ① injection: index sections stay within the lane; the giant
		// on-disk index (and its marker) never leaks into the prompt
		const handler = host.handlers.get("before_agent_start")![0] as (e: unknown, c: unknown) => Promise<{ systemPrompt?: string }>;
		const r = (await handler({ systemPrompt: "BASE" }, ctx))!;
		expect(r.systemPrompt).toBeDefined();
		expect(r.systemPrompt).not.toContain("BYPASS-MARKER");
		const indexPart = r.systemPrompt!.slice(r.systemPrompt!.indexOf("User memory index"));
		expect(Buffer.byteLength(indexPart, "utf8")).toBeLessThanOrEqual(MEMORY_INDEX_MAX);
		expect(indexPart).toContain("[alpha](alpha.md)");
		expect(indexPart).toContain("[user-pref](user-pref.md)");

		// ② the trigger probe reads the RAW on-disk index bytes
		const stats = layerStats(dir);
		expect(stats.indexBytes).toBe(bypassBytes); // still the hand-written size — nothing repaired it mid-session
		const reason = needsConsolidation(stats, MEMORY_INDEX_MAX);
		expect(reason).toBe(`index ${bypassBytes}/${MEMORY_INDEX_MAX} bytes`);

		// ③ turn_end fires ONE consolidation directive carrying that reason
		await host.fire("turn_end", { turnIndex: 0, message: { role: "assistant" }, toolResults: [] }, ctx);
		expect(host.sentMessages.length).toBe(1);
		const sent = host.sentMessages[0]!;
		expect(sent.message.customType).toBe(CONSOLIDATE_DIRECTIVE_TYPE);
		expect((sent.opts as { triggerTurn?: boolean })?.triggerTurn).toBe(true);
		expect((sent.opts as { deliverAs?: string })?.deliverAs).toBe("followUp");
		const content = (sent.message as { content?: string }).content ?? "";
		expect(content).toContain(`index ${bypassBytes}/${MEMORY_INDEX_MAX} bytes`);
		expect(content).toContain(dir);
		expect(content).toContain("memory_consolidate");
		// in-flight: a second turn_end does not re-send
		await host.fire("turn_end", { turnIndex: 1, message: { role: "assistant" }, toolResults: [] }, ctx);
		expect(host.sentMessages.length).toBe(1);
	});
});
