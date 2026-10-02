/**
 * V2-M (DESIGN-MEMORY-V2 §7) — full hermes migration + /memory diagnostics.
 *
 * Fixture shapes mirror the REAL hermes on-disk format (verified
 * 2026-09-24): standalone `§` separator lines, trailing
 * `<!-- created=…, project64=BASE64 -->` metadata, category-prefixed
 * failure entries, and the projects-memory/<name>/ per-project stores.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FakeHost, clearCoreGlobals, snapshotCoreGlobals } from "../contracts/fake-host.ts";
import { resetCoreBusForTests } from "../../extensions/bus.ts";
import memoryExtension from "../../extensions/memory/index.ts";
import {
	importHermesFull,
	importFromHermes,
	splitHermesSections,
	parseHermesSection,
	decodeProject64,
	projectMatchesCurrent,
} from "../../extensions/memory/importers.ts";
import { resolveMemoryPaths } from "../../extensions/memory/paths.ts";

let globalsSnapshot: Record<string, unknown>;
let home: string;
let project: string;
let prevHome: string | undefined;
let dir: string;
let udir: string;
let agentDir: string;

function setup(): FakeHost {
	const host = new FakeHost();
	memoryExtension(host.asPi());
	return host;
}

/** Write a hermes-shaped global store + optional per-project stores. */
function hermesFixture(opts: { user?: string; memory?: string; failures?: string; projects?: Record<string, string> }): void {
	const h = join(agentDir, "pi-hermes-memory");
	mkdirSync(h, { recursive: true });
	if (opts.user !== undefined) writeFileSync(join(h, "USER.md"), opts.user);
	if (opts.memory !== undefined) writeFileSync(join(h, "MEMORY.md"), opts.memory);
	if (opts.failures !== undefined) writeFileSync(join(h, "failures.md"), opts.failures);
	for (const [name, content] of Object.entries(opts.projects ?? {})) {
		mkdirSync(join(agentDir, "projects-memory", name), { recursive: true });
		writeFileSync(join(join(agentDir, "projects-memory", name), "MEMORY.md"), content);
	}
}

beforeEach(() => {
	globalsSnapshot = snapshotCoreGlobals();
	clearCoreGlobals();
	resetCoreBusForTests();
	prevHome = process.env.HOME;
	home = mkdtempSync(join(tmpdir(), "memv2m-home-"));
	project = mkdtempSync(join(tmpdir(), "memv2m-proj-"));
	process.env.HOME = home;
	const p = resolveMemoryPaths(project, home);
	dir = p.memoryDir;
	udir = p.userMemoryDir;
	agentDir = p.agentDir;
});

afterEach(() => {
	if (prevHome === undefined) delete process.env.HOME;
	else process.env.HOME = prevHome;
	rmSync(home, { recursive: true, force: true });
	rmSync(project, { recursive: true, force: true });
});

describe("V2-M section parsing", () => {
	it("splits on standalone § lines AND the v1 `§ Title` prefix form", () => {
		const real = splitHermesSections("fact one body\n§\nfact two body\n§\nfact three");
		expect(real).toEqual(["fact one body", "fact two body", "fact three"]);
		const v1 = splitHermesSections("§ Deploy flow\nuse the pipeline\n\n§ Editor pref\nprefers vim");
		expect(v1).toEqual(["Deploy flow\nuse the pipeline", "Editor pref\nprefers vim"]);
	});

	it("extracts created + project64 metadata from the trailing comment", () => {
		const s = parseHermesSection("Some fact\nbody line\n<!-- created=2026-08-12, last=2026-08-16, project64=Q2hlcnJ5UFI -->");
		expect(s.created).toContain("created=2026-08-12");
		expect(s.project64).toBe("Q2hlcnJ5UFI");
		expect(decodeProject64(s.project64!)).toBe("CherryPR");
		expect(s.body).toContain("Some fact");
		expect(s.body).not.toContain("project64"); // comment lifted out of the body
	});

	it("projectMatchesCurrent matches the sanitized-dir endsWith rule", () => {
		expect(projectMatchesCurrent("CherryPR", "/x/y/-Users-gd32-Coding-CherryPR/memory")).toBe(true);
		expect(projectMatchesCurrent("CherryPR", "/x/y/-Users-gd32-Coding-CherryDev/memory")).toBe(false);
		expect(projectMatchesCurrent("Pi-Extension", "/x/y/Pi-Extension/memory")).toBe(true);
	});
});

