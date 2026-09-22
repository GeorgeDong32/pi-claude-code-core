/**
 * memory/guard.ts — the write guard (P3-ME-05).
 *
 * Memory writes are plain write/edit tool calls (the modes module provides
 * the approval carve-out, P3-PM-01); this tool_call interceptor only blocks
 * secret-shaped content from being persisted into the memory dir. Format
 * mistakes are left to the reconciler — the guard never edits content.
 */

export interface GuardVerdict {
	block: boolean;
	reason?: string;
}

import { isInsideDir } from "../../lib/rule-text.js";

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
		for (const [pattern, label] of SECRET_PATTERNS) {
			if (pattern.test(text)) {
				return { block: true, reason: `memory write blocked: looks like a ${label}` };
			}
		}
	}
	return { block: false };
}
