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
	it("a throwing recall path never blocks the turn (before_agent_start / message_end / turn_end all fail-open)", async () => {
		const host = setup();
		const ctx = host.makeCtx({ cwd: project, ui: true });
		await host.fire("session_start", {}, ctx);
		// historyFor throws → caught inside; a selector factory that THROWS at
		// construction would be caught by recallBlockFor's caller try/catch.
		// Simulate the hostile shape: projection that explodes on access.
		const hostile = host.makeCtx({ cwd: project, ui: true }) as Record<string, unknown>;
		hostile.sessionManager = {
			get buildSessionProjection() {
				throw new Error("projection exploded");
			},
		};
		const r1 = await host.fire("before_agent_start", { systemPrompt: "BASE", prompt: "hello memory recall test" }, hostile);
		expect(typeof r1 === "object" || r1 === undefined).toBe(true);
		const r2 = await host.fire("message_end", { message: { role: "user", content: [{ type: "text", text: "steer text here" }] } }, hostile);
		expect(r2).toBeUndefined();
		const r3 = await host.fire("turn_end", { toolResults: [{ toolCallId: "t", toolName: "bash" }] }, hostile);
		expect(r3).toBeUndefined();
	});
});

describe("review-2026-09-22-II fixes", () => {
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

});


/* ── RV wiring (spec 2026-10-02-memory-recall-v2 §8 cases 16–20) ── */

import type { Selector, SelectorOutcome } from "../../extensions/memory/selector.ts";

function writeSettings(recallModel: string): void {
	mkdirSync(join(home, ".pi", "agent"), { recursive: true });
	writeFileSync(join(home, ".pi", "agent", "settings.json"), JSON.stringify({ memory: { recallModel } }));
}

function setupWithSelector(keys: string[], log: Array<{ query: string; count: number }> = []): FakeHost {
	writeSettings("test/selector-1");
	const factory = (): Selector => ({
		async select(req): Promise<SelectorOutcome> {
			log.push({ query: req.query, count: req.candidates.length });
			return { kind: "selected", keys, elapsedMs: 1 };
		},
	});
	const host = new FakeHost();
	memoryExtension(host.asPi(), { selectorFactory: factory });
	return host;
}

function recallCtx(host: FakeHost, opts: { projectionMessages?: unknown[] } = {}): Record<string, unknown> {
	const ctx = host.makeCtx({ cwd: project, ui: true, projectionMessages: opts.projectionMessages ?? [] });
	ctx.modelRegistry = { getAll: () => [{ provider: "test", id: "selector-1" }] };
	return ctx;
}

