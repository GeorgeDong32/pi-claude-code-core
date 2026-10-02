/**
 * V2-C (DESIGN-MEMORY-V2 §5) — ops engine + memory_consolidate + auto-trigger.
 *
 * Covers: batch validation (frontmatter/secret/anchor/count), batch
 * atomicity (invalid op ⇒ nothing written), tmp+rename durability, the
 * mkdir lock (mutual exclusion + TTL steal), the must-shrink invariant,
 * directive copy, and the trigger state machine (throttle, 2-per-session
 * cap, yielded silence).
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FakeHost, clearCoreGlobals, snapshotCoreGlobals } from "../contracts/fake-host.ts";
import { resetCoreBusForTests } from "../../extensions/bus.ts";
import memoryExtension from "../../extensions/memory/index.ts";
import { applyMemoryOps, acquireLayerLock, layerStats, type MemoryOp } from "../../extensions/memory/store.ts";
import { parseMemoryFrontmatter } from "../../extensions/memory/memdir.ts";
import {
	runConsolidation,
	buildConsolidationDirective,
	ConsolidationTrigger,
	CONSOLIDATE_DIRECTIVE_TYPE,
	needsConsolidation,
} from "../../extensions/memory/consolidate.ts";
import { resolveMemoryPaths } from "../../extensions/memory/paths.ts";

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

function put(d: string, file: string, title: string, body = "body text"): void {
	mkdirSync(d, { recursive: true });
	writeFileSync(join(d, file), `---\nname: ${title}\ndescription: d\nmetadata:\n  type: project\n---\n\n${body}`);
}

beforeEach(() => {
	globalsSnapshot = snapshotCoreGlobals();
	clearCoreGlobals();
	resetCoreBusForTests();
	prevHome = process.env.HOME;
	home = mkdtemp_home();
	project = mkdtempSync(join(tmpdir(), "memv2c-proj-"));
	process.env.HOME = home;
	const p = resolveMemoryPaths(project, home);
	dir = p.memoryDir;
	udir = p.userMemoryDir;
});

function mkdtemp_home(): string {
	return mkdtempSync(join(tmpdir(), "memv2c-home-"));
}

afterEach(() => {
	if (prevHome === undefined) delete process.env.HOME;
	else process.env.HOME = prevHome;
	rmSync(home, { recursive: true, force: true });
	rmSync(project, { recursive: true, force: true });
});

describe("V2-C ops engine", () => {
	it("add creates a valid file and reconciles the index", () => {
		const out = applyMemoryOps([{ action: "add", layer: "project", name: "build-flow", description: "how to build", body: "bun run check" }], { user: udir, project: dir });
		expect(out.applied).toBe(1);
		expect(existsSync(join(dir, "build-flow.md"))).toBe(true);
		expect(readFileSync(join(dir, "MEMORY.md"), "utf-8")).toContain("[build-flow](build-flow.md)");
	});

	it("skip-invalid semantics: invalid ops skipped, valid ops in the same batch apply; batch-fatal gates reject wholesale", () => {
		put(dir, "a.md", "a");
		const ops: MemoryOp[] = [
			{ action: "add", layer: "project", name: "good", description: "d", body: "ok" },
			{ action: "add", layer: "project", name: "bad", description: "d", body: "token = " + "x".repeat(20) }, // secret
		];
		const out = applyMemoryOps(ops, { user: udir, project: dir });
		// one hallucinated op must not discard the batch (决1: skip-invalid)
		expect(out.skipped.length).toBe(1);
		expect(existsSync(join(dir, "good.md"))).toBe(true); // valid op still applies
		// invalid-target op: skipped with reason
		const out2 = applyMemoryOps([{ action: "remove", layer: "project", file: "missing.md" }], { user: udir, project: dir });
		expect(out2.applied).toBe(0);
		expect(out2.skipped[0]!.reason).toContain("not found");
		// batch-fatal gate 1: >200 ops → nothing written
		const tooMany: MemoryOp[] = Array.from({ length: 201 }, (_, i) => ({ action: "add", layer: "project", name: `n${i}`, description: "d", body: "b" }));
		const out3 = applyMemoryOps(tooMany, { user: udir, project: dir });
		expect(out3.error).toContain("batch too large");
		expect(out3.applied).toBe(0);
		expect(existsSync(join(dir, "n0.md"))).toBe(false);
	});

	it("replace preserves frontmatter, honors stale anchors", () => {
		put(dir, "a.md", "alpha", "old body content");
		const ok = applyMemoryOps([{ action: "replace", layer: "project", file: "a.md", body: "new body", old_text: "old body content" }], { user: udir, project: dir });
		expect(ok.applied).toBe(1);
		expect(readFileSync(join(dir, "a.md"), "utf-8")).toContain("name: alpha"); // preserved
		expect(readFileSync(join(dir, "a.md"), "utf-8")).toContain("new body");
		const stale = applyMemoryOps([{ action: "replace", layer: "project", file: "a.md", body: "x", old_text: "old body content" }], { user: udir, project: dir });
		expect(stale.applied).toBe(0);
		expect(stale.skipped[0]!.reason).toContain("stale anchor");
	});

	it("remove deletes the file and drops the index row", () => {
		put(dir, "a.md", "alpha");
		const out = applyMemoryOps([{ action: "remove", layer: "project", file: "a.md" }], { user: udir, project: dir });
		expect(out.applied).toBe(1);
		expect(existsSync(join(dir, "a.md"))).toBe(false);
		expect(readFileSync(join(dir, "MEMORY.md"), "utf-8")).not.toContain("alpha");
	});

	it("user layer ops write into the user dir", () => {
		const out = applyMemoryOps([{ action: "add", layer: "user", name: "pref-lang", description: "d", type: "user", body: "中文回复" }], { user: udir, project: dir });
		expect(out.applied).toBe(1);
		expect(existsSync(join(udir, "pref-lang.md"))).toBe(true);
	});
});

describe("V2-C consolidation lock", () => {
	it("mkdir lock: second acquire fails, release re-enables, TTL steals stale locks", () => {
		mkdirSync(dir, { recursive: true });
		const l1 = acquireLayerLock(dir);
		expect(l1).not.toBeNull();
		expect(acquireLayerLock(dir)).toBeNull(); // held
		// stale lock (mtime pushed past TTL) is stolen
		const staleDir = join(home, "stale-lock");
		mkdirSync(staleDir, { recursive: true });
		const ls = acquireLayerLock(staleDir);
		expect(ls).not.toBeNull();
		const old = new Date(Date.now() - 11 * 60_000);
		utimesSync(join(staleDir, ".consolidate.lock"), old, old);
		const stolen = acquireLayerLock(staleDir);
		expect(stolen).not.toBeNull();
		l1!.release();
		expect(acquireLayerLock(dir)).not.toBeNull();
		ls!.release();
		stolen!.release();
	});
});

describe("V2-C runConsolidation (must-shrink transaction)", () => {
	it("merges two files into one: writes+deletes applied, index reconciled", () => {
		put(dir, "a.md", "alpha", "alpha fact");
		put(dir, "b.md", "beta", "beta fact");
		const merged = "---\nname: alpha-beta\ndescription: merged\nmetadata:\n  type: project\n---\n\nalpha fact + beta fact";
		const r = runConsolidation(dir, [{ file: "alpha-beta.md", content: merged }], ["a.md", "b.md"]);
		expect(r.ok).toBe(true);
		expect(r.afterFiles).toBeLessThan(r.beforeFiles);
		expect(existsSync(join(dir, "a.md"))).toBe(false);
		expect(readFileSync(join(dir, "MEMORY.md"), "utf-8")).toContain("alpha-beta");
		expect(existsSync(join(dir, ".consolidate.lock"))).toBe(false); // released
	});

	it("rejects a batch that does not shrink", () => {
		put(dir, "a.md", "alpha", "short");
		const bigger = "---\nname: alpha\ndescription: d\nmetadata:\n  type: project\n---\n\n" + "x".repeat(500);
		const r = runConsolidation(dir, [{ file: "a.md", content: bigger }], []);
		expect(r.ok).toBe(false);
		expect(r.message).toContain("does not shrink");
		expect(readFileSync(join(dir, "a.md"), "utf-8")).toContain("short"); // untouched
	});

	it("rejects invalid frontmatter / secret / unknown delete target", () => {
		put(dir, "a.md", "alpha", "fact");
		expect(runConsolidation(dir, [{ file: "x.md", content: "no frontmatter" }], []).ok).toBe(false);
		expect(runConsolidation(dir, [{ file: "x.md", content: "---\nname: x\ndescription: d\nmetadata:\n  type: project\n---\n\ntoken = " + "y".repeat(20) }], []).ok).toBe(false);
		expect(runConsolidation(dir, [], ["ghost.md"]).ok).toBe(false);
		expect(existsSync(join(dir, "x.md"))).toBe(false); // nothing applied
	});
});

describe("V2-C directive + trigger state machine", () => {
	it("directive copy pins the tool, the dir, and the shrink rule", () => {
		put(dir, "a.md", "alpha", "fact");
		const text = buildConsolidationDirective("project", layerStats(dir), 25_000, "index truncated");
		expect(text).toContain("memory_consolidate");
		expect(text).toContain(dir);
		expect(text).toContain("reduces total bytes or file count");
		expect(text).toContain("Read the memory files");
	});

	it("auto-trigger: over-budget store sends ONE directive via sendMessage(triggerTurn)", async () => {
		// 205 valid files ⇒ count threshold
		mkdirSync(dir, { recursive: true });
		for (let i = 0; i < 205; i++) {
			writeFileSync(join(dir, `m${String(i).padStart(3, "0")}.md`), `---\nname: m${i}\ndescription: d\nmetadata:\n  type: project\n---\n\nfact ${i}`);
		}
		const host = setup();
		const ctx = host.makeCtx({ cwd: project, ui: true });
		await host.fire("session_start", {}, ctx);
		await host.fire("turn_end", { turnIndex: 0, message: { role: "assistant" }, toolResults: [] }, ctx);
		expect(host.sentMessages.length).toBe(1);
		const sent = host.sentMessages[0]!;
		expect(sent.message.customType).toBe(CONSOLIDATE_DIRECTIVE_TYPE);
		expect((sent.opts as { triggerTurn?: boolean })?.triggerTurn).toBe(true);
		expect((sent.opts as { deliverAs?: string })?.deliverAs).toBe("followUp");
		// in-flight: a second turn_end must not re-send
		await host.fire("turn_end", { turnIndex: 1, message: { role: "assistant" }, toolResults: [] }, ctx);
		expect(host.sentMessages.length).toBe(1);
		// settle via agent_settled → throttle window (10 turns) blocks immediate retry
		await host.fire("agent_settled", {}, ctx);
		await host.fire("turn_end", { turnIndex: 2, message: { role: "assistant" }, toolResults: [] }, ctx);
		expect(host.sentMessages.length).toBe(1);
	});

	it("2-per-session cap: after two directives the trigger gives up silently", async () => {
		mkdirSync(dir, { recursive: true });
		for (let i = 0; i < 205; i++) {
			writeFileSync(join(dir, `m${String(i).padStart(3, "0")}.md`), `---\nname: m${i}\ndescription: d\nmetadata:\n  type: project\n---\n\nfact ${i}`);
		}
		const host = setup();
		const ctx = host.makeCtx({ cwd: project, ui: true });
		await host.fire("session_start", {}, ctx);
		await host.fire("turn_end", { turnIndex: 0, message: { role: "assistant" }, toolResults: [] }, ctx); // attempt 1
		await host.fire("agent_settled", {}, ctx);
		for (let i = 1; i <= 10; i++) await host.fire("turn_end", { turnIndex: i, message: { role: "assistant" }, toolResults: [] }, ctx);
		expect(host.sentMessages.length).toBe(2); // attempt 2 after the 10-turn window
		await host.fire("agent_settled", {}, ctx);
		for (let i = 11; i <= 30; i++) await host.fire("turn_end", { turnIndex: i, message: { role: "assistant" }, toolResults: [] }, ctx);
		expect(host.sentMessages.length).toBe(2); // capped
	});

	it("tool_result(memory_consolidate) settles the in-flight flag", async () => {
		mkdirSync(dir, { recursive: true });
		for (let i = 0; i < 205; i++) {
			writeFileSync(join(dir, `m${String(i).padStart(3, "0")}.md`), `---\nname: m${i}\ndescription: d\nmetadata:\n  type: project\n---\n\nfact ${i}`);
		}
		const host = setup();
		const ctx = host.makeCtx({ cwd: project, ui: true });
		await host.fire("session_start", {}, ctx);
		await host.fire("turn_end", { turnIndex: 0, message: { role: "assistant" }, toolResults: [] }, ctx);
		await host.fire("tool_result", { toolName: "memory_consolidate", content: [], isError: false }, ctx);
		// settled but throttle window still blocks an instant re-send
		await host.fire("turn_end", { turnIndex: 1, message: { role: "assistant" }, toolResults: [] }, ctx);
		expect(host.sentMessages.length).toBe(1);
	});

	it("yielded (hermes present) ⇒ auto-trigger stays silent", async () => {
		mkdirSync(dir, { recursive: true });
		for (let i = 0; i < 205; i++) {
			writeFileSync(join(dir, `m${String(i).padStart(3, "0")}.md`), `---\nname: m${i}\ndescription: d\nmetadata:\n  type: project\n---\n\nfact ${i}`);
		}
		const npmDir = join(home, ".pi", "agent", "npm", "node_modules");
		mkdirSync(npmDir, { recursive: true });
		writeFileSync(join(npmDir, "hermes-memory"), "stub");
		const host = setup();
		const ctx = host.makeCtx({ cwd: project, ui: true });
		await host.fire("session_start", {}, ctx);
		await host.fire("turn_end", { turnIndex: 0, message: { role: "assistant" }, toolResults: [] }, ctx);
		expect(host.sentMessages.length).toBe(0);
	});

	it("needsConsolidation detects truncated index, byte overflow (B1), and count overflow", async () => {
		expect(needsConsolidation({ dir, files: 10, totalBytes: 1000, indexBytes: 500, indexTruncated: true }, 25_000)).toBe("index truncated");
		// B1: a 9KB user-layer index over its 8KB cap — no WARNING on disk, but over budget
		expect(needsConsolidation({ dir, files: 10, totalBytes: 1000, indexBytes: 9_000, indexTruncated: false }, 8_000)).toContain("9000/8000 bytes");
		expect(needsConsolidation({ dir, files: 205, totalBytes: 1000, indexBytes: 500, indexTruncated: false }, 25_000)).toContain("205 files");
		expect(needsConsolidation({ dir, files: 10, totalBytes: 1000, indexBytes: 500, indexTruncated: false }, 25_000)).toBeNull();
	});
});

describe("V2-C /memory-consolidate command + tool registration", () => {
	it("command sends the directive for a non-empty store and registers the tool", async () => {
		put(dir, "a.md", "alpha", "fact");
		const host = setup();
		const ctx = host.makeCtx({ cwd: project, ui: true });
		await host.fire("session_start", {}, ctx);
		expect(host.tools.get("memory_consolidate")).toBeDefined();
		await host.commands.get("memory-consolidate")?.("", ctx);
		expect(host.sentMessages.some((m) => m.message.customType === CONSOLIDATE_DIRECTIVE_TYPE)).toBe(true);
		expect(host.notifications.some((n) => n.includes("directive sent"))).toBe(true);
	});

	it("command on an empty store notifies without sending", async () => {
		const host = setup();
		const ctx = host.makeCtx({ cwd: project, ui: true });
		await host.fire("session_start", {}, ctx);
		await host.commands.get("memory-consolidate")?.("", ctx);
		expect(host.sentMessages.length).toBe(0);
		expect(host.notifications.some((n) => n.includes("no memory files"))).toBe(true);
	});

	it("tool execute applies a valid batch through the transaction", async () => {
		put(dir, "a.md", "alpha", "fact one");
		put(dir, "b.md", "beta", "fact two");
		const host = setup();
		const ctx = host.makeCtx({ cwd: project, ui: true });
		await host.fire("session_start", {}, ctx);
		const tool = host.tools.get("memory_consolidate")!;
		const merged = "---\nname: ab\ndescription: merged\nmetadata:\n  type: project\n---\n\nfact one + fact two";
		const r = (await tool.execute("t1", { writes: [{ file: "ab.md", content: merged }], deletes: ["a.md", "b.md"] }, undefined, undefined, ctx)) as {
			content: Array<{ text: string }>;
		};
		expect(r.content[0]!.text).toContain("consolidated");
		expect(existsSync(join(dir, "ab.md"))).toBe(true);
	});

	it("tool execute throws on a non-shrinking batch (native error rendering)", async () => {
		put(dir, "a.md", "alpha", "short");
		const host = setup();
		const ctx = host.makeCtx({ cwd: project, ui: true });
		await host.fire("session_start", {}, ctx);
		const tool = host.tools.get("memory_consolidate")!;
		await expect(
			tool.execute("t1", { writes: [{ file: "a.md", content: "---\nname: alpha\ndescription: d\nmetadata:\n  type: project\n---\n\n" + "x".repeat(400) }], deletes: [] }, undefined, undefined, ctx),
		).rejects.toThrow("does not shrink");
	});
});

describe("V2 Phase 2 (B4) — same-batch duplicate adds", () => {
	it("two adds with the same derived name: second is skipped as an in-batch duplicate", () => {
		const out = applyMemoryOps(
			[
				{ action: "add", layer: "project", name: "build-flow", description: "d1", body: "first" },
				{ action: "add", layer: "project", name: "build-flow", description: "d2", body: "second" },
			],
			{ user: udir, project: dir },
		);
		expect(out.applied).toBe(1);
		expect(out.skipped[0]!.reason).toContain("already added in this batch");
		expect(readFileSync(join(dir, "build-flow.md"), "utf-8")).toContain("first");
	});

	it("add + replace of the same name in one batch: replace is skipped (target not on disk at preflight)", () => {
		const out = applyMemoryOps(
			[
				{ action: "add", layer: "project", name: "x", description: "d", body: "b" },
				{ action: "replace", layer: "project", file: "x.md", body: "new" },
			],
			{ user: udir, project: dir },
		);
		expect(out.applied).toBe(1);
		expect(out.skipped.some((sk) => sk.reason!.includes("not found"))).toBe(true);
	});
});

/* ── 附记 A.1 ③: LLM ops returning a FULL file in body must not stack two
 * frontmatter blocks (live regression: pi-memory-recall-reinject-symptom,
 * 2026-10-02 — a correction's description was invisible to the index). ── */
