import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FakeHost } from "../contracts/fake-host.ts";
import notesIndexExtension from "../../extensions/notes-index/index.ts";
import { buildIndexBlock } from "../../extensions/notes-index/render.ts";
import type { NoteFile } from "../../extensions/notes-index/notes-dir.ts";
import { defaultNotesDir } from "../../lib/agent-paths.ts";
import { setCoreEconomyPath } from "../../lib/core-economy.ts";
import coreExtension from "../../extensions/index.ts";

let home: string;
let prevHome: string | undefined;
let cwd: string;

function note(dir: string, slug: string, description?: string, pinned = false, body = "body"): string {
	mkdirSync(dir, { recursive: true });
	const path = join(dir, `${slug}.md`);
	writeFileSync(
		path,
		description === undefined
			? `# ${slug} title\n\nno frontmatter here\n`
			: `---\nname: ${slug}\ndescription: ${description}\nmetadata:\n  type: project${pinned ? "\n  pinned: true" : ""}\n---\n\n${body}\n`,
	);
	return path;
}

function writeConfig(dir: string, notesIndex: Record<string, unknown>): string {
	const file = join(dir, "core-economy.json");
	writeFileSync(file, JSON.stringify({ notesIndex }));
	setCoreEconomyPath(file);
	return file;
}

async function firstRun(host: FakeHost, ctx: Record<string, unknown>, messageType = "user"): Promise<string> {
	const handlers = host.handlers.get("before_agent_start") ?? [];
	let event: Record<string, unknown> = { messageType, systemPrompt: "BASE", prompt: "go" };
	for (const h of handlers) {
		const result = (await h(event, ctx)) as Record<string, unknown> | undefined;
		if (result && typeof result === "object") event = { ...event, ...result };
	}
	return event.systemPrompt as string;
}

beforeEach(() => {
	prevHome = process.env.HOME;
	home = mkdtempSync(join(tmpdir(), "notes-home-"));
	cwd = mkdtempSync(join(tmpdir(), "notes-cwd-"));
	process.env.HOME = home;
	setCoreEconomyPath(join(home, "core-economy.json"));
});
afterEach(() => {
	if (prevHome === undefined) delete process.env.HOME;
	else process.env.HOME = prevHome;
	rmSync(home, { recursive: true, force: true });
	rmSync(cwd, { recursive: true, force: true });
});

