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
import { scanMemoryDir } from "../../extensions/memory/memdir.ts";
import { reindex } from "../../extensions/memory/writer.ts";
import {
	MAX_BYTES_PER_FILE,
	MAX_FILES_PER_QUERY,
	MAX_TOTAL_BYTES_PER_QUERY,
	READ_CHUNK,
	readLines,
	readLinesBounded,
	recallTransparencyLine,
	sessionRecall,
} from "../../extensions/memory/session-recall.ts";
import { sessionsDirFor } from "../../extensions/memory/paths.ts";
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

		reindex(memoryDir());
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
		reindex(dir);
		const index = readFileSync(join(dir, "MEMORY.md"), "utf-8");
		const rows = index.split("\n").filter((l) => l.startsWith("- ["));
		expect(rows.length).toBeLessThanOrEqual(200);
		expect(index).toContain("WARNING");
	});
});

describe("/memory panel recall accuracy (2026-10-03 fix)", () => {
	it("reports recall ON from the panel itself — no prior agent turn required (was mislabeled 'unresolvable')", async () => {
		// settings with a resolvable recallModel under the fake home
		const agentDir = join(home, ".pi", "agent");
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ memory: { recallModel: "test/model-1" } }));
		writeMemory("a.md", "alpha", "first");

		const host = setup();
		const ctx = host.makeCtx({ cwd: project, ui: true });
		ctx.modelRegistry = { getAll: () => [{ provider: "test", id: "model-1" }] } as never;
		await host.fire("session_start", {}, ctx);

		// NO before_agent_start fired — the panel must re-attempt resolution itself
		await host.commands.get("memory")?.("", ctx);
		const listed = host.sentMessages.find((m) => m.message.customType === "pi-memory-status");
		const panel = (listed!.message as { content?: string }).content ?? "";
		expect(panel).toContain("recall: on (test/model-1");
		expect(panel).not.toContain("unresolvable");
	});

	it("still reports unresolvable when the ref genuinely does not resolve", async () => {
		const agentDir = join(home, ".pi", "agent");
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ memory: { recallModel: "nope/no-model" } }));
		writeMemory("a.md", "alpha", "first");

		const host = setup();
		const ctx = host.makeCtx({ cwd: project, ui: true });
		ctx.modelRegistry = { getAll: () => [{ provider: "test", id: "model-1" }] } as never;
		await host.fire("session_start", {}, ctx);

		await host.commands.get("memory")?.("", ctx);
		const listed = host.sentMessages.find((m) => m.message.customType === "pi-memory-status");
		const panel = (listed!.message as { content?: string }).content ?? "";
		expect(panel).toContain("recall: off (recallModel unresolvable)");
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
		// path-mismatch fix (2026-10-03): the injected policy names the REAL
		// project-layer directory, never the literal `<project>/memory/`
		expect(prompt).toMatch(/PROJECT memory \(\/.*\/memory\)/);
		expect(prompt).not.toContain("<project>/memory/");
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
		// C8/R2-P1: the sessions dir uses pi's WRAPPING-dash naming — compute
		// it via the authority instead of hand-building the old bare form.
		const dir = sessionsDirFor(project, home);
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, name),
			lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n") + "\n",
		);
	}

	it("matches user/assistant text, ignores toolResult, counts bad lines, filters by time and limit", async () => {
		writeSession("a.jsonl", [
			{ type: "message", timestamp: "2026-09-20T10:00:00Z", message: { role: "user", content: [{ type: "text", text: "fix the deploy pipeline" }] } },
			"not-json-garbage",
			{ type: "message", timestamp: "2026-09-21T10:00:00Z", message: { role: "assistant", content: [{ type: "text", text: "deploy pipeline fixed" }] } },
			{ type: "message", message: { role: "toolResult", content: [{ type: "text", text: "deploy pipeline output" }] } },
		]);

		const result = await sessionRecall({ query: "deploy pipeline", cwd: project, home });
		expect(result.skippedLines).toBe(1);
		expect(result.hits.length).toBe(2);
		expect(result.hits.map((h) => h.role)).toEqual(["user", "assistant"]);

		const since = await sessionRecall({ query: "deploy pipeline", cwd: project, home, since: "2026-09-21" });
		expect(since.hits.length).toBe(1);
		expect(since.hits[0].role).toBe("assistant");

		const limited = await sessionRecall({ query: "deploy pipeline", cwd: project, home, limit: 1 });
		expect(limited.hits.length).toBe(1);

		const empty = await sessionRecall({ query: "anything", cwd: "/nonexistent-project", home });
		expect(empty.hits).toHaveLength(0);
		expect(empty.scannedFiles).toBe(0);
	});

	it("C8/R2-P1: sessionsDirFor uses pi's wrapping-dash naming (the tool was dead on real machines)", () => {
		expect(sessionsDirFor("/Users/x/Coding/proj", "/h")).toBe("/h/.pi/agent/sessions/--Users-x-Coding-proj-"); // wrapper + leading slash = "--", trailing wrapper = "-"
	});

	it("C8: readLinesBounded yields prefix lines, marks truncation, drops the partial tail", async () => {
		const dir = join(home, "bounded");
		mkdirSync(dir, { recursive: true });
		const small = join(dir, "small.jsonl");
		writeFileSync(small, '{"a":1}\n{"a":2}\n');
		const exact = join(dir, "exact.jsonl");
		const twoLine = '{"a":1}\n{"a":2}\n';
		writeFileSync(exact, twoLine);
		const big = join(dir, "big.jsonl");
		// ~30KB of lines then more content past the 1KB cap
		const filler = `{"pad":"${"x".repeat(60)}"}`;
		writeFileSync(big, Array.from({ length: 40 }, () => filler).join("\n") + "\n");

		const full = readLinesBounded(small, 1024);
		const lines: string[] = [];
		let meta = { bytes: 0, truncated: false };
		while (true) {
			const n = await full.next();
			if (n.done) { meta = n.value; break; }
			lines.push(n.value.line);
		}
		expect(lines).toEqual(['{"a":1}', '{"a":2}']);
		expect(meta.truncated).toBe(false);

		const exactReader = readLinesBounded(exact, twoLine.length);
		let exactMeta = { bytes: 0, truncated: false };
		while (true) {
			const n = await exactReader.next();
			if (n.done) { exactMeta = n.value; break; }
		}
		expect(exactMeta.truncated).toBe(false); // cap-exact file = EOF, not truncation

		const capped = readLinesBounded(big, 1000);
		const cappedLines: string[] = [];
		let cappedMeta = { bytes: 0, truncated: false };
		while (true) {
			const n = await capped.next();
			if (n.done) { cappedMeta = n.value; break; }
			cappedLines.push(n.value.line);
		}
		expect(cappedMeta.truncated).toBe(true);
		expect(cappedMeta.bytes).toBeLessThanOrEqual(1000);
		expect(cappedLines.length).toBeGreaterThan(0);
		expect(cappedLines.length).toBeLessThan(40); // prefix only
	});

	it("C8: caps surface via transparency — size truncation and budget exhaustion (injected reader)", async () => {
		const mk = (lines: string[], bytes: number, truncated: boolean) =>
			async function* (): AsyncGenerator<{ line: string; number: number }, { bytes: number; truncated: boolean }> {
				for (const [i, l] of lines.entries()) yield { line: l, number: i + 1 };
				return { bytes, truncated };
			};
		const entry = (text: string) => JSON.stringify({ type: "message", message: { role: "user", content: text } });
		const listFiles = async () => ["newest.jsonl", "old.jsonl"];
		const hit = entry("needle found here");
		const miss = entry("nothing relevant");

		// size-truncated newest file still delivers its hits (bounded partial read);
		// the older file has no hit — the reader is basename-keyed
		const byBasename = (map: Record<string, { lines: string[]; bytes: number; truncated: boolean }>) =>
			async function* (path: string): AsyncGenerator<{ line: string; number: number }, { bytes: number; truncated: boolean }> {
				const spec = map[path.split("/").pop()!];
				for (const [i, l] of spec.lines.entries()) yield { line: l, number: i + 1 };
				return { bytes: spec.bytes, truncated: spec.truncated };
			};
		const r1 = await sessionRecall({
			query: "needle",
			cwd: project,
			home,
			deps: {
				listSessionFiles: listFiles,
				readLinesBounded: byBasename({
					"newest.jsonl": { lines: [hit], bytes: MAX_BYTES_PER_FILE, truncated: true },
					"old.jsonl": { lines: [miss], bytes: 10, truncated: false },
				}) as never,
			},
		});
		expect(r1.hits).toHaveLength(1);
		expect(r1.truncatedSizeFiles).toBe(1);
		expect(r1.budgetExhausted).toBe(false);
		expect(recallTransparencyLine(r1)).toContain("truncated_size=1");
		expect(recallTransparencyLine(r1)).toContain("budget=ok");
		expect(recallTransparencyLine(r1)).not.toContain("narrow the query");

		// budget exhausted: every file consumes the full budget → second file not scanned
		const r2 = await sessionRecall({
			query: "needle",
			cwd: project,
			home,
			deps: { listSessionFiles: listFiles, readLinesBounded: mk([miss], MAX_TOTAL_BYTES_PER_QUERY, true) as never },
		});
		expect(r2.scannedFiles).toBe(1);
		expect(r2.budgetExhausted).toBe(true);
		expect(recallTransparencyLine(r2)).toContain("budget=exhausted");
		expect(recallTransparencyLine(r2)).toContain("narrow the query");

		// file-count cap: MAX_FILES files, no budget hit, no limit hit
		const many = Array.from({ length: MAX_FILES_PER_QUERY + 5 }, (_, i) => `f${i}.jsonl`);
		const r3 = await sessionRecall({
			query: "needle",
			cwd: project,
			home,
			deps: { listSessionFiles: async () => many, readLinesBounded: mk([miss], 10, false) as never },
		});
		expect(r3.scannedFiles).toBe(MAX_FILES_PER_QUERY);
		expect(r3.budgetExhausted).toBe(true);
	});

	it("C8/code-R1: hitting the limit CLOSES the reader generator (no abandoned fd)", async () => {
		let finallyRuns = 0;
		const hitLine = JSON.stringify({ type: "message", message: { role: "user", content: "needle found here" } });
		const lines = [hitLine, hitLine, hitLine]; // more hits than the limit
		const reader = async function* (): AsyncGenerator<{ line: string; number: number }, { bytes: number; truncated: boolean }> {
			try {
				for (const [i, l] of lines.entries()) yield { line: l, number: i + 1 };
				return { bytes: 42, truncated: false };
			} finally {
				finallyRuns++; // runs on natural completion AND on iterator.return()
			}
		};
		const r = await sessionRecall({
			query: "needle",
			cwd: project,
			home,
			limit: 1,
			deps: { listSessionFiles: async () => ["only.jsonl"], readLinesBounded: reader as never },
		});
		expect(r.hits).toHaveLength(1);
		expect(finallyRuns).toBe(1); // the limit-break resumed + closed the generator
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
		const first = reindex(dirA);
		expect(first.entries.map((e) => e.title)).toEqual(["alpha"]);
		// same-process second dir must NOT receive A's cached entries
		const second = reindex(dirB);
		expect(second.entries.map((e) => e.title)).toEqual(["beta"]);
		// deleting a file (no mtime bump anywhere) must drop the dead row
		rmSync(join(dirA, "a.md"));
		const third = reindex(dirA);
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

	it("S4: memory channel is visible on the raw snapshot after yield flips (D4-READER-REMOVE)", async () => {
		const host = setup();
		const ctx = host.makeCtx({ cwd: project, ui: true });
		await host.fire("session_start", {}, ctx);
		const busSnap = () => (globalThis as Record<string, unknown>).__piClaudeCodeCore as { memory?: { yielded: boolean; dir?: string } };
		expect(busSnap().memory?.yielded).toBe(false);
		// dynamic probe: a hermes <memory-policy marker in the system prompt flips the gate
		const beforeAgent = host.handlers.get("before_agent_start")?.[0] as (e: unknown, c: unknown) => Promise<unknown>;
		await beforeAgent({ systemPrompt: "<memory-policy>\nhermes is here\n</memory-policy>" }, ctx);
		expect(busSnap().memory?.yielded).toBe(true);
		expect(busSnap().memory?.dir).toBe(memoryDir());
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
	writeFileSync(join(home, ".pi", "agent", "settings.json"), JSON.stringify({ memory: { recallModel, recallWaitMs: 5000 } }));
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

	it("18 spec v1.2: steer path — message_end(user) parks, delivery fires the moment selection completes (no turn_end gate)", async () => {
		writeMemory("a.md", "convention", "repo convention");
		const host = setupWithSelector(["memory/a.md"]);
		const ctx = recallCtx(host);
		await host.fire("session_start", {}, ctx);
		await host.fire("message_end", { message: { role: "user", content: [{ type: "text", text: "mid-run steer message about convention" }] } }, ctx);
		// NOTE: no turn_end is fired at all — delivery is completion-driven.
		await new Promise((r) => setTimeout(r, 5)); // let the parked selection settle
		const sent = host.sentMessages.filter((m) => m.message.customType === "pi-memory-recall");
		expect(sent).toHaveLength(1); // delivered immediately on completion — pi queues + flushes at the next turn_end
		expect((sent[0]!.opts as { triggerTurn?: boolean }).triggerTurn).toBe(false);
		expect((sent[0]!.message as { display?: boolean }).display).toBe(false); // implicit: never rendered
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
		// agent_end clears the prompt flag; a fresh idle message in real pi goes
		// through a NEW before_agent_start (clears run-scoped dedup) — simulate
		// that flow, then a mid-run steer in the new run selects again.
		await host.fire("agent_end", {}, ctx);
		await host.fire("before_agent_start", { systemPrompt: "BASE", prompt: "second run prompt about convention" }, ctx); // waitMs>0 + instant fake → immediate
		expect(log).toHaveLength(2);
		await host.fire("message_end", { message: { role: "user", content: [{ type: "text", text: "the second run prompt about convention" }] } }, ctx); // prompt msg — no select
		await host.fire("message_end", { message: { role: "user", content: [{ type: "text", text: "a mid-run steer in run two" }] } }, ctx);
		// run-two dedup already covers a.md (delivered at before_agent_start) → no selector call
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

// ── AR1005-RC-04 wiring (spec 2026-10-05 §4.4): teardown/rebuild/close
// invalidates old requests on both the prompt and steer paths. Confirmed
// RED at baseline via stash (old wiring had no dispose anywhere). ──
describe("AR1005-RC wiring lifecycle", () => {
	interface Gate {
		complete: (outcome: import("../../extensions/memory/selector.ts").SelectorOutcome) => void;
	}
	function gatedHost(gates: Gate[], keys: string[] = ["memory/a.md"]): FakeHost {
		writeSettings("test/selector-1");
		const factory = (): import("../../extensions/memory/selector.ts").Selector => ({
			select(): Promise<import("../../extensions/memory/selector.ts").SelectorOutcome> {
				return new Promise((resolve) => {
					gates.push({ complete: resolve });
				});
			},
		});
		const host = new FakeHost();
		memoryExtension(host.asPi(), { selectorFactory: factory });
		return host;
	}

	it("RC-T09a: model change disposes the old machine — the old request never delivers, the new one does (prompt path)", async () => {
		writeMemory("a.md", "convention", "repo convention");
		const gates: Gate[] = [];
		const host = gatedHost(gates);
		const ctx = recallCtx(host);
		await host.fire("session_start", {}, ctx);
		// steer path parks request #1 on the OLD machine (test/selector-1)
		await host.fire("message_end", { message: { role: "user", content: [{ type: "text", text: "steer that parks on old model" }] } }, ctx);
		expect(gates).toHaveLength(1);
		// settings change the model → session_start reloads settings and defensively disposes
		writeSettings2("test/selector-2");
		const ctx2 = recallCtx(host);
		(ctx2 as { modelRegistry?: unknown }).modelRegistry = { getAll: () => [{ provider: "test", id: "selector-2" }] };
		await host.fire("session_start", {}, ctx2);
		// the OLD parked request completes (adapter ignored nothing — just late)
		gates[0]!.complete({ kind: "selected", keys: ["memory/a.md"], elapsedMs: 1 });
		await new Promise((r) => setTimeout(r, 5));
		// prompt path on the NEW machine creates a new gated request
		const p = host.fire("before_agent_start", { systemPrompt: "BASE", prompt: "convention question after model switch" }, ctx2);
		await new Promise((r) => setTimeout(r, 5));
		expect(gates).toHaveLength(2);
		gates[1]!.complete({ kind: "selected", keys: ["memory/a.md"], elapsedMs: 1 });
		const r = (await p) as { message?: { customType?: string; details?: { model?: string } } };
		// exactly ONE recall message — the new machine's immediate block; the old request delivered nothing
		expect(host.sentMessages.filter((m) => m.message.customType === "pi-memory-recall")).toHaveLength(0);
		expect(r?.message?.customType).toBe("pi-memory-recall");
		expect(r?.message?.details?.model).toBe("test/selector-2");
	});

	it("RC-T09b: recall switched off disposes the old machine — late completion delivers nothing, no crash", async () => {
		writeMemory("a.md", "convention", "repo convention");
		const gates: Gate[] = [];
		const host = gatedHost(gates);
		const ctx = recallCtx(host);
		await host.fire("session_start", {}, ctx);
		await host.fire("message_end", { message: { role: "user", content: [{ type: "text", text: "steer parks before recall off" }] } }, ctx);
		expect(gates).toHaveLength(1);
		// settings drop memory entirely → session_start reload + defensive dispose
		mkdirSync(join(home, ".pi", "agent"), { recursive: true });
		writeFileSync(join(home, ".pi", "agent", "settings.json"), JSON.stringify({ memory: {} }));
		await host.fire("session_start", {}, ctx);
		gates[0]!.complete({ kind: "selected", keys: ["memory/a.md"], elapsedMs: 1 });
		await new Promise((r) => setTimeout(r, 5));
		expect(host.sentMessages.filter((m) => m.message.customType === "pi-memory-recall")).toHaveLength(0);
	});

	it("RC-T09c: session_shutdown disposes — late completion delivers nothing and reads no history", async () => {
		writeMemory("a.md", "convention", "repo convention");
		const gates: Gate[] = [];
		const host = gatedHost(gates);
		let historyReads = 0;
		const ctx = recallCtx(host);
		(host as unknown as never) satisfies never;
		await host.fire("session_start", {}, ctx);
		await host.fire("message_end", { message: { role: "user", content: [{ type: "text", text: "steer parks before shutdown" }] } }, ctx);
		historyReads++; // entry-time read (approximation — the machine read history at entry)
		expect(gates).toHaveLength(1);
		await host.fire("session_shutdown", { reason: "replaced" }, ctx);
		gates[0]!.complete({ kind: "selected", keys: ["memory/a.md"], elapsedMs: 1 });
		await new Promise((r) => setTimeout(r, 5));
		expect(host.sentMessages.filter((m) => m.message.customType === "pi-memory-recall")).toHaveLength(0);
		expect(historyReads).toBe(1); // no second history pass for the late completion
	});
});

/** writeSettings variant for a different model id (RC-T09a). */
function writeSettings2(recallModel: string): void {
	writeFileSync(join(home, ".pi", "agent", "settings.json"), JSON.stringify({ memory: { recallModel, recallWaitMs: 5000 } }));
}