describe("RV wiring (spec 2026-10-02-memory-recall-v2)", () => {
	it("16: no memory.recallModel — before_agent_start returns only systemPrompt; steer/turn_end never sendMessage", async () => {
		writeMemory("a.md", "convention", "repo convention");
		const host = setup();
		const ctx = host.makeCtx({ cwd: project, ui: true, projectionMessages: [] });
		await host.fire("session_start", {}, ctx);
		const r = (await host.fire("before_agent_start", { systemPrompt: "BASE", prompt: "repo convention question" }, ctx)) as { message?: unknown; systemPrompt?: string };
		expect(r?.message).toBeUndefined();
		expect(r?.systemPrompt).toContain("<memory-policy");
		await host.fire("message_end", { message: { role: "user", content: [{ type: "text", text: "steer mid run text" }] } }, ctx);
		await host.fire("turn_end", { toolResults: [{ toolCallId: "t", toolName: "bash" }] }, ctx);
		expect(host.sentMessages.filter((m) => m.message.customType === "pi-memory-recall")).toHaveLength(0);
	});

	it("17: configured — before_agent_start returns { systemPrompt, message } with customType pi-memory-recall, display false", async () => {
		writeMemory("a.md", "convention", "repo convention");
		const log: Array<{ query: string; count: number }> = [];
		const host = setupWithSelector(["memory/a.md"], log);
		const ctx = recallCtx(host);
		await host.fire("session_start", {}, ctx);
		const r = (await host.fire("before_agent_start", { systemPrompt: "BASE", prompt: "what is the repo convention" }, ctx)) as {
			message?: { customType: string; content: Array<{ text: string }>; display: boolean; details: { v: number; delivery: string; elapsedMs: number } };
			systemPrompt?: string;
		};
		expect(r?.systemPrompt).toContain("<memory-policy");
		expect(r?.message?.customType).toBe("pi-memory-recall");
		expect(r!.message!.display).toBe(false);
		expect(r!.message!.content[0]!.text).toContain("(memory/a.md)");
		expect(r!.message!.details.v).toBe(1);
		expect(r!.message!.details.delivery).toBe("immediate");
		expect(typeof r!.message!.details.elapsedMs).toBe("number");
	});

	it("18: steer path — message_end(user) parks, turn_end(toolResults) delivers via sendMessage(triggerTurn:false)", async () => {
		writeMemory("a.md", "convention", "repo convention");
		const host = setupWithSelector(["memory/a.md"]);
		const ctx = recallCtx(host);
		await host.fire("session_start", {}, ctx);
		// steer: no before_agent_start ran → prompt flag false → mid-run path
		await host.fire("message_end", { message: { role: "user", content: [{ type: "text", text: "mid-run steer message about convention" }] } }, ctx);
		await new Promise((r) => setTimeout(r, 5)); // let the parked selection settle
		expect(host.sentMessages).toHaveLength(0); // nothing before the turn continues
		await host.fire("turn_end", { toolResults: [{ toolCallId: "t", toolName: "bash" }] }, ctx);
		const sent = host.sentMessages.filter((m) => m.message.customType === "pi-memory-recall");
		expect(sent).toHaveLength(1);
		expect((sent[0]!.opts as { triggerTurn?: boolean }).triggerTurn).toBe(false);
		expect((sent[0]!.message as { details?: { delivery?: string } }).details?.delivery).toBe("deferred");
	});

	it("19: RV-01 — the prompt message's message_end never double-selects; custom/toolResult messages never select; agent_end clears the prompt flag", async () => {
		writeMemory("a.md", "convention", "repo convention");
		const log: Array<{ query: string; count: number }> = [];
		const host = setupWithSelector(["memory/a.md"], log);
		const ctx = recallCtx(host);
		await host.fire("session_start", {}, ctx);
		await host.fire("before_agent_start", { systemPrompt: "BASE", prompt: "the repo convention prompt" }, ctx);
		expect(log).toHaveLength(1); // selected once at before_agent_start
		// the persisted user message's own message_end: flag clears, NO second selection
		await host.fire("message_end", { message: { role: "user", content: [{ type: "text", text: "the repo convention prompt" }] } }, ctx);
		expect(log).toHaveLength(1);
		// custom + toolResult messages never trigger
		await host.fire("message_end", { message: { role: "user", customType: "pi-memory-recall", content: [{ type: "text", text: "whatever" }] } }, ctx);
		await host.fire("message_end", { message: { role: "toolResult", toolName: "bash", isError: false, content: [] } }, ctx);
		expect(log).toHaveLength(1);
		// agent_end clears the prompt flag → the NEXT plain user message_end selects (steer)
		await host.fire("agent_end", {}, ctx);
		await host.fire("message_end", { message: { role: "user", content: [{ type: "text", text: "a fresh steer message after run end" }] } }, ctx);
		expect(log).toHaveLength(2);
	});

	it("20: no context handler is registered; yield short-circuits recall entirely", async () => {
		writeMemory("a.md", "convention", "repo convention");
		const log: Array<{ query: string; count: number }> = [];
		const host = setupWithSelector(["memory/a.md"], log);
		expect(host.handlers.has("context")).toBe(false); // RV: the projection hook is gone
		const ctx = recallCtx(host);
		await host.fire("session_start", {}, ctx);
		// dynamic yield: the incoming system prompt already carries another
		// memory policy → the module defers entirely (no message, no selector)
		const r = await host.fire("before_agent_start", { systemPrompt: `BASE\n\n<memory-policy>\nforeign policy\n</memory-policy>`, prompt: "repo convention question here" }, ctx);
		expect((r as { message?: unknown })?.message).toBeUndefined();
		expect(log).toHaveLength(0);
		expect(host.sentMessages.filter((m) => m.message.customType === "pi-memory-recall")).toHaveLength(0);
	});
});
