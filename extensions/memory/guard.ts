/**
 * memory/guard.ts — the write guard (P3-ME-05, entropy-control G1).
 *
 * Memory writes are plain write/edit tool calls (the modes module provides
 * the approval carve-out, P3-PM-01); this tool_call interceptor blocks at
 * write time: secret-shaped content (P3-ME-05), index-unindexable results
 * (G1-C1), memory files written outside the layers (G1-C2), single-repo
 * facts misfiled into the USER layer (G1-C3), child-session writes
 * (G1-C6). The guard never edits content.
 *
 * guardMemoryToolCall is the top-level entry (both layers + cross-layer
 * context in one call); guardMemoryWrites below is the original per-layer
 * secret probe kept for its existing tests.
 */

export interface GuardVerdict {
	block: boolean;
	reason?: string;
	/** G1-C3: non-blocking, once-per-session advisory surfaced by the caller. */
	warn?: string;
}

import { readFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import { homedir } from "node:os";
import { isInsideDir } from "../../lib/rule-text.ts";
import { diagnoseFrontmatter, isMemoryFile, splitFrontmatter } from "./memdir.ts";

/**
 * The session's home dir. `os.homedir()` reads the PROCESS-level env (C
 * getenv), which worker-thread test runners do not sync with their JS-level
 * process.env copies — reading $HOME at the JS layer keeps HOME-injected
 * tests and any future env override working everywhere.
 */
export function sessionHome(): string {
	return process.env.HOME !== undefined && process.env.HOME !== "" ? process.env.HOME : homedir();
}

/** Everything the entropy-control checks need about the write's environment. */
export interface MemoryGuardEnv {
	projectDir: string;
	userDir: string;
	/** Current git worktree root, when the cwd has one (G1-C3 misfiling check). */
	gitRoot?: string;
	/** PI_SUBAGENT_CHILD=1 — child sessions relay facts to the parent (G1-C6). */
	childSession: boolean;
}

/**
 * G1-C1/C2/C3/C6 + the secret probe, over BOTH layers with cross-layer
 * context. Returns the first blocking verdict, or a warn-only verdict for
 * the C3 short-repo-name case.
 */
export function guardMemoryToolCall(
	toolName: string,
	input: Record<string, unknown>,
	env: MemoryGuardEnv,
): GuardVerdict {
	if (toolName !== "write" && toolName !== "edit") return { block: false };
	const path = typeof input.path === "string" ? input.path : "";
	if (!path) return { block: false };

	// B8 (cherry-batch2 audit): lexical here is the CONSERVATIVE direction —
	// inside means MORE checks; a symlink-shaped path reads as outside and
	// takes the stricter branch. Deliberately NOT realpath-upgraded.
	const inProject = isInsideDir(path, env.projectDir);
	const inUser = isInsideDir(path, env.userDir);
	const inMemory = inProject || inUser;

	// G1-C6: child sessions never write either layer — relay to the parent.
	if (env.childSession && inMemory) {
		return {
			block: true,
			reason:
				"memory write blocked: child sessions (PI_SUBAGENT_CHILD=1) must not write memory layers — relay durable facts to the parent agent in your final report instead",
		};
	}

	// The post-write content: write's content as-is; edit's simulated result.
	const resulting = resultingContent(toolName, input, path);

	// G1-C1: the index's own judgment, at write time. Only for files the
	// index would actually scan (isMemoryFile — MEMORY.md and dotfiles are
	// out of scope by design).
	if (inMemory && isMemoryFile(basename(path)) && resulting !== undefined) {
		const problem = diagnoseFrontmatter(resulting);
		if (problem !== null) {
			return {
				block: true,
				reason: `memory write blocked: ${basename(path)} would be UNINDEXABLE and never recalled — ${problem}. Fix the frontmatter, then write again.`,
			};
		}
	}

	// G1-C2: a memory-shaped file landing outside both layers (the 10-03
	// incident: repo-root memory/x.md, silently never indexed).
	if (!inMemory && looksLikeMemoryPath(path) && carriesMemoryFrontmatter(resulting)) {
		return {
			block: true,
			reason: `memory write blocked: ${path} looks like a memory file but lives outside the memory layers — it would never be indexed or recalled. Write it to ${env.userDir} (cross-project facts) or ${env.projectDir} (this repo's facts) instead.`,
		};
	}

	// G1-C3: single-repo facts misfiled into the USER layer.
	if (inUser && env.gitRoot !== undefined && resulting !== undefined) {
		const misfile = userLayerMisfileVerdict(resulting, env.gitRoot, env.userDir, env.projectDir);
		if (misfile !== undefined) return misfile;
	}

	// P3-ME-05 secret probe — now over the RESULTING content, which also
	// covers edit's edits[] (the old per-layer probe read edit fields that
	// pi's edit tool never sends).
	for (const text of collectTexts(toolName, input, resulting)) {
		const secret = findSecret(text);
		if (secret) {
			return { block: true, reason: `memory write blocked: looks like a ${secret}` };
		}
	}
	return { block: false };
}

/** The file's content after this tool call: write's content; edit's original + each edits[] replacement (each matched against the ORIGINAL, per pi's edit semantics). Unreadable → undefined. */
function resultingContent(toolName: string, input: Record<string, unknown>, path: string): string | undefined {
	if (toolName === "write") {
		return typeof input.content === "string" ? input.content : undefined;
	}
	const edits = input.edits;
	if (!Array.isArray(edits) || edits.length === 0) return undefined;
	let original: string;
	try {
		original = readFileSync(path, "utf8");
	} catch {
		return undefined; // edit itself will fail; nothing to guard
	}
	let result = original;
	for (const edit of edits) {
		if (typeof edit?.oldText !== "string" || typeof edit?.newText !== "string") continue;
		result = result.split(edit.oldText).join(edit.newText);
	}
	return result;
}

/** All text the secret probe should see: the resulting content plus the raw edit payloads. */
function collectTexts(toolName: string, input: Record<string, unknown>, resulting: string | undefined): string[] {
	const texts: string[] = [];
	if (resulting !== undefined) texts.push(resulting);
	if (toolName === "edit" && Array.isArray(input.edits)) {
		for (const edit of input.edits) {
			if (typeof edit?.newText === "string") texts.push(edit.newText);
		}
	}
	return texts;
}

/** G1-C2 shape test: a .md directly inside some `memory/` directory. */
function looksLikeMemoryPath(path: string): boolean {
	if (!path.endsWith(".md")) return false;
	return basename(dirname(path)) === "memory";
}

/** G1-C2: carries memory frontmatter in the loose sense — name: and description: lines near the top (the 10-03 file was a complete memory doc). */
function carriesMemoryFrontmatter(content: string | undefined): boolean {
	if (content === undefined || !content.startsWith("---")) return false;
	const head = content.slice(0, 2000);
	return /^name:\s*\S/m.test(head) && /^description:\s*\S/m.test(head);
}

/**
 * G1-C3: USER-layer entry that names THIS repo's absolute path (or its ~/
 * form) without a paths: scope. Block; a bare short repo name only warns
 * once (too easy to false-positive on prose).
 */
function userLayerMisfileVerdict(
	content: string,
	gitRoot: string,
	userDir: string,
	projectDir: string,
): GuardVerdict | undefined {
	const split = splitFrontmatter(content);
	if (split === null) return undefined; // unindexable shape is C1's business
	if (split.paths !== undefined && split.paths.length > 0) return undefined; // explicitly scoped — legal
	const home = sessionHome();
	const tildeForm = `~${gitRoot.slice(home.length)}`;
	const namesRoot = gitRoot.startsWith(home) && content.includes(tildeForm);
	if (!content.includes(gitRoot) && !namesRoot) {
		// Short repo name only → warn once, no block.
		const repoName = basename(gitRoot);
		if (new RegExp(`\\b${escapeRegExp(repoName)}\\b`).test(content)) {
			return {
				block: false,
				warn: `USER memory names "${repoName}" without a paths: scope — if this is a single-repo fact, move it to the PROJECT layer (${projectDir}) or add paths: ["~${gitRoot.slice(homedir().length)}/**"]`,
			};
		}
		return undefined;
	}
	return {
		block: true,
		reason: `USER memory misfiled: it embeds this repo's absolute path (${gitRoot}${namesRoot ? ` or ${tildeForm}` : ""}), so it is a single-repo fact — write it to the PROJECT layer (${projectDir}) instead, or add paths: ["${tildeForm}/**"] to scope this USER entry`,
	};
}

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Patterns strong enough to block on; deliberate over-blocking is fine. */
const SECRET_PATTERNS: Array<[RegExp, string]> = [
	[/\b(?:sk|pk)[-_:][A-Za-z0-9]{20,}\b/, "API key literal"],
	[/\bAKIA[0-9A-Z]{16}\b/, "AWS access key id"],
	[/\b(?:xox[bpars]-)[A-Za-z0-9-]{10,}\b/, "Slack token"],
	[/\bgh[pousr]_[A-Za-z0-9]{30,}\b/, "GitHub token"],
	[/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "private key block"],
	[/\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\./, "JWT"],
	[/(?:api[_-]?key|secret|token|password)\s*[:=]\s*["']?[A-Za-z0-9/_+=-]{16,}["']?/i, "key=value secret"],
];

/** Shared secret probe (guard + ops engine + memory_consolidate — one truth).
 * Returns the pattern label on a hit, null when clean. */
export function findSecret(text: string): string | null {
	for (const [pattern, label] of SECRET_PATTERNS) {
		if (pattern.test(text)) return label;
	}
	return null;
}

/** Inspect a write/edit targeting the memory dir; block on secret shapes. */
export function guardMemoryWrites(
	toolName: string,
	input: Record<string, unknown>,
	memoryDir: string,
): GuardVerdict {
	if (toolName !== "write" && toolName !== "edit") return { block: false };
	const path = typeof input.path === "string" ? input.path : "";
	// separator-aware boundary check shared with the modes carve-out
	// (review Standards #6: the bare startsWith here mis-flagged sibling
	// dirs like `memory-x`)
	if (!path || !isInsideDir(path, memoryDir)) return { block: false };

	const contents: string[] = [];
	const content = input.content ?? input.new_string;
	if (typeof content === "string") contents.push(content);
	if (typeof input.old_string === "string") contents.push(input.old_string);
	if (contents.length === 0) return { block: false };

	for (const text of contents) {
		const secret = findSecret(text);
		if (secret) {
			return { block: true, reason: `memory write blocked: looks like a ${secret}` };
		}
	}
	return { block: false };
}
