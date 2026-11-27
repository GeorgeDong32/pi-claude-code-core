/**
 * V2-M1 (DESIGN-MEMORY-V2 §1/§2) — storage + write path tests, single layer.
 *
 * The cross-project user layer is retired: the project layer under
 * ~/.pi/agent/projects/<root>/memory is the only store injected, recalled
 * or written. The old user dir survives as a read-only source (pinned
 * injection until migration, snapshots, diagnostics).
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, utimesSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FakeHost, clearCoreGlobals, snapshotCoreGlobals } from "../contracts/fake-host.ts";
import { resetCoreBusForTests } from "../../extensions/bus.ts";
import memoryExtension from "../../extensions/memory/index.ts";
import { invalidateMemDirCache, parseMemoryFrontmatter, scanMemoryDir } from "../../extensions/memory/memdir.ts";
import { reindex } from "../../extensions/memory/writer.ts";
import { resolveMemoryPaths, isMemoryWritePath, memoryWriteRoots } from "../../extensions/memory/paths.ts";
import { freshnessHeader } from "../../extensions/memory/recall.ts";
import type { Selector, SelectorOutcome } from "../../extensions/memory/selector.ts";
import { buildPolicyInjection, policyCompact, PINNED_TOTAL_MAX } from "../../extensions/memory/policy.ts";
import { guardMemoryWrites } from "../../extensions/memory/guard.ts";
import { layerStats } from "../../extensions/memory/store.ts";
import { MEMORY_INDEX_MAX } from "../../lib/context-budget.ts";

let globalsSnapshot: Record<string, unknown>;
let home: string;
let project: string;
let prevHome: string | undefined;

function dirs(): { dir: string; udir: string } {
	const p = resolveMemoryPaths(project, home);
	return { dir: p.memoryDir, udir: p.userMemoryDir };
}

function setup(): FakeHost {
	const host = new FakeHost();
	memoryExtension(host.asPi());
	return host;
}

/** RV wiring helper: settings with recallModel + a recording fake selector. */
function setupWithSelector(keys: string[], log: Array<{ query: string; candidates: string[] }> = []): FakeHost {
	mkdirSync(join(home, ".pi", "agent"), { recursive: true });
	writeFileSync(join(home, ".pi", "agent", "settings.json"), JSON.stringify({ memory: { recallModel: "test/selector-1", recallWaitMs: 5000 } }));
	const factory = (): Selector => ({
		async select(req): Promise<SelectorOutcome> {
			log.push({ query: req.query, candidates: req.candidates.map((c) => c.key) });
			return { kind: "selected", keys, elapsedMs: 1 };
		},
	});
	const host = new FakeHost();
	memoryExtension(host.asPi(), { selectorFactory: factory });
	return host;
}

/** A ctx whose modelRegistry resolves the configured recallModel. */
function recallCtx(host: FakeHost, opts: { cwd: string; projectionMessages?: unknown[] }): Record<string, unknown> {
	const ctx = host.makeCtx({ cwd: opts.cwd, ui: true, projectionMessages: opts.projectionMessages ?? [] });
	ctx.modelRegistry = { getAll: () => [{ provider: "test", id: "selector-1" }] };
	return ctx;
}

function writeMemory(layer: "user" | "project", name: string, title: string, description: string, type = "project", body = "body text", pinned = false): void {
	const { dir, udir } = dirs();
	const target = layer === "user" ? udir : dir;
	mkdirSync(target, { recursive: true });
	writeFileSync(
		join(target, name),
		`---\nname: ${title}\ndescription: ${description}\nmetadata:\n  type: ${type}${pinned ? "\n  pinned: true" : ""}\n---\n\n${body}`,
	);
	// C7: direct write bypassed the invalidating primitives — drop the scan
	// cache so scan→write→scan sequences in one test stay exact.
	invalidateMemDirCache(target);
	// the recall echo filter drops files with mtime >= session start; a write
	// in the same millisecond as session_start would flake — backdate
	const past = new Date(Date.now() - 60_000);
	utimesSync(join(target, name), past, past);
}

