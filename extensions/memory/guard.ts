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

// os.homedir() reads the process-level env (C getenv), not the JS process.env copy worker threads see — read $HOME at the JS layer.
export function sessionHome(): string {
	return process.env.HOME !== undefined && process.env.HOME !== "" ? process.env.HOME : homedir();
}

export interface MemoryGuardEnv {
	projectDir: string;
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