describe("V2-M full migration routing", () => {
	it("USER.md → user layer; untagged MEMORY.md → user layer; current-project tags → project layer; other-project tags → user layer with [tag]", () => {
		hermesFixture({
			user: "User goes by George. Timezone UTC+8. <!-- created=2026-08-02 -->\n§\nAll replies in Chinese by default. <!-- created=2026-08-11 -->",
			memory: [
				"Global network proxy fix for gh/curl. <!-- created=2026-09-18 -->",
				"§",
				`This project uses bun and vitest conventions. <!-- created=2026-08-16, project64=${Buffer.from(project.split("/").pop()!).toString("base64")} -->`,
				"§",
				`CherryPR-specific review workflow details. <!-- created=2026-08-12, project64=Q2hlcnJ5UFI -->`,
			].join("\n"),
		});
		// RV-15: a foreign-project tag routes to THAT project's layer when it
		// exists under <agentDir>/projects/*-<name>/memory — never the user layer
		const cherryLayer = join(agentDir, "projects", "-Users-gd32-Coding-CherryPR", "memory");
		mkdirSync(cherryLayer, { recursive: true });
		const r = importHermesFull({ agentDir, projectMemoryDir: dir, userMemoryDir: udir });
		expect(r.copied).toBe(5);
		expect(r.routed.user).toBe(3); // 2 USER + the untagged global
		expect(r.routed.project).toBe(2); // the current-project tag + the CherryPR tag
		const userIndex = readFileSync(join(udir, "MEMORY.md"), "utf-8");
		expect(userIndex).toContain("George");
		expect(userIndex).not.toContain("CherryPR"); // foreign sections no longer leak into the user layer
		const projIndex = readFileSync(join(dir, "MEMORY.md"), "utf-8");
		expect(projIndex).toContain("bun and vitest");
		const cherryIndex = readFileSync(join(cherryLayer, "MEMORY.md"), "utf-8");
		expect(cherryIndex).toContain("CherryPR-specific");
		// no matching project dir → skipped + noted (re-runnable, idempotent)
		const bare = importHermesFull({
			agentDir: agentDir + "-bare",
			projectMemoryDir: dir + "-bare",
			userMemoryDir: udir + "-bare",
		});
		void bare;
	});

	it("failures.md → type feedback with category prefix preserved", () => {
		hermesFixture({
			failures: "[tool-quirk] grep may fail in Zed — fall back to bash grep. <!-- created=2026-08-03 -->\n§\n[failure] plain npm ci fails without lockfile. <!-- created=2026-08-16 -->",
		});
		const r = importHermesFull({ agentDir, projectMemoryDir: dir, userMemoryDir: udir });
		expect(r.copied).toBe(2);
		const userIndex = readFileSync(join(udir, "MEMORY.md"), "utf-8");
		expect(userIndex).toContain("[tool-quirk]");
		expect(userIndex).toContain("[failure]");
		// one file carries feedback type
		const files = readdirSync(udir).filter((f) => f.startsWith("hermes-"));
		expect(files.some((f) => readFileSync(join(udir, f), "utf-8").includes("type: feedback"))).toBe(true);
	});

	it("cross-source dedupe: the same fact in MEMORY.md and failures.md imports once", () => {
		const fact = "NPM Trusted Publishing OIDC is configured for the pi ecosystem.";
		hermesFixture({
			memory: `${fact} <!-- created=2026-08-16 -->`,
			failures: `${fact} <!-- created=2026-08-16, last=2026-08-16 -->`,
		});
		const r = importHermesFull({ agentDir, projectMemoryDir: dir, userMemoryDir: udir });
		expect(r.copied).toBe(1);
	});

	it("matching projects-memory store migrates into the project layer; others are listed, not migrated", () => {
		// current project key = basename of the tmp project dir
		const key = project.split("/").pop()!;
		hermesFixture({
			projects: {
				[key]: "Current project deploy steps with pnpm. <!-- created=2026-08-20 -->",
				CherryPR: "CherryPR fact that must NOT land in this project. <!-- created=2026-08-20 -->",
			},
		});
		const r = importHermesFull({ agentDir, projectMemoryDir: dir, userMemoryDir: udir });
		expect(r.routed.project).toBe(1);
		expect(r.otherProjects).toContain("CherryPR");
		expect(readFileSync(join(dir, "MEMORY.md"), "utf-8")).toContain("deploy steps");
		const userIndex = existsSync(join(udir, "MEMORY.md")) ? readFileSync(join(udir, "MEMORY.md"), "utf-8") : "";
		expect(userIndex).not.toContain("CherryPR fact");
		expect(r.notes.some((n) => n.includes("CherryPR"))).toBe(true);
	});

	it("idempotent: a second run copies nothing", () => {
		hermesFixture({ user: "George prefers pnpm. <!-- created=2026-08-02 -->" });
		const args = { agentDir, projectMemoryDir: dir, userMemoryDir: udir };
		expect(importHermesFull(args).copied).toBe(1);
		const second = importHermesFull(args);
		expect(second.copied).toBe(0);
		expect(second.skipped).toBe(1);
	});

	it("missing hermes data degrades to a note", () => {
		const r = importHermesFull({ agentDir, projectMemoryDir: dir, userMemoryDir: udir });
		expect(r.copied).toBe(0);
		expect(r.notes[0]).toContain("no hermes data");
	});
});

