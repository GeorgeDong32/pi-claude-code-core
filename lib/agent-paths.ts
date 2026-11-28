import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function sanitizePath(p: string): string {
	return p.replace(/[/\\]/g, "-");
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

export function agentDir(home = process.env.HOME ?? homedir()): string {
	return join(home, ".pi", "agent");
}

/** Project layer directory, keyed by the git root (falls back to cwd). */
export function projectsDirFor(cwd: string, home = process.env.HOME ?? homedir()): string {
	const root = gitCanonicalRoot(cwd) ?? cwd;
	return join(agentDir(home), "projects", sanitizePath(root));
}

/** Default notes directory: `<projects dir>/memory`. */
export function defaultNotesDir(cwd: string, home = process.env.HOME ?? homedir()): string {
	return join(projectsDirFor(cwd, home), "memory");
}

/** Sessions dir for a cwd; pi names it with WRAPPING dashes —
 * `-${sanitizePath(cwd)}-` (the projects layer is the bare-sanitized one). */
export function sessionsDirFor(cwd: string, home = homedir()): string {
	return join(home, ".pi", "agent", "sessions", `-${sanitizePath(cwd)}-`);
}
