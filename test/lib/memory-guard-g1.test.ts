/**
 * Entropy-control G1 guard tests (docs/zh/entropy-control-spec.md).
 *
 * Function-level: guardMemoryToolCall covers [C1] frontmatter validation
 * (same-source with the index), [C2] wrong-directory, [C3] USER-layer
 * misfiling, [C6] child-session write ban, and the secret probe extended
 * to edit's edits[].
 *
 * Integration-level: the session_start/agent_end [C5] protected-file
 * baseline (direct fs write bypasses the guard → one UI notice) and the
 * [C3] warn-once dedup.
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeHost, clearCoreGlobals, restoreCoreGlobals, snapshotCoreGlobals } from "../contracts/fake-host.ts";
import memoryExtension from "../../extensions/memory/index.ts";
import { guardMemoryToolCall } from "../../extensions/memory/guard.ts";
import { eligibleMemories } from "../../extensions/memory/memdir.ts";
// Layer dirs as PLAIN paths (the guard only judges paths; the integration
// tests below use the real derived locations where it matters).
const userMemoryDir = (): string => join(home, ".pi", "agent", "memory");
const projectMemoryDir = (): string => join(project, "projmem", "memory");

const CCTUI_LIVE = { active: true, notificationsConsumer: false } as const;

let home: string;
let project: string;
let prevHome: string | undefined;
let globalsSnapshot: Record<string, unknown>;

const mk = (label: string): string => mkdtempSync(join(tmpdir(), `g1-${label}-`));
const validMemory = (name: string, desc: string, body = "body"): string =>
	`---\nname: ${name}\ndescription: ${desc}\nmetadata:\n  type: project\n---\n\n${body}`;

beforeEach(() => {
	globalsSnapshot = snapshotCoreGlobals();
	clearCoreGlobals();
	(globalThis as Record<string, unknown>).__piCcTui = CCTUI_LIVE;
	home = mk("home");
	project = mk("proj");
	process.env.HOME = home;
});

afterEach(() => {
	delete (globalThis as Record<string, unknown>).__piCcTui;
	if (prevHome === undefined) delete process.env.HOME;
	else process.env.HOME = prevHome;
	rmSync(home, { recursive: true, force: true });
	rmSync(project, { recursive: true, force: true });
	restoreCoreGlobals(globalsSnapshot);
});

const env = (over: Partial<Parameters<typeof guardMemoryToolCall>[2]> = {}) => ({
	projectDir: projectMemoryDir(),
	userDir: userMemoryDir(),
	childSession: false,
	...over,
});

describe("[C1] frontmatter validation — same source as the index", () => {
	it("blocks a write with no frontmatter block", () => {
		mkdirSync(projectMemoryDir(), { recursive: true });
		const v = guardMemoryToolCall("write", { path: join(projectMemoryDir(), "x.md"), content: "just prose, no frontmatter" }, env());
		expect(v.block).toBe(true);
		expect(v.reason).toContain("no frontmatter block");
	});

	it("blocks a write missing a required field (description)", () => {
		mkdirSync(projectMemoryDir(), { recursive: true });
		const v = guardMemoryToolCall("write", { path: join(projectMemoryDir(), "x.md"), content: "---\nname: x\nmetadata:\n  type: project\n---\n\nbody" }, env());
		expect(v.block).toBe(true);
		expect(v.reason).toContain("missing required field");
	});

	it("blocks a write with an invalid metadata.type value", () => {
		mkdirSync(projectMemoryDir(), { recursive: true });
		const v = guardMemoryToolCall("write", { path: join(projectMemoryDir(), "x.md"), content: "---\nname: x\ndescription: d\nmetadata:\n  type: diary\n---\n\nbody" }, env());
		expect(v.block).toBe(true);
		expect(v.reason).toContain("invalid metadata.type");
	});

	it("blocks an EDIT whose simulated result would be unindexable", () => {
		mkdirSync(projectMemoryDir(), { recursive: true });
		const file = join(projectMemoryDir(), "good.md");
		writeFileSync(file, validMemory("good", "fine"));
		const v = guardMemoryToolCall("edit", { path: file, edits: [{ oldText: "description: fine", newText: "description:" }] }, env());
		expect(v.block).toBe(true); // the post-edit content lacks description
	});

	it("passes a legal write — and the index agrees (same-source pin)", () => {
		mkdirSync(projectMemoryDir(), { recursive: true });
		const content = validMemory("ok", "an ok memory");
		const v = guardMemoryToolCall("write", { path: join(projectMemoryDir(), "ok.md"), content }, env());
		expect(v.block).toBe(false);
		// the index-side judgment must agree for exactly this content
		writeFileSync(join(projectMemoryDir(), "ok.md"), content);
		const indexed = eligibleMemories(userMemoryDir(), projectMemoryDir()).map((f) => f.title);
		expect(indexed).toContain("ok");
	});

	it("passes files the index skips by design (MEMORY.md)", () => {
		mkdirSync(projectMemoryDir(), { recursive: true });
		const v = guardMemoryToolCall("write", { path: join(projectMemoryDir(), "MEMORY.md"), content: "whatever" }, env());
		expect(v.block).toBe(false);
	});
});

describe("[C2] memory-shaped file outside both layers (10-03 repro)", () => {
	it("blocks repo-root memory/x.md carrying memory frontmatter, naming both correct dirs", () => {
		const v = guardMemoryToolCall("write", { path: join(project, "memory", "x.md"), content: validMemory("stray", "misplaced") }, env());
		expect(v.block).toBe(true);
		expect(v.reason).toContain(userMemoryDir());
		expect(v.reason).toContain(projectMemoryDir());
	});

	it("passes an ordinary doc at the same path (no memory frontmatter)", () => {
		const v = guardMemoryToolCall("write", { path: join(project, "memory", "notes.md"), content: "# Notes\n\nplain doc" }, env());
		expect(v.block).toBe(false);
	});
});

describe("[C3] USER-layer misfiling", () => {
	// The ~/ form only derives when the repo lives under $HOME (the real
	// shape: ~/Coding/<repo>), so this group uses a home-anchored root.
	const gitRoot = (): string => join(home, "code", "myrepo");

	it("blocks a USER entry embedding the git root absolute path without paths:", () => {
		const content = `---\nname: repo-fact\ndescription: d\nmetadata:\n  type: project\n---\n\nFact about ${gitRoot()}/src/tool.ts.`;
		const v = guardMemoryToolCall("write", { path: join(userMemoryDir(), "repo-fact.md"), content }, env({ gitRoot: gitRoot() }));
		expect(v.block).toBe(true);
		expect(v.reason).toContain("misfiled");
	});

	it("blocks on the ~/ form of the root path", () => {
		const tildeRoot = `~${gitRoot().slice(home.length)}`;
		const content = `---\nname: t\ndescription: d\nmetadata:\n  type: project\n---\n\nSee ${tildeRoot}/docs.`;
		const v = guardMemoryToolCall("write", { path: join(userMemoryDir(), "t.md"), content }, env({ gitRoot: gitRoot() }));
		expect(v.block).toBe(true);
	});

	it("passes when paths: scopes the entry", () => {
		const tildeRoot = `~${gitRoot().slice(home.length)}`;
		const content = `---\nname: scoped\ndescription: d\nmetadata:\n  type: project\npaths: ["${tildeRoot}/**"]\n---\n\nFact about ${gitRoot()}/src.`;
		const v = guardMemoryToolCall("write", { path: join(userMemoryDir(), "scoped.md"), content }, env({ gitRoot: gitRoot() }));
		expect(v.block).toBe(false);
	});

	it("warn-only for a bare short repo name", () => {
		const content = `---\nname: n\ndescription: d\nmetadata:\n  type: project\n---\n\nUseful ${basename(gitRoot())} trick.`;
		const v = guardMemoryToolCall("write", { path: join(userMemoryDir(), "n.md"), content }, env({ gitRoot: gitRoot() }));
		expect(v.block).toBe(false);
		expect(v.warn).toBeDefined();
	});
});

describe("[C6] child sessions never write memory", () => {
	it("blocks with PI_SUBAGENT_CHILD=1 on both layers", () => {
		mkdirSync(userMemoryDir(), { recursive: true });
		const v = guardMemoryToolCall("write", { path: join(userMemoryDir(), "x.md"), content: validMemory("x", "d") }, env({ childSession: true }));
		expect(v.block).toBe(true);
	});

	it("passes the same write when the flag is unset", () => {
		mkdirSync(userMemoryDir(), { recursive: true });
		const v = guardMemoryToolCall("write", { path: join(userMemoryDir(), "x.md"), content: validMemory("x", "d") }, env({ childSession: false }));
		expect(v.block).toBe(false);
	});
});

describe("secret probe now covers edit's edits[]", () => {
	it("blocks an edit whose newText carries a key literal even outside memory layers' old gaps", () => {
		mkdirSync(projectMemoryDir(), { recursive: true });
		const file = join(projectMemoryDir(), "s.md");
		writeFileSync(file, validMemory("s", "d"));
		const v = guardMemoryToolCall("edit", { path: file, edits: [{ oldText: "body text", newText: "token: ghp_" + "a".repeat(36) }] }, env());
		expect(v.block).toBe(true);
	});
});

describe("[C5]/warn-once integration through the extension hooks", () => {
	function boot() {
		const host = new FakeHost();
		memoryExtension(host.asPi());
		return host;
	}

	it("a direct fs write to permission-modes.json after session_start triggers exactly one notice at agent_end", async () => {
		const host = boot();
		const ctx = host.makeCtx({ cwd: project, ui: true });
		const agentDir = join(home, ".pi", "agent");
		mkdirSync(agentDir, { recursive: true });
		const pm = join(agentDir, "permission-modes.json");
		writeFileSync(pm, "{}");
		await host.fire("session_start", {}, ctx);
		// bypass the guard: direct fs write
		writeFileSync(pm, JSON.stringify({ permissions: { allow: ["bash"] } }));
		await host.fire("agent_end", {}, ctx);
		const hits = host.notifications.filter((n) => n.includes("permission-modes.json"));
		expect(hits.length).toBe(1);
		expect(hits[0]).toContain("outside the tool guard");
	});

	it("no notice when nothing changed", async () => {
		const host = boot();
		const ctx = host.makeCtx({ cwd: project, ui: true });
		await host.fire("session_start", {}, ctx);
		await host.fire("agent_end", {}, ctx);
		expect(host.notifications.filter((n) => n.includes("outside the tool guard")).length).toBe(0);
	});

	it("[C4] the guard blocks write to settings.json through the tool hook", async () => {
		const host = boot();
		const ctx = host.makeCtx({ cwd: project, ui: true });
		const verdict = (await host.fire("tool_call", { toolName: "write", input: { path: join(home, ".pi", "agent", "settings.json"), content: "{}" } }, ctx)) as { block?: boolean } | undefined;
		expect(verdict?.block).toBe(true);
	});

	it("[C3] the same warn fires once per session through the hook", async () => {
		const gitRoot = join(home, "code", "hookrepo");
		mkdirSync(gitRoot, { recursive: true });
		execSync("git init -q", { cwd: gitRoot }); // gitCanonicalRoot runs rev-parse — needs a real repo
		const host = boot();
		const ctx = host.makeCtx({ cwd: gitRoot, ui: true });
		const warnWrite = { path: join(userMemoryDir(), "w.md"), content: `---\nname: w\ndescription: d\nmetadata:\n  type: project\n---\n\nhandy hookrepo trick.` };
		await host.fire("tool_call", { toolName: "write", input: warnWrite }, ctx);
		await host.fire("tool_call", { toolName: "write", input: warnWrite }, ctx);
		const warns = host.notifications.filter((n) => n.includes("paths:"));
		expect(warns.length).toBe(1);
	});
});
