/**
 * memory/paths.ts — disk location resolution (P3-ME-01).
 *
 * Memory dir: `~/.pi/agent/projects/<sanitized-git-root>/memory/`
 * The sanitizer matches pi's own sessions directory naming (`/` → `-`),
 * and the root is the git CANONICAL root so linked worktrees share memory.
 */

import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Sanitize a path exactly like pi's sessions directory naming. */
export function sanitizePath(p: string): string {
	return p.replace(/[/\\]/g, "-").replace(/^-/, "-");
}

/** git rev-parse --git-common-directory; null outside a work tree. */
export function gitCanonicalRoot(cwd: string): string | null {
	try {
		const out = execSync("git rev-parse --git-common-directory", {
			cwd,
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "pipe"],
		}).trim();
		if (!out) return null;
		const resolved = out === ".git" ? cwd : (out.match(/^(.*)\/\.git$/) ?? [])[1];
		if (resolved && existsSync(resolved)) return resolved;
		// bare-ish or unusual output — treat the printed dir's parent as root
		return resolved ?? null;
	} catch {
		return null;
	}
}

export interface MemoryPaths {
	/** <home>/.pi/agent */
	agentDir: string;
	/** .../projects/<sanitized>/ */
	projectsDir: string;
	/** .../projects/<sanitized>/memory */
	memoryDir: string;
	/** the memory index file */
	indexFile: string;
}

export function resolveMemoryPaths(cwd: string, home = process.env.HOME ?? homedir()): MemoryPaths {
	const agentDir = join(home, ".pi", "agent");
	const root = gitCanonicalRoot(cwd) ?? cwd;
	const projectsDir = join(agentDir, "projects", sanitizePath(root));
	const memoryDir = join(projectsDir, "memory");
	return { agentDir, projectsDir, memoryDir, indexFile: join(memoryDir, "MEMORY.md") };
}

/** The sessions dir for a cwd (session_recall scans here; shared sanitizer). */
export function sessionsDirFor(cwd: string, home = homedir()): string {
	return join(home, ".pi", "agent", "sessions", sanitizePath(cwd));
}