beforeEach(() => {
	globalsSnapshot = snapshotCoreGlobals();
	clearCoreGlobals();
	resetCoreBusForTests();
	prevHome = process.env.HOME;
	home = mkdtempSync(join(tmpdir(), "memv2-home-"));
	project = mkdtempSync(join(tmpdir(), "memv2-proj-"));
	process.env.HOME = home;
});

afterEach(() => {
	if (prevHome === undefined) delete process.env.HOME;
	else process.env.HOME = prevHome;
	rmSync(home, { recursive: true, force: true });
	rmSync(project, { recursive: true, force: true });
});

describe("V2-M1 paths", () => {
	it("user layer resolves to <agentDir>/memory alongside the project layer (read-only retired dir)", () => {
		const p = resolveMemoryPaths(project, home);
		expect(p.userMemoryDir).toBe(join(home, ".pi", "agent", "memory"));
		expect(p.memoryDir).not.toBe(p.userMemoryDir);
	});

	it("isMemoryWritePath accepts only the project layer; the retired user dir lost the carve-out", () => {
		const { dir, udir } = dirs();
		expect(isMemoryWritePath(join(dir, "a.md"), project, home)).toBe(true);
		expect(isMemoryWritePath(join(udir, "a.md"), project, home)).toBe(false);
		expect(isMemoryWritePath(`${dir}-evil/a.md`, project, home)).toBe(false);
		expect(isMemoryWritePath(join(home, "plain", "a.md"), project, home)).toBe(false);
	});

	it("memoryWriteRoots returns only the project dir", () => {
		const { dir } = dirs();
		expect(memoryWriteRoots(project, home)).toEqual([dir]);
	});

	it("parseMemoryFrontmatter reads pinned true/false and stays valid otherwise", () => {
		expect(parseMemoryFrontmatter("---\nname: a\ndescription: d\nmetadata:\n  type: user\n  pinned: true\n---\n\nb")?.pinned).toBe(true);
		expect(parseMemoryFrontmatter("---\nname: a\ndescription: d\nmetadata:\n  type: user\n  pinned: false\n---\n\nb")?.pinned).toBe(false);
		expect(parseMemoryFrontmatter("---\nname: a\ndescription: d\nmetadata:\n  type: user\n---\n\nb")?.pinned).toBe(false);
	});
});

