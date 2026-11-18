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
 * BH-R2 (spec 2026-11-14-backtest-hardening): the secret probe is scoped
 * to the memory layers again (the 1618f89 G1 rewrite probed every
 * write/edit path) and scans only the INCOMING text — write's content,
 * edit's edits[].newText — never the whole resulting file (a pre-existing
 * secret-looking line must not block a clean edit).
 *
 * guardMemoryToolCall is the top-level entry (both layers + cross-layer
 * context in one call); guardMemoryWrites below is the original per-layer
 * secret probe kept for its existing tests.
 */

export interface GuardVerdict {
	block: boolean;
	reason?: string;
	warn?: string;
}

import { readFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import { homedir } from "node:os";
import { isInsideDir as isLexicallyInsideDir } from "../../lib/rule-text.ts";
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

export interface MemoryGuardEnv {
	projectDir: string;
	userDir: string;
	gitRoot?: string;
	childSession: boolean;
}

export function guardMemoryToolCall(
	toolName: string,
	input: Record<string, unknown>,
	env: MemoryGuardEnv,
): GuardVerdict {
	if (toolName !== "write" && toolName !== "edit") return { block: false };
	const path = typeof input.path === "string" ? input.path : "";
	if (!path) return { block: false };

	const inProject = isLexicallyInsideDir(path, env.projectDir);
	const inUser = isLexicallyInsideDir(path, env.userDir);
	const inMemory = inProject || inUser;

	if (env.childSession && inMemory) {
		return {
			block: true,
			reason:
				"memory write blocked: child sessions (PI_SUBAGENT_CHILD=1) must not write memory layers — relay durable facts to the parent agent in your final report instead",
		};
	}

	const resulting = resultingContent(toolName, input, path);

	if (inMemory && isMemoryFile(basename(path)) && resulting !== undefined) {
		const problem = diagnoseFrontmatter(resulting);
		if (problem !== null) {
			return {
				block: true,
				reason: `memory write blocked: ${basename(path)} would be UNINDEXABLE and never recalled — ${problem}. Fix the frontmatter, then write again.`,
			};
		}
	}

	if (!inMemory && looksLikeMemoryPath(path) && carriesMemoryFrontmatter(resulting)) {
		return {
			block: true,
			reason: `memory write blocked: ${path} looks like a memory file but lives outside the memory layers — it would never be indexed or recalled. Write it to ${env.userDir} (cross-project facts) or ${env.projectDir} (this repo's facts) instead.`,
		};
	}

	if (inUser && env.gitRoot !== undefined && resulting !== undefined) {
		const misfile = userLayerMisfileVerdict(resulting, env.gitRoot, env.userDir, env.projectDir);
		if (misfile !== undefined) return misfile;
	}

	if (inMemory) {
		for (const text of probeTexts(toolName, input)) {
			const secret = findSecret(text);
			if (secret) {
				return { block: true, reason: `memory write blocked: looks like a ${secret}` };
			}
		}
	}
	return { block: false };
}

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
		return undefined;
	}
	let result = original;
	for (const edit of edits) {
		if (typeof edit?.oldText !== "string" || typeof edit?.newText !== "string") continue;
		result = result.split(edit.oldText).join(edit.newText);
	}
	return result;
}

/** All text the secret probe sees (BH-R2): write → content; edit → each
 * edits[].newText. The whole-file resulting content is deliberately NOT
 * probed — pre-existing secret-looking text in a memory file must not
 * block a clean edit of it. */
function probeTexts(toolName: string, input: Record<string, unknown>): string[] {
	if (toolName === "write") {
		return typeof input.content === "string" ? [input.content] : [];
	}
	const texts: string[] = [];
	if (Array.isArray(input.edits)) {
		for (const edit of input.edits) {
			if (typeof edit?.newText === "string") texts.push(edit.newText);
		}
	}
	return texts;
}

function looksLikeMemoryPath(path: string): boolean {
	if (!path.endsWith(".md")) return false;
	return basename(dirname(path)) === "memory";
}

function carriesMemoryFrontmatter(content: string | undefined): boolean {
	if (content === undefined || !content.startsWith("---")) return false;
	const head = content.slice(0, 2000);
	return /^name:\s*\S/m.test(head) && /^description:\s*\S/m.test(head);
}

function userLayerMisfileVerdict(
	content: string,
	gitRoot: string,
	userDir: string,
	projectDir: string,
): GuardVerdict | undefined {
	const split = splitFrontmatter(content);
	if (split === null) return undefined;
	if (split.paths !== undefined && split.paths.length > 0) return undefined;
	const home = sessionHome();
	const tildeForm = `~${gitRoot.slice(home.length)}`;
	const namesRoot = gitRoot.startsWith(home) && content.includes(tildeForm);
	if (!content.includes(gitRoot) && !namesRoot) {
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

const SECRET_PATTERNS: Array<[RegExp, string]> = [
	[/\b(?:sk|pk)[-_:][A-Za-z0-9]{20,}\b/, "API key literal"],
	[/\bAKIA[0-9A-Z]{16}\b/, "AWS access key id"],
	[/\b(?:xox[bpars]-)[A-Za-z0-9-]{10,}\b/, "Slack token"],
	[/\bgh[pousr]_[A-Za-z0-9]{30,}\b/, "GitHub token"],
	[/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "private key block"],
	[/\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\./, "JWT"],
	[/(?:api[_-]?key|secret|token|password)\s*[:=]\s*["']?[A-Za-z0-9/_+=-]{16,}["']?/i, "key=value secret"],
];

export function findSecret(text: string): string | null {
	for (const [pattern, label] of SECRET_PATTERNS) {
		if (pattern.test(text)) return label;
	}
	return null;
}

export function guardMemoryWrites(
	toolName: string,
	input: Record<string, unknown>,
	memoryDir: string,
): GuardVerdict {
	if (toolName !== "write" && toolName !== "edit") return { block: false };
	const path = typeof input.path === "string" ? input.path : "";
	if (!path || !isLexicallyInsideDir(path, memoryDir)) return { block: false };

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