describe("store op-body frontmatter hoist (spec 2026-10-02-memory-recall-v2)", () => {
	it("a replace op whose body is a full file renders ONE frontmatter block with the NEW fields", () => {
		const target = resolveMemoryPaths(project, home);
		const tdir = target.memoryDir;
		const tudir = target.userMemoryDir;
		mkdirSync(tdir, { recursive: true });
		writeFileSync(join(tdir, "symptom.md"), `---\nname: symptom\ndescription: "[insight] old description line"\nmetadata:\n  type: project\n---\n\nold body\n`);
		const fullFileBody = `---\nname: symptom\ndescription: "[correction] new description line"\nmetadata:\n  type: project\n---\n\ncorrected body text`;
		const out = applyMemoryOps(
			[{ action: "replace", layer: "project", file: "symptom.md", body: fullFileBody, old_text: "old body" }],
			{ user: tudir, project: tdir },
		);
		expect(out.applied).toBe(1);
		const written = readFileSync(join(tdir, "symptom.md"), "utf-8");
		expect(written.match(/^---$/gm)?.length).toBe(2); // exactly one frontmatter block
		expect(written).toContain("[correction] new description line");
		expect(written).not.toContain("[insight] old description line");
		// the index (splitFrontmatter view) now sees the corrected description
		expect(parseMemoryFrontmatter(written)?.description).toBe("[correction] new description line");
	});
});

