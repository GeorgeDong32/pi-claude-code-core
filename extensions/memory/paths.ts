/**
 * memory/paths.ts — disk location resolution (P3-ME-01, V2-M1 user layer).
 *
 * Project memory dir: `~/.pi/agent/projects/<sanitized-git-root>/memory/`
 * The sanitizer matches pi's own sessions directory naming (`/` → `-`),
 * and the root is the git CANONICAL root so linked worktrees share memory.
 * User memory dir (V2-D1): `~/.pi/agent/memory/` — cross-project facts and
 * preferences, same per-file format and reconciler as the project layer.
 */

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
	// G1-C3 (entropy control): `--git-common-directory` turned out NEVER to
	// work on this machine's git (2.56 echoes the arg back instead of the
	// path, silently degrading gitCanonicalRoot to a constant null — hidden
	// because pi usually starts at the repo root, where the cwd fallback
	// coincides). `--show-toplevel` is the universally supported form and
	// returns the worktree root directly; the old form stays as a fallback.
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
	return [p.memoryDir, p.userMemoryDir];
}

/**
 * True when a write/edit path targets either memory layer. Shared by the
 * modes carve-out and the secret guard so the two can never drift.
 *
 * B8 (cherry-batch2): the carve-out is an ALLOWANCE (it skips the approval
 * dialog), so a purely lexical match would let a symlink alias physically
 * pointing OUTSIDE a write root ride the carve-out (fail-open escape — the
 * audit's headline). The second pass realpath-resolves the write path and
 * requires it to stay inside a RESOLVED write root; unresolvable or escaped
 * paths return false and fall back to the normal approval path
 * (fail-closed). Consumers in the stricter direction (guard layer checks)
 * keep using the lexical helpers directly.
 *
 * Known window (accepted, same class as the pre-B8 lexical check): the
 * realpath verdict is check-then-use — the link can be swapped between
 * this check and the actual write. This tightens the alias escape; it is
 * not a sandbox guarantee (convenience, not containment).
 */
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

/** The sessions dir for a cwd (session_recall scans here; shared sanitizer).
 * C8/R2-P1 fix (2026-10-03): pi names the sessions dir with WRAPPING
 * dashes — `-${sanitizePath(cwd)}-` (verified against the live
 * ~/.pi/agent/sessions layout; the projects layer is the bare-sanitized
 * one). The old bare form pointed at a directory pi never writes, so
 * session_recall always returned empty on a real machine. */
export function sessionsDirFor(cwd: string, home = homedir()): string {
	return join(home, ".pi", "agent", "sessions", `-${sanitizePath(cwd)}-`);
}