describe("V2-M1 policy injection (single layer)", () => {
	it("before_agent_start injects one policy block: pinned (retired-dir) section first, then the project index", async () => {
		writeMemory("user", "u1.md", "prefers-中文", "user prefers chinese replies", "user", "所有回复默认中文", true);
		writeMemory("project", "p1.md", "build-flow", "how to build", "project", "bun run check");
		const host = setup();
		const ctx = host.makeCtx({ cwd: project, ui: true });
		await host.fire("session_start", {}, ctx);
		const handler = host.handlers.get("before_agent_start")![0] as (e: unknown, c: unknown) => Promise<{ systemPrompt?: string }>;
		const r = (await handler({ systemPrompt: "BASE" }, ctx))!;
		expect(r.systemPrompt!.split("<memory-policy>").length - 1).toBe(1);
		// pinned files render as always-active blocks (### title), not index rows
		const pinnedAt = r.systemPrompt!.indexOf("### prefers-中文");
		const projAt = r.systemPrompt!.indexOf("build-flow (p1.md) — ");
		expect(pinnedAt).toBeGreaterThan(-1);
		expect(projAt).toBeGreaterThan(-1);
		expect(pinnedAt).toBeLessThan(projAt);
		expect(r.systemPrompt).toContain("所有回复默认中文");
		expect(r.systemPrompt).toContain("You have persistent PROJECT memory at");
		expect(r.systemPrompt).toContain("Project memory index");
	});

	it("lane budget: pinned section + project index stay inside MEMORY_INDEX_MAX (policy text rides on top, as at HEAD)", () => {
		const pinned = {
			entries: [],
			files: [{ entry: { file: "pin.md", title: "pin", description: "d", type: "user", pinned: true }, body: "P".repeat(1200) }],
		};
		const project = Array.from({ length: 200 }, (_, i) => ({ title: `p${i}`, description: "y".repeat(900), file: `p${i}.md` }));
		const text = buildPolicyInjection(pinned, project, "/t/canonical/memory");
		const policyBytes = Buffer.byteLength(policyCompact("/t/canonical/memory"), "utf8");
		// the index sections clamp to the lane; the policy block is the fixed
		// on-top prefix (same accounting as the old two-layer sections)
		expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(MEMORY_INDEX_MAX + policyBytes);
	});

	it("oversized pinned bodies are dropped whole, never truncated mid-file", () => {
		const big = { entry: { file: "big.md", title: "big", description: "d", type: "user", pinned: true }, body: "B".repeat(PINNED_TOTAL_MAX + 1) };
		const text = buildPolicyInjection({ entries: [], files: [big] }, [], "/t/memory");
		expect(text).not.toContain("### big");
		expect(text).toContain("1 pinned file(s) dropped");
	});

	it("6th pinned file beyond the 5-file cap is reported in the drop warning", () => {
		const files = Array.from({ length: 6 }, (_, i) => ({
			entry: { file: `p${i}.md`, title: `p${i}`, description: "d", type: "user", pinned: true },
			body: `rule ${i}`,
		}));
		const text = buildPolicyInjection({ entries: [], files }, [], "/t/memory");
		expect(text).toContain("### p4");
		expect(text).not.toContain("### p5");
		expect(text).toContain("1 pinned file(s) dropped");
	});
});

describe("V2-M1 selection pooling (project-only since the user layer retired)", () => {
	it("before_agent_start delivers project files with the memory/ header as a persisted message", async () => {
		writeMemory("project", "build.md", "build", "build command", "project", "bun run check");
		const log: Array<{ query: string; candidates: string[] }> = [];
		const host = setupWithSelector(["memory/build.md"], log);
		const ctx = recallCtx(host, { cwd: project });
		await host.fire("session_start", {}, ctx);
		const r = (await host.fire("before_agent_start", { messageType: "user", systemPrompt: "BASE", prompt: "回复语言偏好是什么 language preference" }, ctx)) as {
			message?: { customType: string; content: Array<{ text: string }>; display: boolean; details: { v: number; delivery: string } };
		};
		expect(r?.message?.customType).toBe("pi-memory-recall");
		expect(r.message!.content[0].text).toContain("(memory/build.md)");
		expect(r.message!.display).toBe(false);
		expect(r.message!.details.v).toBe(1);
		expect(r.message!.details.delivery).toBe("immediate");
		expect(log[0]!.candidates).toEqual(["memory/build.md"]); // project-only pool
	});
});

describe("V2-M1 guard + retired layer", () => {
	it("writes into the retired USER layer are blocked outright (before any secret probe)", async () => {
		const { udir } = dirs();
		const host = setup();
		const ctx = host.makeCtx({ cwd: project, ui: true });
		await host.fire("session_start", {}, ctx);
		const blocked = await host.fire(
			"tool_call",
			{ toolName: "write", input: { path: join(udir, "leak.md"), content: "token = ghp_" + "a".repeat(40) } },
			ctx,
		);
		expect(blocked).toMatchObject({ block: true });
		expect((blocked as { reason?: string }).reason).toContain("retired");
		// direct call form as well
		expect(guardMemoryWrites("write", { path: join(udir, "x.md"), content: "sk-abcdef123456abcdef123456" }, udir).block).toBe(true);
	});
});

