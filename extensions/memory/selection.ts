/**
 * memory/selection.ts — deterministic lexical per-turn injection
 * (P3-ME-04, DESIGN-MEMORY's borrowed D2 selectForTurn).
 *
 * Zero LLM: strong token overlap between the current user prompt and a
 * memory file's (title + description + body tokens) is required before a
 * file is injected. Deterministic ordering (score desc, then title asc);
 * same input → same selection.
 */

import type { MemoryEntry } from "./memdir.js";

export interface SelectableMemory extends MemoryEntry {
	body: string;
	mtimeMs: number;
}

export interface SelectionBudget {
	/** Max files per turn (5). */
	maxFiles: number;
	/** Max bytes per file (4KB). */
	perFileBytes: number;
	/** Session-lifetime injection budget (60KB). */
	sessionBytes: number;
}

export const DEFAULT_SELECTION: SelectionBudget = {
	maxFiles: 5,
	perFileBytes: 4 * 1024,
	sessionBytes: 60 * 1024,
};

/** Overlap threshold: at least this many distinct query tokens must hit. */
export const MIN_TOKEN_OVERLAP = 2;

const STOPWORDS = new Set([
	"the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "with", "is",
	"are", "be", "this", "that", "it", "as", "at", "by", "from", "was", "were",
	"how", "what", "when", "which", "who", "why", "do", "does", "did", "can",
	"not", "but", "use", "using", "into", "about", "我", "的", "了", "是", "在",
]);

export function tokenize(text: string): Set<string> {
	const out = new Set<string>();
	for (const raw of text.toLowerCase().split(/[^a-z0-9\x80-\xff\u4e00-\u9fa5]+/)) {
		const token = raw.trim();
		if (token.length < 2 || STOPWORDS.has(token)) continue;
		out.add(token);
	}
	return out;
}

export interface SelectionResult {
	files: SelectableMemory[];
	/** Remaining session budget after this selection. */
	remainingSessionBytes: number;
}

/**
 * Select memories for this turn. Deterministic: score = distinct query
 * tokens present in the memory's tokens; ties break by title.
 */
export function selectForTurn(
	prompt: string,
	memories: SelectableMemory[],
	sessionBytesUsed: number,
	budget: SelectionBudget = DEFAULT_SELECTION,
): SelectionResult {
	const queryTokens = tokenize(prompt);
	if (queryTokens.size === 0 || sessionBytesUsed >= budget.sessionBytes) {
		return { files: [], remainingSessionBytes: budget.sessionBytes - sessionBytesUsed };
	}

	const scored: Array<{ mem: SelectableMemory; score: number }> = [];
	for (const mem of memories) {
		const memTokens = tokenize(`${mem.title} ${mem.description} ${mem.body}`);
		let score = 0;
		for (const token of queryTokens) {
			if (memTokens.has(token)) score++;
		}
		if (score >= MIN_TOKEN_OVERLAP) scored.push({ mem, score });
	}

	scored.sort((a, b) => (a.score !== b.score ? b.score - a.score : a.mem.title < b.mem.title ? -1 : 1));

	let remaining = budget.sessionBytes - sessionBytesUsed;
	const files: SelectableMemory[] = [];
	for (const { mem } of scored) {
		if (files.length >= budget.maxFiles) break;
		if (mem.body.length > budget.perFileBytes) continue; // oversized: skip, never truncate silently
		if (mem.body.length > remaining) break;
		files.push(mem);
		remaining -= mem.body.length;
	}
	return { files, remainingSessionBytes: remaining };
}

/** Freshness header: memories older than a day get a verify hint. */
export function freshnessHeader(mtimeMs: number, now = Date.now()): string | null {
	if (now - mtimeMs <= 24 * 60 * 60 * 1000) return null;
	return "[older than a day — verify before relying on it]";
}
