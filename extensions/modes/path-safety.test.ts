/**
 * path-safety tests — carved from utils.test.ts (arch review C3).
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, symlinkSync, existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { commandReferencesSensitivePath, commandTargetsOutsideCwd, findProjectRoot, getProjectId, getProjectTmpDir, hashPath, isInsideProject, isOutsideCwd, isSensitivePath } from "./path-safety.ts";

describe("isOutsideCwd", () => {
	const cwd = "/home/user/project";

	it("returns false for paths inside cwd", () => {
		expect(isOutsideCwd("./foo", cwd)).toBe(false);
		expect(isOutsideCwd("src/index.ts", cwd)).toBe(false);
		expect(isOutsideCwd(".", cwd)).toBe(false);
		expect(isOutsideCwd(cwd, cwd)).toBe(false);
	});

	it("returns true for paths outside cwd", () => {
		expect(isOutsideCwd("../foo", cwd)).toBe(true);
		expect(isOutsideCwd("/etc/passwd", cwd)).toBe(true);
		expect(isOutsideCwd("/tmp/something", cwd)).toBe(true);
	});

	it("returns false for empty string (no path = inside cwd by default)", () => {
		expect(isOutsideCwd("", cwd)).toBe(false);
	});

	it("treats symlinked in-cwd paths as outside when target resolves elsewhere", () => {
		const root = mkdtempSync(join(tmpdir(), "pm-outside-sym-"))
		const outside = mkdtempSync(join(tmpdir(), "pm-outside-target-"))
		const linkPath = join(root, "link")
		symlinkSync(outside, linkPath)
		expect(isOutsideCwd("link/secret.txt", root)).toBe(true)
		rmSync(root, { recursive: true, force: true })
		rmSync(outside, { recursive: true, force: true })
	});
});

describe("commandTargetsOutsideCwd", () => {
	const cwd = "/home/user/project";

	it("flags commands with absolute paths outside cwd", () => {
		expect(commandTargetsOutsideCwd("ls /etc/passwd", cwd)).toBe(true);
		expect(commandTargetsOutsideCwd("cat /tmp/foo", cwd)).toBe(true);
	});

	it("flags cd .. / ../ traversal", () => {
		expect(commandTargetsOutsideCwd("cd ..", cwd)).toBe(true);
		expect(commandTargetsOutsideCwd("ls ../sibling", cwd)).toBe(true);
		expect(commandTargetsOutsideCwd("cat ../../foo", cwd)).toBe(true);
	});

	it("flags ~ expansion", () => {
		expect(commandTargetsOutsideCwd("ls ~", cwd)).toBe(true);
		expect(commandTargetsOutsideCwd("cat ~/notes.txt", cwd)).toBe(true);
	});

	it("flags $HOME / $TMPDIR expansions", () => {
		expect(commandTargetsOutsideCwd("ls $HOME", cwd)).toBe(true);
		expect(commandTargetsOutsideCwd("cat $TMPDIR/foo", cwd)).toBe(true);
	});

	it("does NOT flag safe commands that don't reference paths", () => {
		expect(commandTargetsOutsideCwd("ls", cwd)).toBe(false);
		expect(commandTargetsOutsideCwd("ps aux", cwd)).toBe(false);
	});

	it("does NOT flag commands that only reference cwd-local paths", () => {
		expect(commandTargetsOutsideCwd("cat ./foo.txt", cwd)).toBe(false);
		expect(commandTargetsOutsideCwd("ls src/", cwd)).toBe(false);
	});

	it("flags read-only commands that reference outside paths", () => {
		expect(commandTargetsOutsideCwd("cat /etc/passwd", cwd)).toBe(true);
		expect(commandTargetsOutsideCwd("grep foo /etc/hosts", cwd)).toBe(true);
	});

	it("returns false for empty / whitespace", () => {
		expect(commandTargetsOutsideCwd("", cwd)).toBe(false);
		expect(commandTargetsOutsideCwd("   ", cwd)).toBe(false);
	});
});

describe("findProjectRoot", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "perm-modes-test-"));
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("detects .git directory", () => {
		mkdirSync(join(tmpDir, ".git"));
		mkdirSync(join(tmpDir, "src"));
		expect(findProjectRoot(join(tmpDir, "src"))).toBe(tmpDir);
	});

	it("detects package.json", () => {
		writeFileSync(join(tmpDir, "package.json"), "{}");
		mkdirSync(join(tmpDir, "src"));
		expect(findProjectRoot(join(tmpDir, "src"))).toBe(tmpDir);
	});

	it("returns null when no markers found", () => {
		mkdirSync(join(tmpDir, "src"));
		expect(findProjectRoot(join(tmpDir, "src"))).toBe(null);
	});

	it("stops at the innermost project root (nested package.json)", () => {
		writeFileSync(join(tmpDir, "package.json"), "{}");
		mkdirSync(join(tmpDir, "packages"));
		mkdirSync(join(tmpDir, "packages", "app"));
		writeFileSync(join(tmpDir, "packages", "app", "package.json"), "{}");
		// walking up from packages/app should stop at packages/app (innermost)
		expect(findProjectRoot(join(tmpDir, "packages", "app"))).toBe(
			join(tmpDir, "packages", "app"),
		);
	});
});

describe("isInsideProject", () => {
	const cwd = "/home/user/project/src"
	const projectRoot = "/home/user/project"

	it("returns true for path inside project root", () => {
		expect(isInsideProject("./foo.ts", cwd, projectRoot)).toBe(true)
		expect(isInsideProject("index.ts", cwd, projectRoot)).toBe(true)
	})

	it("returns true for path outside cwd but inside project root (relaxation case)", () => {
		// cwd is /home/user/project/src, project root is /home/user/project
		// writing to ../README.md = /home/user/project/README.md → inside project
		expect(isInsideProject("../README.md", cwd, projectRoot)).toBe(true)
	})

	it("returns false for path outside project root", () => {
		expect(isInsideProject("/etc/passwd", cwd, projectRoot)).toBe(false)
		expect(isInsideProject("../../sibling/foo", cwd, projectRoot)).toBe(false)
	})

	it("returns false when project root is null", () => {
		expect(isInsideProject("./foo.ts", cwd, null)).toBe(false)
	})

	it("returns true for project root itself", () => {
		expect(isInsideProject(".", cwd, projectRoot)).toBe(true)
	})
})

describe("getProjectId", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "pm-pid-"));
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("returns existing hash from .pi/permission-modes-*.md", () => {
		mkdirSync(join(tmpDir, ".pi"), { recursive: true });
		writeFileSync(
			join(tmpDir, ".pi", "permission-modes-45ea0551.md"),
			"# project marker",
		);
		expect(getProjectId(tmpDir)).toBe("45ea0551");
	});

	it("falls back to cwd hash when no marker exists", () => {
		const id = getProjectId(tmpDir);
		expect(id).toMatch(/^[a-f0-9]{8}$/);
		expect(id).toBe(getProjectId(tmpDir)); // deterministic
	});

	it("falls back when .pi/ exists but no permission-modes-*.md", () => {
		mkdirSync(join(tmpDir, ".pi"), { recursive: true });
		writeFileSync(join(tmpDir, ".pi", "other.md"), "");
		const id = getProjectId(tmpDir);
		expect(id).toMatch(/^[a-f0-9]{8}$/);
	})

	it("switches from hash fallback to marker id when the marker appears mid-session", () => {
		// Positive-only caching (plan A2): a marker created after the first
		// hash-fallback call must win on the next call.
		const before = getProjectId(tmpDir);
		expect(before).toMatch(/^[a-f0-9]{8}$/);
		mkdirSync(join(tmpDir, ".pi"), { recursive: true });
		writeFileSync(
			join(tmpDir, ".pi", "permission-modes-deadbeef.md"),
			"# project marker",
		);
		expect(getProjectId(tmpDir)).toBe("deadbeef");
	})
});

describe("hashPath", () => {
	it("returns deterministic 8-char hex hash", () => {
		expect(hashPath("/etc/passwd")).toMatch(/^[a-f0-9]{8}$/);
		expect(hashPath("/etc/passwd")).toBe(hashPath("/etc/passwd"));
	});

	it("returns different hashes for different paths", () => {
		expect(hashPath("/etc/passwd")).not.toBe(hashPath("/etc/hosts"));
	});

	it("handles empty string", () => {
		expect(hashPath("")).toMatch(/^[a-f0-9]{8}$/);
	});
});

describe("getProjectTmpDir", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "pm-tmp-"));
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("creates .pi/projects/<id>/tmp/outside-writes/", () => {
		const result = getProjectTmpDir(tmpDir);
		expect(existsSync(result)).toBe(true);
		expect(result).toContain(".pi/projects/");
		expect(result).toContain("/tmp/outside-writes");
		expect(result.startsWith(tmpDir)).toBe(true);
	});

	it("uses existing project hash when present", () => {
		mkdirSync(join(tmpDir, ".pi"), { recursive: true });
		writeFileSync(
			join(tmpDir, ".pi", "permission-modes-deadbeef.md"),
			"",
		);
		expect(getProjectTmpDir(tmpDir)).toContain("/deadbeef/");
	});

	it("is idempotent (second call returns same path)", () => {
		const a = getProjectTmpDir(tmpDir);
		const b = getProjectTmpDir(tmpDir);
		expect(a).toBe(b);
	});
});

describe("isOutsideCwd with tilde", () => {
	it("treats ~/outside as outside project cwd", () => {
		const cwd = join(homedir(), "project")
		expect(isOutsideCwd("~/secrets.txt", cwd)).toBe(true)
	})
})

describe("isSensitivePath", () => {
	const cwd = "/home/user/project"

	it("flags .git paths", () => {
		expect(isSensitivePath(".git/config", cwd)).toBe(true)
		expect(isSensitivePath("../other/.git/HEAD", cwd)).toBe(true)
	})

	it("flags .env files", () => {
		expect(isSensitivePath(".env", cwd)).toBe(true)
		expect(isSensitivePath(".env.local", cwd)).toBe(true)
	})

	it("allows ordinary project files", () => {
		expect(isSensitivePath("src/foo.ts", cwd)).toBe(false)
		expect(isSensitivePath("/etc/passwd", cwd)).toBe(false)
	})
})

describe("commandReferencesSensitivePath", () => {
	it("flags commands touching .git or .env", () => {
		expect(commandReferencesSensitivePath("cat .git/config")).toBe(true)
		expect(commandReferencesSensitivePath("grep foo .env")).toBe(true)
	})

	it("allows ordinary read-only commands", () => {
		expect(commandReferencesSensitivePath("cat ~/.zshrc")).toBe(false)
		expect(commandReferencesSensitivePath("git status")).toBe(false)
	})
})
