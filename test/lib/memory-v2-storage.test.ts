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
import { userLayerSection, projectLayerSection, buildPolicyInjection } from "../../extensions/memory/policy.ts";
import { guardMemoryWrites } from "../../extensions/memory/guard.ts";
import { USER_INDEX_MAX, PINNED_TOTAL_MAX } from "../../extensions/memory/constants.ts";
import { layerStats } from "../../extensions/memory/store.js";
import { MEMORY_INDEX_MAX } from "../../lib/context-budget.js";
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
		expect(user.bytes).toBeLessThanOrEqual(USER_INDEX_MAX + 120); // header allowance
		const project = projectLayerSection(
			Array.from({ length: 40 }, (_, i) => ({ title: `p${i}`, description: "y".repeat(900), file: `p${i}.md` })),
			user.bytes,
		);
		// combined stays inside the lane
		expect(user.bytes + project.bytes).toBeLessThanOrEqual(MEMORY_INDEX_MAX + 200);
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
		expect(section.bytes).toBeLessThanOrEqual(USER_INDEX_MAX + 120);
	});

	it("oversized pinned bodies are dropped whole, never truncated mid-file", () => {
		const big = { entry: { file: "big.md", title: "big", description: "d", type: "user", pinned: true }, body: "B".repeat(PINNED_TOTAL_MAX + 1) };
		const section = userLayerSection({ entries: [], files: [big] });
		expect(section.text).not.toContain("Pinned memories");
	});
});

describe("V2-M1 selection pooling", () => {
	it("context hook injects user-layer files with the user-memory/ header", async () => {
		writeMemory("user", "lang.md", "language", "replies language chinese", "user", "所有回复默认中文");
		writeMemory("project", "build.md", "build", "build command", "project", "bun run check");
		const host = setup();
		const ctx = host.makeCtx({ cwd: project, ui: true });
		await host.fire("session_start", {}, ctx);
		const handler = host.handlers.get("context")![0] as (e: unknown, c: unknown) => Promise<{ messages?: Array<Record<string, unknown>> } | undefined>;
		const r = (await handler(
			{ messages: [{ role: "user", content: [{ type: "text", text: "回复语言偏好是什么 language preference" }] }] },
			ctx,
		))!;
		const injection = r.messages!.at(-1) as { customType: string; content: Array<{ text: string }> };
		expect(injection.customType).toBe("pi-memory-recall");
		expect(injection.content[0].text).toContain("(user-memory/lang.md)");
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