describe("notes-index: the only memory feature core keeps", () => {
	it("appends the notes block: pinned first, then one row per note sorted by slug, with the directory line", async () => {
		const dir = defaultNotesDir(cwd, home);
		note(dir, "zeta", "last row");
		note(dir, "alpha", "first row");
		note(dir, "pinned-one", "always on", true, "do this\nalways");
		const host = new FakeHost();
		notesIndexExtension(host.asPi());
		const prompt = await firstRun(host, host.makeCtx({ cwd }));
		expect(prompt.startsWith("BASE\n\n# Project notes\n\nDirectory: ")).toBe(true);
		expect(prompt).toContain(`Directory: ${dir} — read a note with rg/read when a row is relevant.`);
		const pinnedAt = prompt.indexOf("## Pinned memories (always active)");
		const alphaAt = prompt.indexOf("- alpha — first row");
		const zetaAt = prompt.indexOf("- zeta — last row");
		expect(pinnedAt).toBeGreaterThan(0);
		expect(prompt.indexOf("### pinned-one")).toBeGreaterThan(pinnedAt);
		expect(prompt.indexOf("do this\nalways")).toBeGreaterThan(pinnedAt);
		expect(alphaAt).toBeGreaterThan(pinnedAt);
		expect(zetaAt).toBeGreaterThan(alphaAt);
		expect(prompt).not.toContain("- pinned-one —");
		expect(prompt).not.toContain("memory-policy");
	});

	it("is injected into custom-message runs too, with the same text", async () => {
		const dir = defaultNotesDir(cwd, home);
		note(dir, "alpha", "row");
		const host = new FakeHost();
		notesIndexExtension(host.asPi());
		const ctx = host.makeCtx({ cwd });
		const user = await firstRun(host, ctx, "user");
		const custom = await firstRun(host, ctx, "custom");
		expect(custom).toBe(user);
	});

	it("a note without frontmatter or description is listed as (no description); index files are not notes", async () => {
		const dir = defaultNotesDir(cwd, home);
		note(dir, "plain");
		note(dir, "nodesc", undefined);
		writeFileSync(join(dir, "nodesc2.md"), "---\nname: nodesc2\nmetadata:\n  type: project\n---\nbody\n");
		writeFileSync(join(dir, "index.md"), "# hand-written index\n");
		writeFileSync(join(dir, "MEMORY.md"), "# generated index\n");
		const host = new FakeHost();
		notesIndexExtension(host.asPi());
		const prompt = await firstRun(host, host.makeCtx({ cwd }));
		expect(prompt).toContain("- plain — plain title");
		expect(prompt).toContain("- nodesc2 — (no description)");
		expect(prompt).not.toContain("- index —");
		expect(prompt).not.toContain("- MEMORY —");
	});

	it("a missing directory leaves the system prompt untouched", async () => {
		const host = new FakeHost();
		notesIndexExtension(host.asPi());
		expect(await firstRun(host, host.makeCtx({ cwd }))).toBe("BASE");
	});

	it("a path that exists but is not a directory is treated as missing", async () => {
		const dir = defaultNotesDir(cwd, home);
		mkdirSync(join(dir, ".."), { recursive: true });
		writeFileSync(dir, "not a dir");
		const host = new FakeHost();
		notesIndexExtension(host.asPi());
		expect(await firstRun(host, host.makeCtx({ cwd }))).toBe("BASE");
	});

	it("enabled: false disables the module even when the directory exists", async () => {
		note(defaultNotesDir(cwd, home), "alpha", "row");
		writeConfig(home, { enabled: false });
		const host = new FakeHost();
		notesIndexExtension(host.asPi());
		expect(await firstRun(host, host.makeCtx({ cwd }))).toBe("BASE");
	});

	it("notesIndex.dir overrides the default directory", async () => {
		const vaultDir = join(home, "vault", "Agent Notes", "host-project");
		note(vaultDir, "vault-note", "from the vault");
		note(defaultNotesDir(cwd, home), "local-note", "from the default dir");
		writeConfig(home, { dir: vaultDir });
		const host = new FakeHost();
		notesIndexExtension(host.asPi());
		const prompt = await firstRun(host, host.makeCtx({ cwd }));
		expect(prompt).toContain(`Directory: ${vaultDir}`);
		expect(prompt).toContain("- vault-note — from the vault");
		expect(prompt).not.toContain("local-note");
	});

	it("pinned notes from pinnedDir (default <agentDir>/memory) are injected in every project", async () => {
		note(join(home, ".pi", "agent", "memory"), "global-rule", "pinned global", true, "always");
		note(defaultNotesDir(cwd, home), "alpha", "row");
		const host = new FakeHost();
		notesIndexExtension(host.asPi());
		const prompt = await firstRun(host, host.makeCtx({ cwd }));
		expect(prompt.indexOf("### global-rule")).toBeGreaterThan(prompt.indexOf("## Pinned memories"));
		expect(prompt.indexOf("## Pinned memories")).toBeLessThan(prompt.indexOf("- alpha — row"));
	});

	it("a session opened in a repository subdirectory resolves the root-keyed directory", async () => {
		const root = mkdtempSync(join(tmpdir(), "notes-repo-"));
		try {
			execFileSync("git", ["init", "-q", root]);
			const sub = join(root, "packages", "a");
			mkdirSync(sub, { recursive: true });
			// git reports the real path (tmpdir is a symlink on macOS); the key is the sanitized real root
			const dir = join(home, ".pi", "agent", "projects", realpathSync(root).replace(/[/\\]/g, "-"), "memory");
			note(dir, "root-note", "keyed by the git root");
			const host = new FakeHost();
			notesIndexExtension(host.asPi());
			const prompt = await firstRun(host, host.makeCtx({ cwd: sub }));
			expect(prompt).toContain("- root-note — keyed by the git root");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("stays byte-identical within a session (a new note does not move it) and rebuilds after a compaction", async () => {
		const dir = defaultNotesDir(cwd, home);
		note(dir, "alpha", "row");
		const host = new FakeHost();
		notesIndexExtension(host.asPi());
		const projection: unknown[] = [];
		const ctx = host.makeCtx({ cwd, projectionMessages: projection });
		const first = await firstRun(host, ctx);
		note(dir, "beta", "added mid-session");
		expect(await firstRun(host, ctx)).toBe(first);
		projection.push({ role: "compactionSummary" }, { role: "user" });
		const afterCompaction = await firstRun(host, ctx);
		expect(afterCompaction).toContain("- beta — added mid-session");
	});

	it("an unreadable directory yields a header-only block instead of throwing", async () => {
		const dir = defaultNotesDir(cwd, home);
		note(dir, "alpha", "row");
		chmodSync(dir, 0o000);
		try {
			const host = new FakeHost();
			notesIndexExtension(host.asPi());
			const prompt = await firstRun(host, host.makeCtx({ cwd }));
			expect(prompt).toContain("# Project notes");
			expect(prompt).not.toContain("- alpha —");
		} finally {
			chmodSync(dir, 0o700);
		}
	});

	it("the assembled core injects the block and declares session_recall but no memory tools", async () => {
		note(defaultNotesDir(cwd, home), "alpha", "row");
		const host = new FakeHost();
		await coreExtension(host.piObject() as never);
		const prompt = await firstRun(host, host.makeCtx({ cwd }));
		expect(prompt).toContain("- alpha — row");
		const registered = [...host.tools.keys()];
		expect(registered).toContain("session_recall");
		const declared = host.activeToolsCalls.at(-1) ?? [];
		for (const gone of ["memory_consolidate", "memory_lookup", "knowledge_search"]) {
			expect(registered).not.toContain(gone);
			expect([...declared]).not.toContain(gone);
		}
	});
});

describe("buildIndexBlock budget", () => {
	const mk = (slug: string, description: string, pinned = false): NoteFile => ({
		file: `${slug}.md`,
		slug,
		title: slug,
		description,
		pinned,
		body: "body",
	});

	it("caps rows by bytes and ends with a +N more row", () => {
		const notes = Array.from({ length: 20 }, (_, i) => mk(`n${String(i).padStart(2, "0")}`, "x".repeat(40)));
		const text = buildIndexBlock("/dir", notes, [], 0, 600);
		expect(text).toMatch(/… \+\d+ more$/);
		expect(text).not.toContain("- n19 —");
		expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(600);
	});

	it("marks over-long descriptions, notes dropped pinned notes and unreadable files", () => {
		const text = buildIndexBlock(
			"/dir",
			[mk("long", "y".repeat(81)), mk("short", "ok")],
			[{ ...mk("big", "pinned", true), body: "z".repeat(1_300) }],
			2,
		);
		expect(text).toContain("- long — " + "y".repeat(81) + " ⚠");
		expect(text).toContain("<!-- notes: 2 file(s) unreadable -->");
		expect(text).toContain("<!-- notes: 1 pinned note(s) dropped (over budget) -->");
	});
});
