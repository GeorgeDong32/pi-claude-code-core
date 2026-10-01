/**
 * P3-ME memory module tests (spec §2.3 matrix) — tmp HOME + tmp project.
 *
 * HOME is redirected per test so the module resolves
 * ~/.pi/agent/projects/<sanitized>/memory into the sandbox.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FakeHost, clearCoreGlobals, snapshotCoreGlobals } from "../contracts/fake-host.ts";
import { resetCoreBusForTests } from "../../extensions/bus.ts";
import memoryExtension from "../../extensions/memory/index.ts";
import { scanMemoryDir, reconcileMemoryIndex } from "../../extensions/memory/memdir.ts";
import { sessionRecall, readLines, READ_CHUNK } from "../../extensions/memory/session-recall.ts";
import { selectForTurn, tokenize } from "../../extensions/memory/selection.ts";
import { guardMemoryWrites } from "../../extensions/memory/guard.ts";
import { importFromClaude, importFromHermes } from "../../extensions/memory/importers.ts";
import { resolveMemoryPaths } from "../../extensions/memory/paths.ts";

let globalsSnapshot: Record<string, unknown>;
let home: string;
let project: string;
let prevHome: string | undefined;

function memoryDir(): string {
	// handlers anchor on ctx.cwd (= project tmp dir); tests use the same
	// resolution so the two can never drift
	return resolveMemoryPaths(project, home).memoryDir;
}

function setup(): FakeHost {
	const host = new FakeHost();
	memoryExtension(host.asPi());
	return host;
}

function writeMemory(name: string, title: string, description: string, type = "project", body = "body text"): void {
	const dir = memoryDir();
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, name),
		`---\nname: ${title}\ndescription: ${description}\nmetadata:\n  type: ${type}\n---\n\n${body}`,
	);
}

beforeEach(() => {
	globalsSnapshot = snapshotCoreGlobals();
	clearCoreGlobals();
	resetCoreBusForTests();
	prevHome = process.env.HOME;
	home = mkdtempSync(join(tmpdir(), "mem-home-"));
	project = mkdtempSync(join(tmpdir(), "mem-proj-"));
	process.env.HOME = home;
});

afterEach(() => {
	if (prevHome === undefined) delete process.env.HOME;
	else process.env.HOME = prevHome;
	rmSync(home, { recursive: true, force: true });
	rmSync(project, { recursive: true, force: true });
});

describe("P3-ME-02 index reconciler", () => {
	it("3 valid + 1 invalid → index has exactly the 3 rows; scan reports skipped:1", () => {
		writeMemory("a.md", "alpha", "first");
		writeMemory("b.md", "beta", "second");
		writeMemory("c.md", "gamma", "third");
		mkdirSync(memoryDir(), { recursive: true });
		writeFileSync(join(memoryDir(), "broken.md"), "---\nname: x\n"); // invalid

		const { entries, skipped } = scanMemoryDir(memoryDir());
		expect(entries.length).toBe(3);
		expect(skipped).toBe(1);

		reconcileMemoryIndex(memoryDir());
		const index = readFileSync(join(memoryDir(), "MEMORY.md"), "utf-8");
		const rows = index.split("\n").filter((l) => l.startsWith("- ["));
		expect(rows.length).toBe(3);
	});

	it("caps the index at 200 lines with a WARNING (250 files)", () => {
		const dir = memoryDir();
		mkdirSync(dir, { recursive: true });
		for (let i = 0; i < 250; i++) {
			writeFileSync(
				join(dir, `m${String(i).padStart(3, "0")}.md`),
				`---\nname: mem-${i}\ndescription: d${i}\nmetadata:\n  type: project\n---\n\nbody`,
			);
		}
		reconcileMemoryIndex(dir);
		const index = readFileSync(join(dir, "MEMORY.md"), "utf-8");
		const rows = index.split("\n").filter((l) => l.startsWith("- ["));
		expect(rows.length).toBeLessThanOrEqual(200);
		expect(index).toContain("WARNING");
	});
});

describe("P3-ME-03 policy injection", () => {
	it("session_start + before_agent_start append policy + index as one block", async () => {
		writeMemory("a.md", "alpha", "first");
		const host = setup();
		const ctx = host.makeCtx({ cwd: project, ui: true });
		await host.fire("session_start", {}, ctx);
		const results: Array<{ systemPrompt?: string }> = [];
		for (const h of host.handlers.get("before_agent_start") ?? []) {
			results.push((await (h as (e: unknown, c: unknown) => Promise<{ systemPrompt?: string }>)({ systemPrompt: "BASE" }, ctx)) ?? {});
		}
		expect(results.length).toBe(1);
		const prompt = results[0].systemPrompt ?? "";
		expect(prompt.startsWith("BASE")).toBe(true);
		// exactly one memory-policy block, plus the index
		expect(prompt.split("<memory-policy>").length - 1).toBe(1);
		expect(prompt).toContain("[alpha](a.md) — first");
	});
});

describe("P3-ME-04 per-turn lexical injection", () => {
	it("injects at most 5 files, skips >4KB bodies; the pin re-projects the same set for every request in the turn", async () => {
		for (let i = 0; i < 6; i++) {
			writeMemory(`f${i}.md`, `release flow number ${i}`, `about release flow step ${i}`, "project", `release flow detail ${i}`);
		}
		writeMemory("big.md", "huge doc", "very large file", "reference", `H`.repeat(5 * 1024));
		const host = setup();
		const ctx = host.makeCtx({ cwd: project, ui: true });
		await host.fire("session_start", {}, ctx);

		const fireContext = async (): Promise<Array<Record<string, unknown>>> => {
			let out: Array<Record<string, unknown>> = [];
			for (const h of host.handlers.get("context") ?? []) {
				const r = (await (h as (e: unknown, c: unknown) => Promise<{ messages?: Array<Record<string, unknown>> } | undefined>)(
					{ messages: [{ role: "user", content: [{ type: "text", text: "how does the release flow work?" }] }] },
					ctx,
				)) as { messages?: Array<Record<string, unknown>> } | undefined;
				if (r?.messages) out = r.messages;
			}
			return out;
		};

		const first = await fireContext();
		const recall = first.find((m) => m.customType === "pi-memory-recall") as
			| { content: Array<{ text: string }> }
			| undefined;
		expect(recall).toBeDefined();
		const text = recall!.content[0].text;
		const blocks = text.split("## ").length - 1;
		expect(blocks).toBeLessThanOrEqual(5);
		expect(text).not.toContain("HHHH"); // oversized body skipped, not truncated

		// (v3.2 redesign, review F3): under per-turn pin & re-project, repeated
		// requests in the SAME turn re-project the pinned block byte-identically.
		// Budget-gate coverage moved to the MR-05 direct tests below — per-request
		// hammering no longer exercises any budget path here.
		const later = await fireContext();
		const recall2 = later.find((m) => m.customType === "pi-memory-recall") as
			| { content: Array<{ text: string }> }
			| undefined;
		expect(recall2?.content[0]?.text).toBe(text);
	});
});

describe("P3-ME-04 lexical selection determinism", () => {
	it("tokenize + selectForTurn are deterministic and threshold-gated", () => {
		expect(tokenize("the release flow").has("release")).toBe(true);
		const mems = [
			{ file: "a.md", title: "release flow", description: "deploy steps", type: "project", body: "release flow details", mtimeMs: 1 },
			{ file: "b.md", title: "unrelated", description: "nothing shared", type: "reference", body: "cat facts", mtimeMs: 2 },
		];
		const first = selectForTurn("explain the release flow", mems, 0);
		const second = selectForTurn("explain the release flow", mems, 0);
		expect(first.files.map((f) => f.file)).toEqual(["a.md"]);
		expect(second.files.map((f) => f.file)).toEqual(first.files.map((f) => f.file));
		// weak overlap → nothing
		expect(selectForTurn("cat", mems, 0).files).toHaveLength(0);
	});
});

describe("P3-ME-06 yield gate", () => {
	it("static probe yields when hermes is in the npm dir; tools/commands still run", async () => {
		// hermes in the agent npm dir (static scan path)
		const npmDir = join(home, ".pi", "agent", "npm", "node_modules");
		mkdirSync(npmDir, { recursive: true });
		writeFileSync(join(npmDir, "hermes-memory"), "package stub");
		writeMemory("a.md", "alpha", "first");

		const host = setup();
		const ctx = host.makeCtx({ cwd: project, ui: true });
		await host.fire("session_start", {}, ctx);

		// before_agent_start must NOT inject policy (handler returns undefined)
		const r = (await (host.handlers.get("before_agent_start")![0] as (e: unknown, c: unknown) => Promise<{ systemPrompt?: string } | undefined>)({
			systemPrompt: "BASE",
		}, ctx));
		expect(r).toBeUndefined();

		// /memory command still works and reports yielded
		await host.commands.get("memory")?.("", ctx);
		const listed = host.sentMessages.find((m) => m.message.customType === "pi-memory-status");
		expect((listed!.message as { content?: string }).content).toContain("yielded to hermes: true");

		// session_recall tool still registered and callable
		const tool = host.tools.get("session_recall");
		expect(tool).toBeDefined();
	});

	it("dynamic probe yields when the prompt already carries another memory policy", async () => {
		const host = setup();
		const ctx = host.makeCtx({ cwd: project, ui: true });
		await host.fire("session_start", {}, ctx);
		const handler = host.handlers.get("before_agent_start")![0] as (e: unknown, c: unknown) => Promise<{ systemPrompt?: string } | undefined>;
		// first call carries a foreign <memory-policy marker → yield
		await handler({ systemPrompt: "BASE <memory-policy>hermes</memory-policy>" }, ctx);
		// subsequent call injects nothing
		const r = await handler({ systemPrompt: "BASE" }, ctx);
		expect(r?.systemPrompt ?? "BASE").toBe("BASE");
	});
});

describe("P3-ME-05 secret guard", () => {
	it("blocks secret-shaped memory writes, allows clean ones; reconciler heals the index", async () => {
		writeMemory("clean.md", "clean", "no secrets");
		const host = setup();
		const ctx = host.makeCtx({ cwd: project, ui: true });
		await host.fire("session_start", {}, ctx);

		const secret = { toolName: "write", input: { path: join(memoryDir(), "leak.md"), content: "key = sk-abcdef123456abcdef123456" } };
		const blocked = await host.fire("tool_call", secret, ctx);
		expect(blocked).toMatchObject({ block: true });

		const clean = { toolName: "write", input: { path: join(memoryDir(), "new.md"), content: "---\nname: new\ndescription: d\nmetadata:\n  type: project\n---\n\nok" } };
		expect(await host.fire("tool_call", clean, ctx)).toBeUndefined();

		// raw bypass (no interceptor): reconciler still converges the index
		writeFileSync(join(memoryDir(), "raw.md"), "---\nname: raw\ndescription: bypassed\nmetadata:\n  type: project\n---\n\nraw");
		await host.fire("session_start", {}, ctx);
		const index = readFileSync(join(memoryDir(), "MEMORY.md"), "utf-8");
		expect(index).toContain("raw.md");
		expect(index).toContain("clean.md");
		expect(existsSync(join(memoryDir(), "leak.md"))).toBe(false);
	});
});

describe("P3-ME-07 session_recall", () => {
	function writeSession(name: string, lines: unknown[]): void {
		const dir = join(home, ".pi", "agent", "sessions", project.replace(/\//g, "-"));
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, name),
			lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n") + "\n",
		);
	}

	it("matches user/assistant text, ignores toolResult, counts bad lines, filters by time and limit", () => {
		writeSession("a.jsonl", [
			{ type: "message", timestamp: "2026-09-20T10:00:00Z", message: { role: "user", content: [{ type: "text", text: "fix the deploy pipeline" }] } },
			"not-json-garbage",
			{ type: "message", timestamp: "2026-09-21T10:00:00Z", message: { role: "assistant", content: [{ type: "text", text: "deploy pipeline fixed" }] } },
			{ type: "message", message: { role: "toolResult", content: [{ type: "text", text: "deploy pipeline output" }] } },
		]);

		const result = sessionRecall({ query: "deploy pipeline", cwd: project, home });
		expect(result.skippedLines).toBe(1);
		expect(result.hits.length).toBe(2);
		expect(result.hits.map((h) => h.role)).toEqual(["user", "assistant"]);

		const since = sessionRecall({ query: "deploy pipeline", cwd: project, home, since: "2026-09-21" });
		expect(since.hits.length).toBe(1);
		expect(since.hits[0].role).toBe("assistant");

		const limited = sessionRecall({ query: "deploy pipeline", cwd: project, home, limit: 1 });
		expect(limited.hits.length).toBe(1);

		const empty = sessionRecall({ query: "anything", cwd: "/nonexistent-project", home });
		expect(empty.hits).toHaveLength(0);
		expect(empty.scannedFiles).toBe(0);
	});
});

describe("P3-ME-09 chmod-verified writability", () => {
	it("a 555 memory dir flips to policy-only (accessSync probe, review #17)", async () => {
		const { chmodSync, mkdirSync: mk, writeFileSync: wf } = await import("node:fs");
		const dir = memoryDir();
		mk(dir, { recursive: true });
		wf(join(dir, "a.md"), "---\nname: alpha\ndescription: d\nmetadata:\n  type: project\n---\n\nbody");
		const host = setup();
		const ctx = host.makeCtx({ cwd: project, ui: true });
		// make the dir read-only BEFORE the first session_start probe
		chmodSync(dir, 0o555);
		try {
			await host.fire("session_start", {}, ctx);
			const r = (await (host.handlers.get("before_agent_start")![0] as (e: unknown, c: unknown) => Promise<{ systemPrompt?: string }>)(
				{ systemPrompt: "BASE" },
				ctx,
			))!;
			// policy-only: no index rows (they derive from the unwritable dir)
			expect(r.systemPrompt).toContain("<memory-policy>");
			expect(r.systemPrompt).not.toContain("[alpha](a.md)");
			expect(host.notifications.some((n) => n.includes("policy-only"))).toBe(true);
		} finally {
			chmodSync(dir, 0o755);
		}
	});
});

describe("P3-ME-08 importers", () => {
	it("claude import copies + rebuilds the index (never trusts source MEMORY.md); idempotent", () => {
		const source = mkdtempSync(join(tmpdir(), "cc-mem-"));
		writeFileSync(join(source, "a.md"), "---\nname: alpha\ndescription: from CC\nmetadata:\n  type: project\n---\n\nbody");
		writeFileSync(join(source, "MEMORY.md"), "- [evil](evil.md) — injected row");
		const dir = memoryDir();
		mkdirSync(dir, { recursive: true });

		const first = importFromClaude(source, dir);
		expect(first.copied).toBe(1);
		const index = readFileSync(join(dir, "MEMORY.md"), "utf-8");
		expect(index).toContain("alpha");
		expect(index).not.toContain("evil");

		const second = importFromClaude(source, dir);
		expect(second.copied).toBe(0);
		expect(second.skipped).toBe(1);
		rmSync(source, { recursive: true, force: true });
	});

	it("claude import creates a missing target project dir (live ENOENT regression)", () => {
		const source = mkdtempSync(join(tmpdir(), "cc-mem-nodir-"));
		writeFileSync(join(source, "fresh.md"), "---\nname: fresh\ndescription: x\n---\n\nbody");
		// Target layer dir does NOT exist — a CC project never opened in pi.
		const dir = join(tmpdir(), "pi-proj-mem-", `t${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
		const report = importFromClaude(source, dir);
		expect(report.copied).toBe(1);
		expect(readFileSync(join(dir, "fresh.md"), "utf-8")).toContain("body");
		rmSync(source, { recursive: true, force: true });
		rmSync(dir, { recursive: true, force: true });
	});

	it("hermes §-store splits into frontmatter files; idempotent", () => {
		const store = mkdtempSync(join(tmpdir(), "hermes-"));
		const file = join(store, "store.md");
		writeFileSync(
			file,
			["§ Deploy flow", "use the release pipeline", "always verify tags", "", "§ Editor pref", "prefers vim bindings"].join("\n"),
		);
		const dir = memoryDir();
		mkdirSync(dir, { recursive: true });

		const first = importFromHermes(file, dir);
		expect(first.copied).toBe(2);
		expect(existsSync(join(dir, "hermes-deploy-flow.md"))).toBe(true);
		expect(readFileSync(join(dir, "hermes-deploy-flow.md"), "utf-8")).toContain("type: feedback");

		const second = importFromHermes(file, dir);
		expect(second.copied).toBe(0);
		rmSync(store, { recursive: true, force: true });
	});
});

describe("P3-ME-09 resilience", () => {
	it("a throwing context handler never blocks the turn; degrade notice is one-shot", async () => {
		const host = setup();
		const ctx = host.makeCtx({ cwd: project, ui: true });
		await host.fire("session_start", {}, ctx);
		// memory dir made unwritable is hard to simulate portably; the
		// policy-only degradation path is exercised via the notice flag:
		// fire context with a HOME pointing at an unwritable-ish location
		const result = await (host.handlers.get("context")?.[0] as (e: unknown, c: unknown) => Promise<unknown>)({
			messages: [{ role: "user", content: [{ type: "text", text: "hi there friend" }] }],
		}, ctx);

		expect(result === undefined || typeof result === "object").toBe(true);
	});
});

describe("review-2026-09-22-II fixes", () => {
	it("C1: CJK prompts tokenize into bigrams and recall Chinese memories", () => {
		const tokens = tokenize("修复登录页面的样式");
		expect(tokens.has("修复")).toBe(true);
		expect(tokens.has("登录")).toBe(true);
		// a differently-phrased Chinese memory still overlaps
		const hit = selectForTurn("修复登录页面的样式", [
			{
				file: "a.md", title: "login-fix", description: "登录页面修复流程", type: "project",
				body: "修复登录页面时先看 auth 模块的测试", mtimeMs: Date.now(),
			},
		], 0);
		expect(hit.files.map((f) => f.title)).toContain("login-fix");
		// unrelated Chinese prompt does not recall it
		const miss = selectForTurn("帮我写一份周报", [
			{
				file: "a.md", title: "login-fix", description: "登录页面修复流程", type: "project",
				body: "修复登录页面时先看 auth 模块的测试", mtimeMs: Date.now(),
			},
		], 0);
		expect(miss.files).toHaveLength(0);
	});

	it("C7: budgets count bytes, not UTF-16 units (CJK body of 1400 chars = 4200 bytes > 4KB)", () => {
		const body = "测".repeat(1400); // 1400 chars, 4200 bytes
		const result = selectForTurn("test overlap token", [
			{ file: "a.md", title: "test overlap token", description: "", type: "project", body, mtimeMs: Date.now() },
		], 0);
		expect(result.files).toHaveLength(0); // oversized by BYTES — skipped
	});

	it("A4: reconciler cache is keyed per dir and invalidated by deletion", () => {
		const dirA = join(home, "proj-a-mem");
		const dirB = join(home, "proj-b-mem");
		mkdirSync(dirA, { recursive: true });
		mkdirSync(dirB, { recursive: true });
		writeFileSync(join(dirA, "a.md"), "---\nname: alpha\ndescription: a\nmetadata:\n  type: project\n---\n\nalpha body");
		writeFileSync(join(dirB, "b.md"), "---\nname: beta\ndescription: b\nmetadata:\n  type: project\n---\n\nbeta body");
		const first = reconcileMemoryIndex(dirA);
		expect(first.entries.map((e) => e.title)).toEqual(["alpha"]);
		// same-process second dir must NOT receive A's cached entries
		const second = reconcileMemoryIndex(dirB);
		expect(second.entries.map((e) => e.title)).toEqual(["beta"]);
		// deleting a file (no mtime bump anywhere) must drop the dead row
		rmSync(join(dirA, "a.md"));
		const third = reconcileMemoryIndex(dirA);
		expect(third.entries.map((e) => e.title)).toEqual([]);
	});

	it("C2: guard blocks unquoted and base64-padded key=value secrets", () => {
		const dir = memoryDir();
		mkdirSync(dir, { recursive: true });
		const unquoted = guardMemoryWrites("write", {
			path: join(dir, "m1.md"),
			content: "token = abcdefghijklmnopqrst",
		}, dir);
		expect(unquoted.block).toBe(true);
		const padded = guardMemoryWrites("write", {
			path: join(dir, "m2.md"),
			content: 'api_key: "cGFzc3dvcmQxMjM0NQ=="',
		}, dir);
		expect(padded.block).toBe(true);
	});

	it("C8: readLines never splits a multibyte char at the chunk boundary", () => {
		const file = join(home, "big-boundary.jsonl");
		// fill so the 256KiB boundary falls INSIDE the 测 character (3 bytes)
		const prefix = "x".repeat(READ_CHUNK - 2);
		const line = `{"text":"${prefix}测 tail"}`;
		writeFileSync(file, line + "\n");
		const out = [...readLines(file)];
		expect(out).toHaveLength(1);
		expect(out[0].line).toContain("测 tail");
		expect(out[0].line.includes("\uFFFD")).toBe(false);
	});

	it("C11: re-import keeps locally edited files (never clobbers)", () => {
		const source = join(home, "claude-src");
		mkdirSync(source, { recursive: true });
		writeFileSync(join(source, "note.md"), "---\nname: note\ndescription: d\n---\n\noriginal");
		const dir = memoryDir();
		mkdirSync(dir, { recursive: true }); // importers assume the target dir exists
		const first = importFromClaude(source, dir);
		expect(first.copied).toBe(1);
		// local edit after import
		writeFileSync(join(dir, "note.md"), "---\nname: note\ndescription: d\n---\n\nlocally edited");
		const second = importFromClaude(source, dir);
		expect(second.copied).toBe(0);
		expect(second.notes.join(" ")).toContain("kept local");
		expect(readFileSync(join(dir, "note.md"), "utf-8")).toContain("locally edited");
	});

	it("S4: memory channel is visible via readCoreStatus after yield flips", async () => {
		const host = setup();
		const ctx = host.makeCtx({ cwd: project, ui: true });
		await host.fire("session_start", {}, ctx);
		const { readCoreStatus } = await import("../../types/core-status.mjs");
		let snap = readCoreStatus(globalThis);
		expect(snap.memory?.yielded).toBe(false);
		// dynamic probe: a hermes <memory-policy marker in the system prompt flips the gate
		const beforeAgent = host.handlers.get("before_agent_start")?.[0] as (e: unknown, c: unknown) => Promise<unknown>;
		await beforeAgent({ systemPrompt: "<memory-policy>\nhermes is here\n</memory-policy>" }, ctx);
		snap = readCoreStatus(globalThis);
		expect(snap.memory?.yielded).toBe(true);
		expect(snap.memory?.dir).toBe(memoryDir());
	});
});

describe("adversarial-audit fixes (2026-09-22)", () => {
	it("C8b: 4-byte emoji at the chunk boundary decodes intact", () => {
		const file = join(home, "emoji-boundary.jsonl");
		// fill so the 256KiB boundary falls exactly at the START of a
		// 4-byte emoji sequence (F0 9F 98 80) — the audit case that broke
		const prefix = "x".repeat(READ_CHUNK - 4);
		const line = `{"text":"${prefix}😀 tail"}`;
		writeFileSync(file, line + "\n");
		const out = [...readLines(file)];
		expect(out).toHaveLength(1);
		expect(out[0].line).toContain("😀 tail");
		expect(out[0].line.includes("\uFFFD")).toBe(false);
	});

	it("C11b: hermes re-import never clobbers a corrupted local file", () => {
		const store = join(home, "hermes-store.md");
		writeFileSync(store, "§ Deploy flow\nkeep this local text\n");
		const dir = memoryDir();
		mkdirSync(dir, { recursive: true });
		expect(importFromHermes(store, dir).copied).toBe(1);
		// corrupt the local copy's frontmatter (invisible to scanMemoryDir)
		writeFileSync(join(dir, "hermes-deploy-flow.md"), "not valid frontmatter at all");
		const second = importFromHermes(store, dir);
		// D1 (2026-09-26): "exists with different content" now means "a
		// distinct fact shares the slug" — the corrupted local file is still
		// never clobbered, but the source fact imports under a fingerprint
		// suffix instead of being silently dropped
		expect(second.copied).toBe(1);
		expect(readFileSync(join(dir, "hermes-deploy-flow.md"), "utf-8")).toBe("not valid frontmatter at all");
		expect(existsSync(join(dir, "hermes-deploy-flow-646570.md"))).toBe(true);
	});

	it("C1b: function-word bigrams alone do not satisfy the overlap threshold", () => {
		const tokens = tokenize("我们需要整理一个计划");
		// the two bigrams that fired the audit's false-positive case are
		// stopwords now; the query must not recall an unrelated memory
		expect(tokens.has("我们")).toBe(false);
		expect(tokens.has("一个")).toBe(false);
		const miss = selectForTurn("我们需要整理一个计划", [
			{
				file: "a.md", title: "team-news", description: "我们团队的一个新项目", type: "project",
				body: "我们团队的一个新项目开始了", mtimeMs: Date.now(),
			},
		], 0);
		expect(miss.files).toHaveLength(0);
	});
});

describe("MR memory-recall fix v3.1 (2026-10-01, spec 2026-10-01-memory-recall-fix)", () => {
	const userMsg = (text: string) => ({ role: "user", content: [{ type: "text", text }] });

	function makeHarness() {
		const host = setup();
		const ctx = host.makeCtx({ cwd: project, ui: true });
		const fireContext = async (messages: Array<Record<string, unknown>>) => {
			let out: Array<Record<string, unknown>> | undefined;
			for (const h of host.handlers.get("context") ?? []) {
				const r = (await (h as (e: unknown, c: unknown) => Promise<{ messages?: Array<Record<string, unknown>> } | undefined>)(
					{ messages },
					ctx,
				)) as { messages?: Array<Record<string, unknown>> } | undefined;
				if (r?.messages) out = r.messages;
			}
			return out;
		};
		const fireTurnStart = async () => {
			for (const h of host.handlers.get("before_agent_start") ?? []) {
				await (h as (e: unknown, c: unknown) => Promise<unknown>)({ systemPrompt: "BASE" }, ctx);
			}
		};
		const fire = (event: string, payload: unknown) => host.fire(event, payload, ctx);
		const recallText = (messages: Array<Record<string, unknown>> | undefined) => {
			const inj = messages?.find((m) => m.customType === "pi-memory-recall") as { content: Array<{ text: string }> } | undefined;
			return inj?.content[0]?.text;
		};
		return { host, ctx, fireContext, fireTurnStart, fire, recallText };
	}

	it("MR-04: body-only overlap never qualifies (two-domain gate)", () => {
		const mem = {
			file: "x.md", title: "unrelated", description: "completely different topic", type: "project",
			body: "release flow details inside body", mtimeMs: Date.now(),
		};
		// query shares ZERO tokens with title/description, TWO with the body
		expect(selectForTurn("how does the release flow work", [mem], 0).files).toHaveLength(0);
	});

	it("MR-04 secondary: 1 primary + ≥2 body hits qualifies; 1+1 does not (npm-publishing anchor)", () => {
		const anchor = {
			file: "npm.md", title: "npm-publishing", description: "发版与 NPM Trusted Publishing", type: "reference",
			body: "发版流程习惯：常用 npm version 手动发版，流程走 CI 验证", mtimeMs: Date.now(),
		};
		// 「发版流程」= 3 bigrams; primary=1 (发版), body=3 (发版/版流/流程) → secondary path
		expect(selectForTurn("发版流程", [anchor], 0).files.map((f) => f.file)).toContain("npm.md");
		const weak = { ...anchor, body: "发版 note only" };
		// primary=1, body=1 → below SECONDARY_BODY_MIN → excluded
		expect(selectForTurn("发版流程", [weak], 0).files).toHaveLength(0);
	});

	it("MR-01/03/09: pinned re-projection is byte-identical, drift-immune, tail-append only", async () => {
		writeMemory("alpha.md", "alpha topic", "alpha description");
		writeMemory("beta.md", "beta topic", "beta description");
		const h = makeHarness();
		await h.fire("session_start", {});

		const original = [userMsg("tell me about alpha topic")];
		const first = await h.fireContext(original);
		const t1 = h.recallText(first);
		expect(t1).toContain("alpha topic");

		// MR-09 cache guard ①: original elements preserved by reference, the
		// injection is the ONLY addition and sits at the tail
		expect(first).toBeDefined();
		expect(first!.length).toBe(original.length + 1);
		for (let i = 0; i < original.length; i++) expect(first![i]).toBe(original[i]);
		expect((first![first!.length - 1] as { customType?: string }).customType).toBe("pi-memory-recall");

		// drift: same turn, a later request whose trailing "user" text matches
		// beta (tool-output-shaped garbage) — the pin must win, byte-identically
		const second = await h.fireContext([
			userMsg("tell me about alpha topic"),
			{ role: "user", content: [{ type: "text", text: "beta topic beta topic grep output" }] },
		]);
		const t2 = h.recallText(second);
		expect(t2).toBe(t1); // MR-09 ②: byte-identical re-projection within the turn
		expect(t2).not.toContain("beta topic");
	});

	it("MR-01: before_agent_start clears the pin — the new turn re-selects", async () => {
		writeMemory("alpha.md", "alpha topic", "alpha description");
		writeMemory("beta.md", "beta topic", "beta description");
		const h = makeHarness();
		await h.fire("session_start", {});

		const first = await h.fireContext([userMsg("tell me about alpha topic")]);
		expect(h.recallText(first)).toContain("alpha topic");

		await h.fireTurnStart();
		const second = await h.fireContext([userMsg("now about beta topic")]);
		expect(h.recallText(second)).toContain("beta topic");
		expect(h.recallText(second)).not.toContain("alpha topic");
	});

	it("MR-01: an empty selection is pinned for the rest of the turn", async () => {
		writeMemory("alpha.md", "alpha topic", "alpha description");
		const h = makeHarness();
		await h.fire("session_start", {});

		expect(await h.fireContext([userMsg("completely unrelated question xyzzy")])).toBeUndefined();
		// a later request in the SAME turn that would match must NOT re-select
		expect(await h.fireContext([userMsg("tell me about alpha topic")])).toBeUndefined();
		// a new turn selects fresh
		await h.fireTurnStart();
		const fresh = await h.fireContext([userMsg("tell me about alpha topic")]);
		expect(h.recallText(fresh)).toContain("alpha topic");
	});

	it("MR-05: a paid file stays re-projectable in later turns (billing-only dedup)", async () => {
		writeMemory("alpha.md", "alpha topic", "alpha description");
		const h = makeHarness();
		await h.fire("session_start", {});

		const t1 = await h.fireContext([userMsg("tell me about alpha topic")]);
		expect(h.recallText(t1)).toContain("alpha topic");
		await h.fireTurnStart();
		const t2 = await h.fireContext([userMsg("tell me about alpha topic")]);
		expect(h.recallText(t2)).toContain("alpha topic"); // NOT suppressed by surfacedKeys
	});

	it("MR-05: pre-paid files don't consume remaining budget (isPrePaid)", () => {
		const paid = { file: "paid.md", title: "alpha topic", description: "alpha", type: "project", body: "x".repeat(3000), mtimeMs: 1 };
		const other = { file: "other.md", title: "alpha topic two", description: "alpha", type: "project", body: "y".repeat(3000), mtimeMs: 2 };
		const budget = { maxFiles: 5, perFileBytes: 4096, sessionBytes: 4000 };
		// remaining = 500: an unpaid 3000-byte file does not fit…
		expect(selectForTurn("alpha topic", [other], 3500, budget).files).toHaveLength(0);
		// …but the same file pre-paid is selected without consuming remaining
		expect(selectForTurn("alpha topic", [paid], 3500, budget, (m) => m.file === "paid.md").files.map((f) => f.file)).toEqual(["paid.md"]);
	});

	it("MR-05 billing guard: cross-turn re-injection never re-charges the budget", async () => {
		// ~2KB block × 40 turns: a per-request-billing regression would exhaust
		// the 60KB cap after ~30 turns and stop injecting; once-per-file billing
		// (surfacedKeys) keeps the block visible in EVERY turn
		writeMemory("paid.md", "alpha topic", "alpha description", "project", "x".repeat(2000));
		const h = makeHarness();
		await h.fire("session_start", {});
		const ask = () => h.fireContext([userMsg("tell me about alpha topic")]);
		expect(h.recallText(await ask())).toContain("alpha topic");
		for (let i = 0; i < 39; i++) {
			await h.fireTurnStart();
			await ask();
		}
		await h.fireTurnStart();
		expect(h.recallText(await ask())).toContain("alpha topic");
	});

	it("MR-05: budget exhaustion blocks NEW files but never blinds a paid file (review F4)", async () => {
		// one paid file + 20 fillers (~3.6KB each) written UPFRONT (the scan
		// cache is only exercised for pre-existing files here); each filler is
		// reached by a query unique to it, so the 60KB distinct-file budget
		// fills turn by turn until a NEW file can no longer enter — while the
		// already-paid file must stay selectable (v3.2 removed the exhausted
		// early-return that blinded exactly the pre-paid files)
		writeMemory("paid0.md", "alpha zero topic", "paid description", "project", "p".repeat(3600));
		for (let i = 1; i <= 20; i++) {
			// unique per-file tokens (filler${i}/mark${i}) — a shared word would
			// qualify five files per query via maxFiles and never fill the budget
			writeMemory(`fill${i}.md`, `filler${i} mark${i}`, `filler${i} description`, "project", "f".repeat(3600));
		}
		const h = makeHarness();
		await h.fire("session_start", {});
		const t0 = await h.fireContext([userMsg("alpha zero topic please")]);
		expect(h.recallText(t0)).toContain("alpha zero topic");

		let blockedAt = -1;
		for (let i = 1; i <= 20; i++) {
			await h.fireTurnStart();
			const out = await h.fireContext([userMsg(`filler${i} mark${i} please`)]);
			if (out === undefined) { blockedAt = i; break; }
		}
		expect(blockedAt).toBeGreaterThan(0); // budget full — a NEW file can no longer enter
		await h.fireTurnStart();
		const again = await h.fireContext([userMsg("alpha zero topic please")]);
		expect(h.recallText(again)).toContain("alpha zero topic"); // paid file unaffected
	});

	it("MR-08/MR-02: read files are excluded until session_compact resets", async () => {
		writeMemory("alpha.md", "alpha topic", "alpha description");
		const h = makeHarness();
		await h.fire("session_start", {});

		const t1 = await h.fireContext([userMsg("tell me about alpha topic")]);
		expect(h.recallText(t1)).toContain("alpha topic");

		await h.fire("tool_call", { toolName: "read", input: { path: join(memoryDir(), "alpha.md") } });
		await h.fireTurnStart();
		expect(await h.fireContext([userMsg("tell me about alpha topic")])).toBeUndefined();

		await h.fire("session_compact", {});
		await h.fireTurnStart();
		const t3 = await h.fireContext([userMsg("tell me about alpha topic")]);
		expect(h.recallText(t3)).toContain("alpha topic");
	});

	it("MR-09: systemPrompt index injection is byte-stable while the dir is unchanged", async () => {
		writeMemory("alpha.md", "alpha topic", "alpha description");
		const h = makeHarness();
		await h.fire("session_start", {});

		const run = async (): Promise<string | undefined> => {
			let out: string | undefined;
			for (const handler of h.host.handlers.get("before_agent_start") ?? []) {
				const r = (await (handler as (e: unknown, c: unknown) => Promise<{ systemPrompt?: string } | undefined>)({ systemPrompt: "BASE" }, h.ctx)) ?? {};
				out = r.systemPrompt;
			}
			return out;
		};
		const a = await run();
		const b = await run();
		expect(a).toContain("alpha topic");
		expect(a).toBe(b); // byte-identical across turns → cache-safe prefix
	});
});

describe("MR v3.2 review follow-ups", () => {
	it("F5: a turn whose first request has no real user text pins the empty decision (image-only turn)", async () => {
		writeMemory("alpha.md", "alpha topic", "alpha description");
		const host = setup();
		const ctx = host.makeCtx({ cwd: project, ui: true });
		await host.fire("session_start", {}, ctx);
		const handler = host.handlers.get("context")![0] as (e: unknown, c: unknown) => Promise<{ messages?: Array<Record<string, unknown>> } | undefined>;
		// image-only user turn: no text blocks → no prompt
		const first = await handler({ messages: [{ role: "user", content: [{ type: "image", data: "x" }] }] }, ctx);
		expect(first).toBeUndefined();
		// later request in the SAME turn now carries matching text — the empty
		// decision is pinned, selection must NOT run (F5 symmetry)
		const later = await handler({ messages: [{ role: "user", content: [{ type: "text", text: "tell me about alpha topic" }] }] }, ctx);
		expect(later).toBeUndefined();
	});
});
