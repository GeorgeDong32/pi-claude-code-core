/**
 * memory/selection.ts — deterministic lexical per-turn injection
 * (P3-ME-04, DESIGN-MEMORY's borrowed D2 selectForTurn).
 *
 * Zero LLM: strong token overlap between the current user prompt and a
 * memory file's (title + description + body tokens) is required before a
 * file is injected. Deterministic ordering (score desc, then title asc);
 * same input → same selection.
 */

import type { MemoryEntry } from "./memdir.ts";

export interface SelectableMemory extends MemoryEntry {
	body: string;
	mtimeMs: number;
	/** Which layer the file lives in (V2-D1); affects rendering only. */
	layer?: "user" | "project";
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
	"not", "but", "use", "using", "into", "about",
	// high-frequency function-word bigrams: two of these alone must NOT
	// satisfy MIN_TOKEN_OVERLAP (红队实测:「我们需要整理一个计划」误命中无关记忆)
	"我们", "一个", "这个", "那个", "他们", "她们", "什么", "怎么", "没有", "就是",
	"还是", "如果", "但是", "可以", "已经", "现在", "时候", "地方", "问题", "一下",
]);

/**
 * Tokenize for lexical recall. ASCII runs become words (as before); CJK runs
 * become BIGRAMS — a whole run as one token never matches differently-phrased
 * Chinese (the reason CJK recall was dead), and unigrams carry no signal.
 * Single-CJK-char tokens (the old dead stopwords) are simply never produced.
 */
export function tokenize(text: string): Set<string> {
	const out = new Set<string>();
	for (const segment of text.toLowerCase().split(/[^\u4e00-\u9fa5a-z0-9\x80-\xff]+/)) {
		const cjkRuns = segment.match(/[\u4e00-\u9fa5]+/g) ?? [];
		for (const run of cjkRuns) {
			for (let i = 0; i + 1 < run.length; i++) {
				const bigram = run.slice(i, i + 2);
				if (STOPWORDS.has(bigram)) continue;
				out.add(bigram);
			}
		}
		for (const raw of segment.replace(/[\u4e00-\u9fa5]+/g, " ").split(/[^a-z0-9\x80-\xff]+/)) {
			const token = raw.trim();
			if (token.length < 2 || STOPWORDS.has(token)) continue;
			out.add(token);
		}
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
		const bytes = byteLength(mem.body);
		if (bytes > budget.perFileBytes) continue; // oversized: skip, never truncate silently
		if (bytes > remaining) break;
		files.push(mem);
		remaining -= bytes;
	}
	return { files, remainingSessionBytes: remaining };
}

/** Budgets are byte-denominated everywhere (CJK .length undercounts ~3×). */
export function byteLength(text: string): number {
	return Buffer.byteLength(text, "utf8");
}

/** Freshness header (AD2, OPT-3): graded age in days — models handle
 * "47 days ago" far better than date arithmetic; only genuinely stale
 * memories carry the verify hint. */
export function freshnessHeader(mtimeMs: number, now = Date.now()): string | null {
	const ageDays = Math.floor((now - mtimeMs) / (24 * 60 * 60 * 1000));
	if (ageDays < 1) return null;
	if (ageDays <= 7) return `[${ageDays} day${ageDays === 1 ? "" : "s"} ago]`;
	return `[${ageDays} days ago — verify before relying on it]`;
}
