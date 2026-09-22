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
	return p.replace(/[/\\]/g, "-");
}

/** git rev-parse --git-common-directory; null outside a work tree.
 * Result is memoized per cwd — the canonical root of a working directory
 * effectively never changes mid-process, and the sync subprocess ran on
 * every memoryDir() call (several times per turn) before this cache. */
const gitRootCache = new Map<string, string | null>();

export function gitCanonicalRoot(cwd: string): string | null {
	const cached = gitRootCache.get(cwd);
	if (cached !== undefined) return cached;
	const root = gitCanonicalRootUncached(cwd);
	gitRootCache.set(cwd, root);
	return root;
}

function gitCanonicalRootUncached(cwd: string): string | null {
	try {
		const out = execSync("git rev-parse --git-common-directory", {
			cwd,
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "pipe"],
		}).trim();
		if (!out) return null;
		const resolved = out === ".git" ? cwd : (out.match(/^(.*)\/\.git$/) ?? [])[1];
		return resolved && existsSync(resolved) ? resolved : null;
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