describe("V2-M1 regression — single-layer behaviors", () => {
	it("empty project index degrades cleanly; unpinned retired-dir files stay out of the injection", async () => {
		writeMemory("user", "u1.md", "unpinned", "an unpinned user note", "user", "some note");
		writeMemory("project", "p1.md", "build-flow", "how to build", "project", "bun run check");
		const host = setup();
		const ctx = host.makeCtx({ cwd: project, ui: true });
		await host.fire("session_start", {}, ctx);
		const handler = host.handlers.get("before_agent_start")![0] as (e: unknown, c: unknown) => Promise<{ systemPrompt?: string }>;
		const r = (await handler({ systemPrompt: "BASE" }, ctx))!;
		expect(r.systemPrompt).not.toContain("Pinned memories");
		expect(r.systemPrompt).not.toContain("(u1.md)"); // unpinned retired-dir files stay out
		expect(r.systemPrompt).toContain("build-flow (p1.md) — ");
	});

	it("buildPolicyInjection keeps one <memory-policy> block", () => {
		const injection = buildPolicyInjection(
			{ entries: [] },
			[{ title: "p", description: "d", file: "p.md" }],
			"/t/canonical/memory",
		);
		expect(injection.split("<memory-policy>").length - 1).toBe(1);
	});
});

describe("V2 data-safety (Phase 0 D2/D3)", () => {
	it("D2: dot-prefixed .tmp-*.md leftovers are invisible to scans, index, and stats", () => {
		const { dir } = dirs();
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, ".tmp-123-abc.md"), "---\nname: zombie\ndescription: torn write\nmetadata:\n  type: project\n---\n\nbody");
		writeMemory("project", "real.md", "real", "real fact");
		const { entries, skipped } = scanMemoryDir(dir);
		expect(entries.map((e) => e.file)).toEqual(["real.md"]);
		expect(skipped).toBe(0); // invisible, not even counted as invalid
		reindex(dir);
		const index = readFileSync(join(dir, "MEMORY.md"), "utf-8");
		expect(index).not.toContain("zombie");
		expect(layerStats(dir).files).toBe(1);
	});

	it("D3: on-disk pinned file renders the always-active section through the real hook chain", async () => {
		writeMemory("user", "pin.md", "always-zh", "replies in chinese", "user", "所有回复默认中文", true);
		const host = setup();
		const ctx = host.makeCtx({ cwd: project, ui: true });
		await host.fire("session_start", {}, ctx);
		const handler = host.handlers.get("before_agent_start")![0] as (e: unknown, c: unknown) => Promise<{ systemPrompt?: string }>;
		const r = (await handler({ systemPrompt: "BASE" }, ctx))!;
		expect(r.systemPrompt).toContain("Pinned memories (always active)");
		expect(r.systemPrompt).toContain("### always-zh");
	});
});

