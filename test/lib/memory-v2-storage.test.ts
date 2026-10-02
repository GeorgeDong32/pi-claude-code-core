/**
 * V2-M1 (DESIGN-MEMORY-V2 §1/§2) — two-layer storage + write path tests.
 *
 * User layer: ~/.pi/agent/memory (same per-file format, own MEMORY.md index);
 * project layer unchanged. Lane budget stays ≤ MEMORY_INDEX_MAX total.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FakeHost, clearCoreGlobals, snapshotCoreGlobals } from "../contracts/fake-host.ts";
import { resetCoreBusForTests } from "../../extensions/bus.ts";
import memoryExtension from "../../extensions/memory/index.ts";
import { parseMemoryFrontmatter, scanMemoryDir, reconcileMemoryIndex } from "../../extensions/memory/memdir.ts";
import { resolveMemoryPaths, isMemoryWritePath } from "../../extensions/memory/paths.ts";
import { freshnessHeader } from "../../extensions/memory/recall.ts";
import type { Selector, SelectorOutcome } from "../../extensions/memory/selector.ts";
import { userLayerSection, projectLayerSection, buildPolicyInjection, POLICY_COMPACT } from "../../extensions/memory/policy.ts";
import { guardMemoryWrites } from "../../extensions/memory/guard.ts";
import { USER_INDEX_MAX, PINNED_TOTAL_MAX } from "../../extensions/memory/policy.ts";
import { layerStats } from "../../extensions/memory/store.ts";
import { MEMORY_INDEX_MAX } from "../../lib/context-budget.ts";
import { targets } from "../contracts/targets.ts";

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
	writeFileSync(join(home, ".pi", "agent", "settings.json"), JSON.stringify({ memory: { recallModel: "test/selector-1" } }));
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
	it("user layer resolves to <agentDir>/memory alongside the project layer", () => {
		const p = resolveMemoryPaths(project, home);
		expect(p.userMemoryDir).toBe(join(home, ".pi", "agent", "memory"));
		expect(p.memoryDir).not.toBe(p.userMemoryDir);
	});

	it("isMemoryWritePath accepts both layers, rejects siblings", () => {
		const { dir, udir } = dirs();
		expect(isMemoryWritePath(join(dir, "a.md"), project, home)).toBe(true);
		expect(isMemoryWritePath(join(udir, "a.md"), project, home)).toBe(true);
		expect(isMemoryWritePath(`${dir}-evil/a.md`, project, home)).toBe(false);
		expect(isMemoryWritePath(join(home, "plain", "a.md"), project, home)).toBe(false);
	});

	it("parseMemoryFrontmatter reads pinned true/false and stays valid otherwise", () => {
		expect(parseMemoryFrontmatter("---\nname: a\ndescription: d\nmetadata:\n  type: user\n  pinned: true\n---\n\nb")?.pinned).toBe(true);
		expect(parseMemoryFrontmatter("---\nname: a\ndescription: d\nmetadata:\n  type: user\n  pinned: false\n---\n\nb")?.pinned).toBe(false);
		expect(parseMemoryFrontmatter("---\nname: a\ndescription: d\nmetadata:\n  type: user\n---\n\nb")?.pinned).toBe(false);
	});
});

describe("V2-M1 two-layer injection", () => {
	it("before_agent_start injects one policy block + user index first + project index second", async () => {
		writeMemory("user", "u1.md", "prefers-中文", "user prefers chinese replies", "user", "所有回复默认中文");
		writeMemory("project", "p1.md", "build-flow", "how to build", "project", "bun run check");
		const host = setup();
		const ctx = host.makeCtx({ cwd: project, ui: true });
		await host.fire("session_start", {}, ctx);
		const handler = host.handlers.get("before_agent_start")![0] as (e: unknown, c: unknown) => Promise<{ systemPrompt?: string }>;
		const r = (await handler({ systemPrompt: "BASE" }, ctx))!;
		expect(r.systemPrompt!.split("<memory-policy>").length - 1).toBe(1);
		const userAt = r.systemPrompt!.indexOf("[prefers-中文](u1.md)");
		const projAt = r.systemPrompt!.indexOf("[build-flow](p1.md)");
		expect(userAt).toBeGreaterThan(-1);
		expect(projAt).toBeGreaterThan(-1);
		expect(userAt).toBeLessThan(projAt);
		expect(r.systemPrompt).toContain("User memory index");
		expect(r.systemPrompt).toContain("Project memory index");
	});

	it("lane budget: user section cap leaves the project section the remainder of MEMORY_INDEX_MAX", () => {
		// 8 user entries with ~1KB descriptions ≈ 8KB → user layer saturates
		const userEntries = Array.from({ length: 8 }, (_, i) => ({
			title: `u${i}`,
			description: "x".repeat(980),
			file: `u${i}.md`,
		}));
		const user = userLayerSection({ entries: userEntries, files: [] });
		expect(user.bytes).toBeLessThanOrEqual(USER_INDEX_MAX); // B5: exact, no header allowance
		const project = projectLayerSection(
			Array.from({ length: 40 }, (_, i) => ({ title: `p${i}`, description: "y".repeat(900), file: `p${i}.md` })),
			user.bytes,
		);
		// combined stays inside the lane — hard bound (B5)
		expect(user.bytes + project.bytes).toBeLessThanOrEqual(MEMORY_INDEX_MAX);
	});

	it("pinned bodies render in the user section, capped at 5 files / PINNED_TOTAL_MAX bytes", () => {
		const mk = (i: number, body: string) => ({
			entry: { file: `pin${i}.md`, title: `pin${i}`, description: "d", type: "user", pinned: true },
			body,
		});
		const files = [
			...Array.from({ length: 6 }, (_, i) => mk(i, `Pinned body ${i} — always active rule ${i}`)), // 6th dropped
			{ entry: { file: "plain.md", title: "plain", description: "d", type: "user" }, body: "never in pinned section" },
		];
		const section = userLayerSection({ entries: [], files });
		expect(section.text).toContain("Pinned memories (always active)");
		expect(section.text).toContain("### pin0");
		expect(section.text).toContain("### pin4");
		expect(section.text).not.toContain("### pin5");
		expect(section.text).not.toContain("never in pinned section");
		expect(section.bytes).toBeLessThanOrEqual(USER_INDEX_MAX);
	});

	it("oversized pinned bodies are dropped whole, never truncated mid-file", () => {
		const big = { entry: { file: "big.md", title: "big", description: "d", type: "user", pinned: true }, body: "B".repeat(PINNED_TOTAL_MAX + 1) };
		const section = userLayerSection({ entries: [], files: [big] });
		expect(section.text).not.toContain("Pinned memories");
	});
});

describe("V2-M1 selection pooling (RV semantics)", () => {
	it("before_agent_start delivers user-layer files with the user-memory/ header as a persisted message", async () => {
		writeMemory("user", "lang.md", "language", "replies language chinese", "user", "所有回复默认中文");
		writeMemory("project", "build.md", "build", "build command", "project", "bun run check");
		const log: Array<{ query: string; candidates: string[] }> = [];
		const host = setupWithSelector(["user-memory/lang.md"], log);
		const ctx = recallCtx(host, { cwd: project });
		await host.fire("session_start", {}, ctx);
		const r = (await host.fire("before_agent_start", { systemPrompt: "BASE", prompt: "回复语言偏好是什么 language preference" }, ctx)) as {
			message?: { customType: string; content: Array<{ text: string }>; display: boolean; details: { v: number; delivery: string } };
		};
		expect(r?.message?.customType).toBe("pi-memory-recall");
		expect(r.message!.content[0].text).toContain("(user-memory/lang.md)");
		expect(r.message!.display).toBe(false);
		expect(r.message!.details.v).toBe(1);
		expect(r.message!.details.delivery).toBe("immediate");
		expect(log[0]!.candidates).toContain("user-memory/lang.md");
		expect(log[0]!.candidates).toContain("memory/build.md");
	});
});

describe("V2-M1 guard + carve-out", () => {
	it("secret guard blocks writes into the USER layer too", async () => {
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
		// direct call form as well
		expect(guardMemoryWrites("write", { path: join(udir, "x.md"), content: "sk-abcdef123456abcdef123456" }, udir).block).toBe(true);
	});

	it("modes carve-out skips the approval dialog for USER-layer writes (V2-D2)", async () => {
		const { udir } = dirs();
		mkdirSync(udir, { recursive: true });
		const host = new FakeHost();
		targets.modes.factory(host.asPi());
		const ctx = host.makeCtx({ cwd: project, ui: true });
		await host.fire("session_start", {}, ctx);
		// ask-mode write into the user memory dir must NOT prompt (returns
		// undefined → allowed), mirroring the project-layer carve-out test
		const r = await host.fire(
			"tool_call",
			{ toolCallId: "t1", toolName: "write", input: { path: join(udir, "pref.md"), content: "---\nname: p\ndescription: d\nmetadata:\n  type: user\n---\n\nb" } },
			ctx,
		);
		expect(r).toBeUndefined();
	});
});

describe("V2-M1 regression — single-layer behaviors", () => {
	it("empty user dir degrades cleanly (empty section, project intact)", async () => {
		writeMemory("project", "p1.md", "build-flow", "how to build", "project", "bun run check");
		const host = setup();
		const ctx = host.makeCtx({ cwd: project, ui: true });
		await host.fire("session_start", {}, ctx);
		const handler = host.handlers.get("before_agent_start")![0] as (e: unknown, c: unknown) => Promise<{ systemPrompt?: string }>;
		const r = (await handler({ systemPrompt: "BASE" }, ctx))!;
		expect(r.systemPrompt).toContain("User memory index: (empty)");
		expect(r.systemPrompt).toContain("[build-flow](p1.md)");
	});

	it("buildPolicyInjection keeps one <memory-policy> block for both layers", () => {
		const injection = buildPolicyInjection(
			{ entries: [{ title: "u", description: "d", file: "u.md" }] },
			[{ title: "p", description: "d", file: "p.md" }],
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
		reconcileMemoryIndex(dir);
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

describe("V2 Phase 2 (B5) — exact lane accounting", () => {
	it("oversized pinned block is dropped whole with a trailing warning comment", () => {
		const big = { entry: { file: "big.md", title: "big", description: "d", type: "user", pinned: true }, body: "B".repeat(1500) };
		const section = userLayerSection({ entries: [], files: [big] });
		expect(section.text).not.toContain("### big");
		expect(section.text).toContain("1 pinned file(s) dropped");
		expect(section.bytes).toBeLessThanOrEqual(USER_INDEX_MAX);
	});

	it("6th pinned file beyond the 5-file cap is reported in the drop warning", () => {
		const files = Array.from({ length: 6 }, (_, i) => ({
			entry: { file: `p${i}.md`, title: `p${i}`, description: "d", type: "user", pinned: true },
			body: `rule ${i}`,
		}));
		const section = userLayerSection({ entries: [], files });
		expect(section.text).toContain("### p4");
		expect(section.text).not.toContain("### p5");
		expect(section.text).toContain("1 pinned file(s) dropped");
	});
});

describe("V2 Phase 3 (AD1/AD3/AD4) — injection dedupe + policy text", () => {
	it("RV-06: a prior recall entry in the history never re-enters the manifest (hard dedup, replaces billing-only MR-05)", async () => {
		writeMemory("user", "lang.md", "language", "replies language chinese", "user", "所有回复默认中文");
		const log: Array<{ query: string; candidates: string[] }> = [];
		const host = setupWithSelector(["user-memory/lang.md"], log);
		const priorRecall = {
			role: "custom",
			customType: "pi-memory-recall",
			details: { v: 1, delivery: "immediate", model: "test/selector-1", files: [{ key: "user-memory/lang.md", bytes: 120, truncated: false }], bytes: 200, elapsedMs: 1 },
		};
		const ctx = recallCtx(host, { cwd: project, projectionMessages: [priorRecall] });
		await host.fire("session_start", {}, ctx);
		const r = (await host.fire("before_agent_start", { systemPrompt: "BASE", prompt: "回复语言偏好是什么 language preference" }, ctx)) as { message?: unknown };
		expect(r?.message).toBeUndefined(); // the only candidate is deduped → nothing eligible
		expect(log.length).toBe(0); // RV-06: dedup happens BEFORE the selector is paid for
	});

	it("RV-07: a read toolCall in the history excludes the file; without it the file is selectable", async () => {
		writeMemory("user", "lang2.md", "language2", "replies language chinese", "user", "所有回复默认中文");
		const { udir } = dirs();
		const log: Array<{ query: string; candidates: string[] }> = [];
		const host = setupWithSelector(["user-memory/lang2.md"], log);
		const readHistory = [
			{ role: "user", content: [{ type: "text", text: "上一条消息" }] },
			{ role: "assistant", content: [{ type: "toolCall", name: "read", arguments: { path: join(udir, "lang2.md") } }] },
		];
		const ctxRead = recallCtx(host, { cwd: project, projectionMessages: readHistory });
		await host.fire("session_start", {}, ctxRead);
		const r1 = (await host.fire("before_agent_start", { systemPrompt: "BASE", prompt: "回复语言偏好是什么 language preference" }, ctxRead)) as { message?: unknown };
		expect(r1?.message).toBeUndefined();
		expect(log.length).toBe(0); // read suppression empties the candidate set → no selector call
		// history without the read (post-compaction rebuild) → selectable again
		const ctxClean = recallCtx(host, { cwd: project, projectionMessages: [] });
		const r2 = (await host.fire("before_agent_start", { systemPrompt: "BASE", prompt: "回复语言偏好是什么 language preference" }, ctxClean)) as { message?: unknown };
		expect((r2?.message as { content: Array<{ text: string }> } | undefined)?.content?.[0]?.text).toContain("(user-memory/lang2.md)");
	});

	it("AD2/AD3/AD4: graded age header; policy no longer teaches manual index edits and points at direct writes", async () => {
		const now = Date.now();
		expect(freshnessHeader(now - 2 * 60 * 60 * 1000, now)).toBeNull();
		expect(freshnessHeader(now - 3 * 24 * 60 * 60 * 1000, now)).toBe("[3 days ago]");
		expect(freshnessHeader(now - 47 * 24 * 60 * 60 * 1000, now)).toContain("47 days ago");
		expect(POLICY_COMPACT).not.toContain("Update MEMORY.md");
		expect(POLICY_COMPACT).toContain("already exist — write files directly");
	});

	it("AD2: reading a stale memory file gets a staleness note appended to the tool result", async () => {
		const { utimesSync } = await import("node:fs");
		writeMemory("user", "old.md", "old-fact", "an old fact", "user", "fact text");
		const file = join(dirs().udir, "old.md");
		utimesSync(file, new Date(Date.now() - 30 * 24 * 3600 * 1000), new Date(Date.now() - 30 * 24 * 3600 * 1000));
		const host = setup();
		const ctx = host.makeCtx({ cwd: project, ui: true });
		await host.fire("session_start", {}, ctx);
		const r = (await host.fire("tool_result", { toolName: "read", input: { path: file }, content: [{ type: "text", text: "fact text" }] }, ctx)) as { content?: Array<{ text?: string }> };
		expect(r?.content?.at(-1)?.text).toContain("30 days ago");
	});
});
