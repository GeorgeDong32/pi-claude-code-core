
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { isInsideDir } from "../../lib/rule-text.ts";

export interface ProtectedPathsInput {
	home: string;
	cwd: string;
}

export interface ProtectedPathMatch {
	kind: string;
	path: string;
}

interface ProtectedEntry {
	kind: string;
	path: string;
	dir: boolean;
}

function protectedEntries(opts: ProtectedPathsInput): ProtectedEntry[] {
	return [
		{ kind: "modes-permissions-file", path: join(opts.home, ".pi", "agent", "permission-modes.json"), dir: false },
		{ kind: "global-rules-dir", path: join(opts.home, ".pi", "agent", "rules"), dir: true },
		{ kind: "project-rules-dir", path: join(opts.cwd, ".pi", "rules"), dir: true },
		{ kind: "compat-rules-dir", path: join(opts.cwd, ".claude", "rules"), dir: true },
		{ kind: "host-settings-file", path: join(opts.home, ".pi", "agent", "settings.json"), dir: false },
	];
}

export function protectedPathFiles(opts: ProtectedPathsInput): string[] {
	const files: string[] = [];
	for (const entry of protectedEntries(opts)) {
		if (!entry.dir) {
			if (existsSync(entry.path)) files.push(entry.path);
			continue;
		}
		try {
			for (const name of readdirSync(entry.path)) {
				const full = join(entry.path, name);
				if (statSync(full).isFile()) files.push(full);
			}
		} catch {
		}
	}
	return files;
}

export function matchProtectedPath(absPath: string, opts: ProtectedPathsInput): ProtectedPathMatch | null {
	for (const entry of protectedEntries(opts)) {
		const hit = entry.dir ? isInsideDir(absPath, entry.path) : absPath === entry.path;
		if (hit) return { kind: entry.kind, path: entry.path };
	}
	return null;
}

export function protectedPathBlockReason(match: { kind: string; path: string }): string {
	return (
		`blocked: ${match.path} is a protected ${match.kind} — an agent self-modification boundary file ` +
		`(entropy control [C4]). If this change is intentional, edit the file manually with your editor ` +
		`instead of using write/edit tools. bypassPermissions mode does not exempt this guard.`
	);
}