describe("V2 Phase 3 (AD1/AD3/AD4) — injection dedupe + policy text", () => {
	it("RV-06: a prior recall entry in the history never re-enters the manifest (hard dedup, replaces billing-only MR-05)", async () => {
		writeMemory("project", "lang.md", "language", "replies language chinese", "project", "所有回复默认中文");
		const log: Array<{ query: string; candidates: string[] }> = [];
		const host = setupWithSelector(["memory/lang.md"], log);
		const priorRecall = {
			role: "custom",
			customType: "pi-memory-recall",
			details: { v: 1, delivery: "immediate", model: "test/selector-1", files: [{ key: "memory/lang.md", bytes: 120, truncated: false }], bytes: 200, elapsedMs: 1 },
		};
		const ctx = recallCtx(host, { cwd: project, projectionMessages: [priorRecall] });
		await host.fire("session_start", {}, ctx);
		const r = (await host.fire("before_agent_start", { messageType: "user", systemPrompt: "BASE", prompt: "回复语言偏好是什么 language preference" }, ctx)) as { message?: unknown };
		expect(r?.message).toBeUndefined(); // the only candidate is deduped → nothing eligible
		expect(log.length).toBe(0); // RV-06: dedup happens BEFORE the selector is paid for
	});

	it("RV-07: a read toolCall in the history excludes the file; without it the file is selectable", async () => {
		writeMemory("project", "lang2.md", "language2", "replies language chinese", "project", "所有回复默认中文");
		const { dir } = dirs();
		const log: Array<{ query: string; candidates: string[] }> = [];
		const host = setupWithSelector(["memory/lang2.md"], log);
		const readHistory = [
			{ role: "user", content: [{ type: "text", text: "上一条消息" }] },
			{ role: "assistant", content: [{ type: "toolCall", name: "read", arguments: { path: join(dir, "lang2.md") } }] },
		];
		const ctxRead = recallCtx(host, { cwd: project, projectionMessages: readHistory });
		await host.fire("session_start", {}, ctxRead);
		const r1 = (await host.fire("before_agent_start", { messageType: "user", systemPrompt: "BASE", prompt: "回复语言偏好是什么 language preference" }, ctxRead)) as { message?: unknown };
		expect(r1?.message).toBeUndefined();
		expect(log.length).toBe(0); // read suppression empties the candidate set → no selector call
		// history without the read (post-compaction rebuild) → selectable again
		const ctxClean = recallCtx(host, { cwd: project, projectionMessages: [] });
		const r2 = (await host.fire("before_agent_start", { messageType: "user", systemPrompt: "BASE", prompt: "回复语言偏好是什么 language preference" }, ctxClean)) as { message?: unknown };
		expect((r2?.message as { content: Array<{ text: string }> } | undefined)?.content?.[0]?.text).toContain("(memory/lang2.md)");
	});

	it("AD2/AD3/AD4: graded age header; policy no longer teaches manual index edits and points at direct writes", async () => {
		const now = Date.now();
		expect(freshnessHeader(now - 2 * 60 * 60 * 1000, undefined, now)).toBeNull();
		expect(freshnessHeader(now - 3 * 24 * 60 * 60 * 1000, undefined, now)).toBe("[3 days ago]");
		expect(freshnessHeader(now - 47 * 24 * 60 * 60 * 1000, undefined, now)).toContain("47 days ago");
		const policy = policyCompact("/home/u/.pi/agent/projects/-Users-x-Coding-repo/memory");
		expect(policy).not.toContain("Update MEMORY.md");
		expect(policy).toContain("already exist — write files"); // text wraps; assert the first line only
		// path-mismatch regression pin (2026-10-03): the project line must carry
		// the REAL interpolated dir, never the literal `<project>/memory/`
		expect(policy).toContain("PROJECT memory at /home/u/.pi/agent/projects/-Users-x-Coding-repo/memory");
		expect(policy).not.toContain("<project>/memory/");
		expect(policy).toContain("NOT in a memory/");
		// retirement pins: the model must not reinvent the cross-project layer
		expect(policy).toContain("user layer is retired");
		expect(policy).toContain("Never write");
	});

	it("AD2: reading a stale memory file gets a staleness note appended to the tool result", async () => {
		const { utimesSync } = await import("node:fs");
		writeMemory("project", "old.md", "old-fact", "an old fact", "project", "fact text");
		const file = join(dirs().dir, "old.md");
		utimesSync(file, new Date(Date.now() - 30 * 24 * 3600 * 1000), new Date(Date.now() - 30 * 24 * 3600 * 1000));
		const host = setup();
		const ctx = host.makeCtx({ cwd: project, ui: true });
		await host.fire("session_start", {}, ctx);
		const r = (await host.fire("tool_result", { toolName: "read", input: { path: file }, content: [{ type: "text", text: "fact text" }] }, ctx)) as { content?: Array<{ text?: string }> };
		expect(r?.content?.at(-1)?.text).toContain("30 days ago");
	});
});