/* ── R3 write-side routing (RV-15): user-layer ops anchored to the current
 * project land in the PROJECT layer — the measured cross-project leakage
 * guard (12/17 user-layer files were project-anchored). ── */
describe("store user→project routing (RV-15)", () => {
	it("a user-layer add mentioning the project key routes to the project layer; scoped (paths:) and clean ops stay user", () => {
		const target = resolveMemoryPaths(project, home);
		const tdir = target.memoryDir;
		const tudir = target.userMemoryDir;
		mkdirSync(tdir, { recursive: true });
		const notes: string[] = [];
		const out = applyMemoryOps(
			[
				{ action: "add", layer: "user", name: "cherrydev-workflow", description: "CherryDev repo conventions", type: "project", body: "CherryDev specific workflow facts" },
				{ action: "add", layer: "user", name: "global-style", description: "communication style", type: "user", body: "reply in chinese" },
			],
			{ user: tudir, project: tdir },
			{ projectKey: "CherryDev", routedNotes: notes },
		);
		expect(out.applied).toBe(2);
		expect(notes).toHaveLength(1);
		expect(notes[0]).toContain("cherrydev-workflow");
		expect(existsSync(join(tdir, "cherrydev-workflow.md"))).toBe(true);
		expect(existsSync(join(tudir, "global-style.md"))).toBe(true);
		expect(existsSync(join(tudir, "cherrydev-workflow.md"))).toBe(false);
		// a paths-scoped body is an explicit scoping decision — not routed
		const notes2: string[] = [];
		const out2 = applyMemoryOps(
			[{ action: "add", layer: "user", name: "scoped-pref", description: "solo repos preference", type: "user", body: '---\nname: scoped-pref\ndescription: d\npaths: ["~/Coding/CodeIsland/**"]\n---\n\nprefers minimal git flow' }],
			{ user: tudir, project: tdir },
			{ projectKey: "CherryDev", routedNotes: notes2 },
		);
		expect(out2.applied).toBe(1);
		expect(notes2).toHaveLength(0);
		expect(existsSync(join(tudir, "scoped-pref.md"))).toBe(true);
	});
});
