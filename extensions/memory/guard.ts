/**
 * memory/guard.ts — the write guard (P3-ME-05, entropy-control G1).
 *
 * Memory writes are plain write/edit tool calls (the modes module provides
 * the approval carve-out, P3-PM-01); this tool_call interceptor blocks at
 * write time: writes to the RETIRED user memory layer (2026-11-24), secret-
 * shaped content (P3-ME-05), index-unindexable results (G1-C1), memory
 * files written outside the layer (G1-C2), child-session writes (G1-C6).
 * The guard never edits content.
 *
 * BH-R2 (spec 2026-11-14-backtest-hardening): the secret probe is scoped
 * to the memory layer again (the 1618f89 G1 rewrite probed every
 * write/edit path) and scans only the INCOMING text — write's content,
 * edit's edits[].newText — never the whole resulting file (a pre-existing
 * secret-looking line must not block a clean edit).
 *
 * guardMemoryToolCall is the top-level entry (project layer + retired-user
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
import { diagnoseFrontmatter, isMemoryFile } from "./memdir.ts";

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
	/** the retired cross-project user layer — writes there are rejected so
	 *  no new data lands in a store that is no longer injected or recalled */
	userDir: string;
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

	if (inUser) {
		return {
			block: true,
			reason: `memory write blocked: the cross-project USER memory layer is retired (2026-11-24) — its remaining files are being migrated out and are no longer injected or recalled. Write repository facts to the PROJECT layer (${env.projectDir}); cross-project knowledge belongs in the user's own notes.`,
		};
	}

	if (env.childSession && inProject) {
		return {
			block: true,
			reason:
				"memory write blocked: child sessions (PI_SUBAGENT_CHILD=1) must not write the memory layer — relay durable facts to the parent agent in your final report instead",
		};
	}

	const resulting = resultingContent(toolName, input, path);

	if (inProject && isMemoryFile(basename(path)) && resulting !== undefined) {
		const problem = diagnoseFrontmatter(resulting);
		if (problem !== null) {
			return {
				block: true,
				reason: `memory write blocked: ${basename(path)} would be UNINDEXABLE and never recalled — ${problem}. Fix the frontmatter, then write again.`,
			};
		}
	}

	if (!inProject && looksLikeMemoryPath(path) && carriesMemoryFrontmatter(resulting)) {
		return {
			block: true,
			reason: `memory write blocked: ${path} looks like a memory file but lives outside the memory layer — it would never be indexed or recalled. Write it to ${env.projectDir} (this repo's memory) instead.`,
		};
	}

	if (inProject) {
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