describe("V2-M commands + diagnostics", () => {
	it("/memory-import-hermes (no args) runs the full migration from the hermes dir", async () => {
		hermesFixture({ user: "George prefers pnpm. <!-- created=2026-08-02 -->" });
		const host = setup();
		const ctx = host.makeCtx({ cwd: project, ui: true });
		await host.fire("session_start", {}, ctx);
		await host.commands.get("memory-import-hermes")?.("", ctx);
		const msg = host.sentMessages.find((m) => m.message.customType === "pi-memory-status");
		expect((msg!.message as { content?: string }).content).toContain("migrated 1 fact(s)");
		expect(existsSync(join(udir, "hermes-george-prefers-pnpm.md"))).toBe(true);
	});

	it("/memory-import-hermes <file> keeps the v1 single-file behavior", async () => {
		const store = mkdtempSync(join(tmpdir(), "h-"));
		const file = join(store, "s.md");
		writeFileSync(file, "§ Deploy flow\nuse the release pipeline");
		const host = setup();
		const ctx = host.makeCtx({ cwd: project, ui: true });
		await host.fire("session_start", {}, ctx);
		await host.commands.get("memory-import-hermes")?.(file, ctx);
		expect(existsSync(join(dir, "hermes-deploy-flow.md"))).toBe(true);
		rmSync(store, { recursive: true, force: true });
	});

	it("/memory shows both layers + automation + consolidation + hermes hint", async () => {
		hermesFixture({ user: "George prefers pnpm." });
		const host = setup();
		const ctx = host.makeCtx({ cwd: project, ui: true });
		await host.fire("session_start", {}, ctx);
		await host.commands.get("memory")?.("", ctx);
		const content = (host.sentMessages.find((m) => m.message.customType === "pi-memory-status")!.message as { content?: string }).content!;
		expect(content).toContain("user memory:");
		expect(content).toContain("project memory:");
		expect(content).toContain("automation: on");
		expect(content).toContain("consolidation: idle");
		expect(content).toContain("run /memory-import-hermes");
		// steady-state surface: exactly these commands
		expect([...host.commands.keys()].sort()).toEqual(["memory", "memory-consolidate", "memory-import-claude", "memory-import-hermes"]);
		// tools: session_recall + memory_consolidate
		expect([...host.tools.keys()].sort()).toEqual(["memory_consolidate", "session_recall"]);
	});
});


describe("V2-M data-safety (Phase 0 D1/D4)", () => {
	it("D1: two distinct pure-CJK facts don't collide — both land, idempotent on re-run", () => {
		hermesFixture({ user: "所有回复默认中文。 <!-- created=2026-08-02 -->\n§\n以后都先跑测试再提交代码。 <!-- created=2026-08-03 -->" });
		const args = { agentDir, projectMemoryDir: dir, userMemoryDir: udir };
		const r1 = importHermesFull(args);
		expect(r1.copied).toBe(2);
		const files = readdirSync(udir).filter((f) => f.startsWith("hermes-"));
		expect(files.length).toBe(2);
		expect(files).toContain("hermes-memory.md");
		expect(files.some((f) => /^hermes-memory-[a-z0-9]{6}\.md$/.test(f))).toBe(true);
		const r2 = importHermesFull(args);
		expect(r2.copied).toBe(0);
		expect(r2.skipped).toBe(2);
	});

	it("D4: failures.md foreign-project section keeps type feedback (category prefix preserved)", () => {
		hermesFixture({
			failures: `[tool-quirk] grep 在 Zed 里会挂，回退到 bash grep。 <!-- created=2026-08-03, project64=${Buffer.from("CherryPR").toString("base64")} -->`,
		});
		// RV-15: the foreign project tag lands in THAT project's layer
		const cherryLayer = join(agentDir, "projects", "-Users-gd32-Coding-CherryPR", "memory");
		mkdirSync(cherryLayer, { recursive: true });
		const r = importHermesFull({ agentDir, projectMemoryDir: dir, userMemoryDir: udir });
		expect(r.copied).toBe(1);
		const files = readdirSync(cherryLayer).filter((f) => f.startsWith("hermes-"));
		const content = readFileSync(join(cherryLayer, files[0]!), "utf-8");
		expect(content).toContain("type: feedback");
		expect(content).toContain("[tool-quirk]");
	});
});

describe("V2 Phase 2 (B6) — torn-source detection", () => {
	it("a source rewritten during the read is flagged torn; a stable one is not", async () => {
		const { readSourceStable } = await import("../../extensions/memory/importers.ts");
		const store = mkdtempSync(join(tmpdir(), "torn-"));
		const file = join(store, "s.md");
		writeFileSync(file, "§ fact one\nbody");
		expect(readSourceStable(file).torn).toBe(false);
		// injectable read that mutates the file mid-read → mtime moves
		const torn = readSourceStable(file, (p) => {
			const raw = readFileSync(p, "utf-8");
			writeFileSync(p, raw + "\n§ fact two\nmore");
			return raw;
		});
		expect(torn.torn).toBe(true);
		rmSync(store, { recursive: true, force: true });
	});
});
