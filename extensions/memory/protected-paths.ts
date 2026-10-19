/**
 * memory/protected-paths.ts — [C4] self-modification protection, pure path
 * matcher (docs/zh/entropy-control-spec.md, Goal 1 [C4]).
 *
 * The protected list below is HARDCODED on purpose: config the agent can
 * write cannot be the source of its own boundary. A data-driven list (e.g.
 * a "protected paths" setting file) would let the guarded writer rewrite its
 * own guard, so the boundary must live in code that only a human change can
 * move. Wiring this into the tool_call guard handler is the main thread's
 * job (guard.ts / index.ts); this file stays pure — no fs, no process, no
 * env — so it can be unit-tested with injected home/cwd alone.
 */

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

/** One protected boundary. `dir: true` protects the whole subtree. */
interface ProtectedEntry {
	kind: string;
	path: string;
	dir: boolean;
}

/** The frozen list (order per spec [C4]; see header for why it is code). */
function protectedEntries(opts: ProtectedPathsInput): ProtectedEntry[] {
	return [
		// modes frozen permissions config — extensions/modes/config.ts:58
		{ kind: "modes-permissions-file", path: join(opts.home, ".pi", "agent", "permission-modes.json"), dir: false },
		// global rules dir — extensions/rules/index.ts:62
		{ kind: "global-rules-dir", path: join(opts.home, ".pi", "agent", "rules"), dir: true },
		// project rules dir — extensions/rules/index.ts:64
		{ kind: "project-rules-dir", path: join(opts.cwd, ".pi", "rules"), dir: true },
		// compat rules dir — extensions/rules/index.ts:63
		{ kind: "compat-rules-dir", path: join(opts.cwd, ".claude", "rules"), dir: true },
		// host settings — written by extensions/memory/automation.ts:93,
		// read by extensions/modes/profiles.ts:134
		{ kind: "host-settings-file", path: join(opts.home, ".pi", "agent", "settings.json"), dir: false },
	];
}

/**
 * [C5] The concrete protected FILES to baseline: the two single-file entries
 * plus every file currently inside the three rule directories. Missing
 * files are simply absent from the list (no baseline for what does not
 * exist yet).
 */
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
			/* dir absent — nothing to baseline */
		}
	}
	return files;
}

/**
 * Match an absolute write/edit target against the protected list. Returns
 * the hit's kind plus the protected boundary that matched (the directory
 * itself for dir entries), or null when the target is not protected.
 *
 * `absPath` is ASSUMED to already be absolute — callers resolve relative
 * tool paths first. A relative input simply matches nothing (pinned by
 * tests) instead of being silently resolved against the wrong base.
 *
 * Directory entries are separator-aware via lib/rule-text.ts isInsideDir:
 * the dir itself and its subtree match, sibling prefixes
 * (`rules-evil/`, `permission-modes.json.bak`) do not.
 */
export function matchProtectedPath(absPath: string, opts: ProtectedPathsInput): ProtectedPathMatch | null {
	for (const entry of protectedEntries(opts)) {
		const hit = entry.dir ? isInsideDir(absPath, entry.path) : absPath === entry.path;
		if (hit) return { kind: entry.kind, path: entry.path };
	}
	return null;
}

/** English block copy for the tool_call guard (spec [C4] wording). */
export function protectedPathBlockReason(match: { kind: string; path: string }): string {
	return (
		`blocked: ${match.path} is a protected ${match.kind} — an agent self-modification boundary file ` +
		`(entropy control [C4]). If this change is intentional, edit the file manually with your editor ` +
		`instead of using write/edit tools. bypassPermissions mode does not exempt this guard.`
	);
}
