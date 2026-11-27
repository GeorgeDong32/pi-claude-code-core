/**
 * Context diet v3 (spec 2026-11-24-core-context-diet): compact index rows,
 * write-side description cap (store gate + one bounded rewrite), the two
 * deferred on-demand tools, and the per-run stats probe.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeHost, clearCoreGlobals, snapshotCoreGlobals } from "../contracts/fake-host.ts";
import { resetCoreBusForTests } from "../../extensions/bus.ts";
import memoryExtension from "../../extensions/memory/index.ts";
import { resolveMemoryPaths } from "../../extensions/memory/paths.ts";
import { invalidateMemDirCache } from "../../extensions/memory/memdir.ts";
import { buildPolicyInjection, DESCRIPTION_MAX, descriptionTooLong } from "../../extensions/memory/policy.ts";
import { applyMemoryOps, DESCRIPTION_MULTILINE_REASON, DESCRIPTION_TOO_LONG_REASON } from "../../extensions/memory/store.ts";
import { runConsolidation } from "../../extensions/memory/consolidate.ts";
import { rewriteTooLongDescriptions, type LlmComplete } from "../../extensions/memory/llm.ts";
import { allowedRoots, knowledgeSearch, lookupMemory, searchRoots } from "../../extensions/memory/lookup.ts";
import type { MemoryOp } from "../../extensions/memory/store.ts";

let globalsSnapshot: Record<string, unknown>;
let home: string;
let project: string;
let prevHome: string | undefined;
let dir: string;

function put(d: string, file: string, title: string, description = "d", body = "body"): void {
	mkdirSync(d, { recursive: true });
	writeFileSync(join(d, file), `---\nname: ${title}\ndescription: ${description}\nmetadata:\n  type: project\n---\n\n${body}`);
	invalidateMemDirCache(d);
}
function setup(): FakeHost {
	const host = new FakeHost();
	memoryExtension(host.asPi());
	return host;
}
const LONG = "x".repeat(DESCRIPTION_MAX + 10);

beforeEach(() => {
	globalsSnapshot = snapshotCoreGlobals();
	clearCoreGlobals();
	resetCoreBusForTests();
	prevHome = process.env.HOME;
	home = mkdtempSync(join(tmpdir(), "diet-home-"));
	project = mkdtempSync(join(tmpdir(), "diet-proj-"));
	process.env.HOME = home;
	dir = resolveMemoryPaths(project, home).memoryDir;
});
afterEach(() => {
	if (prevHome === undefined) delete process.env.HOME;
	else process.env.HOME = prevHome;
	rmSync(home, { recursive: true, force: true });
	rmSync(project, { recursive: true, force: true });
});

describe("index rows: slug — description, no duplicated link, ⚠ on over-long descriptions", () => {
	it("renders one line per memory with the slug only once and the description verbatim", () => {
		const text = buildPolicyInjection({ entries: [] }, [
			{ title: "alpha", description: "[insight] alpha fact", file: "alpha.md" },
			{ title: "beta-long", description: `[failure] ${LONG}`, file: "beta-long.md" },
		], dir);
		const rows = text.split("\n").filter((l) => l.startsWith("- "));
		expect(rows).toEqual(["- alpha — [insight] alpha fact", `- beta-long — [failure] ${LONG} ⚠`]);
		const imported = buildPolicyInjection({ entries: [] }, [{ title: "deploy-flow", description: "d", file: "deploy-flow-646570.md" }], dir);
		expect(imported).toContain("- deploy-flow (deploy-flow-646570.md) — d");
		// a hand-edited description with a line break still renders as one row
		const broken = buildPolicyInjection({ entries: [] }, [{ title: "c", description: "line one\nline two", file: "c.md" }], dir);
		expect(broken.split("\n").filter((l) => l.startsWith("- "))).toEqual(["- c — line one line two"]);
		expect(text, "the slug must not be repeated as a markdown link").not.toContain("](");
	});

	it("the policy names the file path convention, both on-demand tools (codemode call form) and the three knowledge sources", () => {
		const text = buildPolicyInjection({ entries: [] }, [], dir);
		expect(text).toContain("<this dir>/<slug>.md");
		expect(text).toContain("tools.memory_lookup({ name })");
		expect(text).toContain('tools.knowledge_search({ query, scope: "sessions" })');
		expect(text).toContain('scope "roots"');
		expect(text).toContain(`at most ${DESCRIPTION_MAX} characters`);
		expect(text).toContain("⚠");
	});

	it("descriptionTooLong is a strict >80 UTF-16 code-unit test (CJK counts 1)", () => {
		expect(descriptionTooLong("a".repeat(80))).toBe(false);
		expect(descriptionTooLong("a".repeat(81))).toBe(true);
		expect(descriptionTooLong("中".repeat(80))).toBe(false);
	});
});

describe("write-side cap: the store rejects over-long descriptions, one bounded rewrite runs first", () => {
	const add = (description: string): MemoryOp => ({ action: "add", layer: "project", name: "cap-test", description, type: "project", body: "body" });

	it("add with a description over the cap is skipped with the stated reason; replace supplying one too; replace keeping the existing one still applies", () => {
		mkdirSync(dir, { recursive: true });
		const skipped = applyMemoryOps([add(LONG)], { project: dir });
		expect(skipped.applied).toBe(0);
		expect(skipped.skipped.map((s) => s.reason)).toEqual([DESCRIPTION_TOO_LONG_REASON]);
		expect(applyMemoryOps([add("[insight] short noun phrase")], { project: dir }).applied).toBe(1);
		put(dir, "legacy.md", "legacy", LONG);
		expect(applyMemoryOps([{ action: "replace", layer: "project", file: "legacy.md", description: LONG, body: "new body" }], { project: dir }).skipped[0]?.reason).toBe(DESCRIPTION_TOO_LONG_REASON);
		expect(applyMemoryOps([{ action: "replace", layer: "project", file: "legacy.md", body: "new body" }], { project: dir }).applied).toBe(1);
		expect(applyMemoryOps([add("two\nlines")], { project: dir }).skipped[0]?.reason).toBe(DESCRIPTION_MULTILINE_REASON);
	});

	it("manual consolidation refuses a merged file whose description is over the cap (the batch fails before any write)", () => {
		put(dir, "a.md", "a", "d");
		put(dir, "b.md", "b", "d");
		const outcome = runConsolidation(
			dir,
			[{ file: "merged.md", content: `---\nname: merged\ndescription: ${LONG}\nmetadata:\n  type: project\n---\n\nmerged body`, merged_from: ["a.md", "b.md"] }],
			["a.md", "b.md"],
		);
		expect(outcome.ok).toBe(false);
		expect(outcome.message).toContain("description exceeds");
	}),

	it("rewriteTooLongDescriptions replaces only the flagged ops, by index, and ignores rewrites that are still too long or unparsable", async () => {
		const ops: MemoryOp[] = [
			{ action: "add", layer: "project", name: "one", description: LONG, body: "b" },
			{ action: "add", layer: "project", name: "two", description: "fine already", body: "b" },
			{ action: "add", layer: "project", name: "three", description: LONG, body: "b" },
		];
		const answers = [`{"rewrites":[{"index":0,"description":"[insight] one tightened"},{"index":2,"description":"${LONG}"}]}`, "not json"];
		let call = 0;
		const complete = (async () => ({ content: [{ type: "text", text: answers[call++] }], stopReason: "stop" })) as unknown as LlmComplete;
		const registry = { getApiKeyAndHeaders: async () => ({ ok: true as const, apiKey: "test" }) };
		const first = await rewriteTooLongDescriptions({} as never, registry, ops, {}, { complete });
		expect(first.rewritten).toBe(1);
		expect(first.ops.map((o) => o.description)).toEqual(["[insight] one tightened", "fine already", LONG]);
		expect(first.ops[1]).toBe(ops[1]);
		const second = await rewriteTooLongDescriptions({} as never, registry, ops, {}, { complete });
		expect(second.rewritten).toBe(0);
		expect(second.ops).toBe(ops);
		expect(await rewriteTooLongDescriptions({} as never, registry, [ops[1]!], {}, { complete })).toEqual({ ops: [ops[1]!], rewritten: 0 });
	});
});

describe("on-demand tools: lookup and search", () => {
	it("lookupMemory refuses traversal and unknown slugs, suggesting near names; reads a known slug in full", () => {
		put(dir, "bg-shell-module-facts.md", "bg-shell-module-facts", "d");
		put(dir, "stall-watchdog-facts.md", "stall-watchdog-facts", "d");
		expect(lookupMemory(dir, "../../etc/passwd").ok).toBe(false);
		expect(lookupMemory(dir, "..").ok).toBe(false);
		expect(lookupMemory(dir, "/etc/passwd").ok).toBe(false);
		const miss = lookupMemory(dir, "bg-shell-other");
		expect(miss.ok).toBe(false);
		expect(miss.near).toEqual(["bg-shell-module-facts"]);
		const hit = lookupMemory(dir, "stall-watchdog-facts");
		expect(hit.ok).toBe(true);
		expect(hit.text).toContain("name: stall-watchdog-facts");
	});

	it("searchRoots: case-insensitive substring over paths and first lines, skips dot dirs and non-text files, caps hits and reports truncation", () => {
		const root = join(home, "vault");
		put(join(root, "Agent Notes"), "proxy-notes.md", "x", "ClashMac kernel outbound is dumb");
		put(join(root, ".git"), "hidden.md", "x", "matchme in a skipped dir");
		mkdirSync(join(root, "bin"), { recursive: true });
		writeFileSync(join(root, "bin", "matchme.bin"), "binary matchme");
		put(join(root, "deep"), "a-matchme-file.md", "x", "plain body without the needle");
		const hit = searchRoots({ roots: [root], query: "MATCHME" });
		expect(hit.hits.map((h) => h.path)).toEqual([join(root, "deep", "a-matchme-file.md")]);
		const byHint = searchRoots({ roots: [root], query: "outbound" });
		expect(byHint.hits[0]?.hint).toContain("ClashMac");
		for (let i = 0; i < 30; i++) put(join(root, "many"), `m${i}-needle.md`, `m${i}`, "d");
		const capped = searchRoots({ roots: [root], query: "needle", maxHits: 5 });
		expect(capped.hits.length).toBe(5);
		expect(capped.truncated).toBe(true);
	});

	it("searchRoots never follows a symlink out of the root; the scan budget reports truncation only when files were left unseen", () => {
		const root = join(home, "vault");
		const outside = join(home, "outside");
		mkdirSync(outside, { recursive: true });
		writeFileSync(join(outside, "secret.md"), "needle outside the root");
		mkdirSync(root, { recursive: true });
		symlinkSync(join(outside, "secret.md"), join(root, "leak.md"));
		symlinkSync(outside, join(root, "leakdir"));
		expect(searchRoots({ roots: [root], query: "needle" }).hits).toEqual([]);
		for (let i = 0; i < 3; i++) put(join(root, "n"), `f${i}-needle.md`, `f${i}`, "d");
		expect(searchRoots({ roots: [root], query: "needle", maxFiles: 3 }).truncated).toBe(false);
		expect(searchRoots({ roots: [root], query: "needle", maxFiles: 2 }).truncated).toBe(true);
	});

	it("allowedRoots: the memory dir is always allowed; configured roots must be absolute, existing, distinct directories", () => {
		const ok = join(home, "ok");
		mkdirSync(ok, { recursive: true });
		writeFileSync(join(home, "afile"), "x");
		expect(allowedRoots([ok, "relative/path", join(home, "missing"), join(home, "afile"), ok, dir], dir)).toEqual([dir, ok]);
	});

	it("knowledgeSearch fans out to notes and sessions by scope and reports both sections", async () => {
		put(dir, "needle-memory.md", "needle-memory", "the needle lives here");
		const calls: string[] = [];
		const deps = {
			home,
			memoryDir: dir,
			searchRoots: undefined,
			sessionSearch: async (input: { query: string; project: string; limit: number }) => {
				calls.push(`${input.query}@${input.project}#${input.limit}`);
				return { hits: [{ file: "s.jsonl", line: 3, role: "user", text: "needle in a past session" }], scannedFiles: 2 };
			},
		};
		const all = await knowledgeSearch(deps, "needle", "all", project);
		expect(all).toContain("notes: 1 hit(s)");
		expect(all).toContain("needle-memory.md — the needle lives here");
		expect(all).toContain("sessions: 1 hit(s)");
		expect(all).toContain("s.jsonl:3 user: needle in a past session");
		expect(calls).toEqual([`needle@${project}#5`]);
		const sessionsOnly = await knowledgeSearch(deps, "needle", "sessions", project);
		expect(sessionsOnly).not.toContain("notes:");
		const memoryOnly = await knowledgeSearch(deps, "absent", "memory", project);
		expect(memoryOnly).toContain("notes: no matches");
		expect(calls.length).toBe(2);
	});
});

describe("module wiring: deferred exposure, counters and the per-run stats entry", () => {
	it("memory_lookup / knowledge_search / session_recall are codemode-exposed (listed by codemode, never declared) and callable", async () => {
		put(dir, "fact.md", "fact", "a fact");
		put(dir, "old-long.md", "old-long", LONG);
		const host = setup();
		for (const name of ["memory_lookup", "knowledge_search", "session_recall"]) {
			expect((host.tools.get(name) as { exposure?: string } | undefined)?.exposure, name).toBe("codemode");
		}
		const ctx = host.makeCtx({ cwd: project, sessionId: "s1", ui: true });
		await host.fire("session_start", {}, ctx);
		const lookup = host.tools.get("memory_lookup")!;
		const found = (await lookup.execute("t1", { name: "fact" }, undefined, undefined, ctx)) as { content: Array<{ text: string }> };
		expect(found.content[0]?.text).toContain("name: fact");
		const search = host.tools.get("knowledge_search")!;
		const result = (await search.execute("t2", { query: "a fact", scope: "memory" }, undefined, undefined, ctx)) as { content: Array<{ text: string }> };
		expect(result.content[0]?.text).toContain("fact.md");
		await host.fire("tool_result", { toolName: "read", input: { path: join(dir, "fact.md") }, content: [{ type: "text", text: "x" }] }, ctx);
		await host.fire("agent_end", { messages: [] }, ctx);
		const stats = host.appendEntries.filter((e) => e.type === "cc-core-memory-stats");
		expect(stats.length).toBe(1);
		expect(stats[0]?.data).toMatchObject({ memoryReads: 1, lookups: 1, searches: 1, recallInjections: 0, descTooLong: 1, indexRows: 2 });
		expect((stats[0]?.data as { indexBytes: number }).indexBytes).toBeGreaterThan(0);
		// per run, not session-cumulative: a quiet second run reports zeros
		await host.fire("agent_end", { messages: [] }, ctx);
		const second = host.appendEntries.filter((e) => e.type === "cc-core-memory-stats")[1]?.data;
		expect(second).toMatchObject({ memoryReads: 0, lookups: 0, searches: 0, recallInjections: 0, descTooLong: 1, indexRows: 2 });
		// a missing memory dir is a clean miss, not a thrown tool error
		rmSync(dir, { recursive: true, force: true });
		const gone = (await lookup.execute("t3", { name: "anything" }, undefined, undefined, ctx)) as { content: Array<{ text: string }>; details: { ok: boolean } };
		expect(gone.details.ok).toBe(false);
		expect(gone.content[0]?.text).toContain('no memory named "anything"');
	});
});
