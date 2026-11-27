import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { lstatSync, realpathSync } from "node:fs";
import { dirname } from "node:path";
import { isInsideDir } from "../../lib/rule-text.ts";

export function sanitizePath(p: string): string {
	return p.replace(/[/\\]/g, "-");
}


export function fullProjectKey(dir: string): string {
	const parts = dir.replace(/\\/g, "/").replace(/\/memory$/, "").split("/");
	return parts[parts.length - 1] ?? "";
}

export function friendlyProjectHint(projectDir: string): string {
	const base = projectDir.replace(/\/memory$/, "").split("/").pop() ?? "";
	return base.replace(/^-+/, "").split("-").pop() ?? "";
}

const gitRootCache = new Map<string, string | null>();

export function gitCanonicalRoot(cwd: string): string | null {
	const cached = gitRootCache.get(cwd);
	if (cached !== undefined) return cached;
	const root = gitCanonicalRootUncached(cwd);
	gitRootCache.set(cwd, root);
	return root;
}

function gitCanonicalRootUncached(cwd: string): string | null {
	// This machine's git (2.56) echoes `--git-common-directory` back instead
	// of a path; `--show-toplevel` is the universally supported form and
	// returns the worktree root directly.
	try {
		const toplevel = execSync("git rev-parse --show-toplevel", {
			cwd,
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "pipe"],
		}).trim();
		if (toplevel && !toplevel.startsWith("--") && existsSync(toplevel)) return toplevel;
	} catch {
	}
	try {
		const out = execSync("git rev-parse --git-common-directory", {
			cwd,
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "pipe"],
		}).trim();
		if (!out || out.startsWith("--")) return null;
		const resolved = out === ".git" ? cwd : (out.match(/^(.*)\/\.git$/) ?? [])[1];
		return resolved && existsSync(resolved) ? resolved : null;
	} catch {
		return null;
	}
}

export interface MemoryPaths {
	agentDir: string;
	projectsDir: string;
	memoryDir: string;
	indexFile: string;
	userMemoryDir: string;
	userIndexFile: string;
}

export function resolveMemoryPaths(cwd: string, home = process.env.HOME ?? homedir()): MemoryPaths {
	const agentDir = join(home, ".pi", "agent");
	const root = gitCanonicalRoot(cwd) ?? cwd;
	const projectsDir = join(agentDir, "projects", sanitizePath(root));
	const memoryDir = join(projectsDir, "memory");
	const userMemoryDir = join(agentDir, "memory");
	return { agentDir, projectsDir, memoryDir, indexFile: join(memoryDir, "MEMORY.md"), userMemoryDir, userIndexFile: join(userMemoryDir, "MEMORY.md") };
}

export function memoryWriteRoots(cwd: string, home = process.env.HOME ?? homedir()): string[] {
	const p = resolveMemoryPaths(cwd, home);
	return [p.memoryDir];
}

export function isMemoryWritePath(path: string, cwd: string, home = process.env.HOME ?? homedir()): boolean {
	const roots = memoryWriteRoots(cwd, home);
	const lexical = roots.some((root) => isInsideDir(path, root));
	if (!lexical) return false;
	try {
		lstatSync(path);
		try {
			realpathSync(path);
		} catch {
			return false;
		}
	} catch {
	}
	try {
		const realPath = realpathOfNearestExisting(path);
		return roots.some((root) => {
			try {
				return isInsideDir(realPath, realpathOfNearestExisting(root));
			} catch {
				return false;
			}
		});
	} catch {
		return false;
	}
}

function realpathOfNearestExisting(p: string): string {
	let probe = p;
	for (;;) {
		try {
			return realpathSync(probe);
		} catch {
			const parent = dirname(probe);
			if (parent === probe) return probe;
			probe = parent;
		}
	}
}

/** Sessions dir for a cwd; pi names it with WRAPPING dashes —
 * `-${sanitizePath(cwd)}-` (the projects layer is the bare-sanitized one). */
export function sessionsDirFor(cwd: string, home = homedir()): string {
	return join(home, ".pi", "agent", "sessions", `-${sanitizePath(cwd)}-`);
}
