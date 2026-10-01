/**
 * memory/selection.ts — deterministic lexical per-turn injection
 * (P3-ME-04, DESIGN-MEMORY's borrowed D2 selectForTurn).
 *
 * Zero LLM. Qualification is two-domain (spec 2026-10-01-memory-recall-fix
 * MR-04): a memory qualifies when EITHER
 *   primary:  ≥ MIN_TOKEN_OVERLAP distinct query tokens hit title+description, OR
 *   secondary: ≥1 primary hit AND ≥ SECONDARY_BODY_MIN body hits
 *             (tiered fallback — anchors topical relevance in the curated
 *             description line while still catching “description mentions the
 *             topic once, body elaborates”; body-only overlap NEVER qualifies).
 * Body hits otherwise act only as a same-score tiebreaker. Deterministic
 * ordering (primary desc, bodyHits desc, then title asc); same input → same
 * selection. Budgets are byte-denominated; pre-paid files (already charged
 * this session) don't consume remaining budget again (MR-05).
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

/** Primary qualification: query tokens hitting title+description. */
export const MIN_TOKEN_OVERLAP = 2;
/** Secondary qualification: with ≥1 primary hit, this many body hits also
 * qualifies. ≥2 not ≥4: a 3-bigram query (e.g. 「发版流程」) can hit the body
 * at most 3 times — a ≥4 gate would dead-letter the anchor case outright. */
export const SECONDARY_BODY_MIN = 2;

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
	/** MR-05: files already charged this session — selectable (projection is
	 * never suppressed) but they don't consume remaining budget again. */
	isPrePaid?: (mem: SelectableMemory) => boolean,
): SelectionResult {
	const queryTokens = tokenize(prompt);
	if (queryTokens.size === 0) {
		return { files: [], remainingSessionBytes: budget.sessionBytes - sessionBytesUsed };
	}
	// NOTE: no exhausted-budget early return here — at remaining ≤ 0 unpaid
	// files still break out of the loop below (bytes > remaining), while
	// pre-paid files remain selectable (v3.2, review F4: the early exit
	// blinded exactly the files calibration ③ was meant to rescue).

	const scored: Array<{ mem: SelectableMemory; primary: number; bodyHits: number }> = [];
	for (const mem of memories) {
		// two-domain scoring (MR-04): primary = curated title+description line,
		// body counts only for the tiered fallback + same-score tiebreak
		const primaryTokens = tokenize(`${mem.title} ${mem.description}`);
		const bodyTokens = tokenize(mem.body);
		let primary = 0;
		let bodyHits = 0;
		for (const token of queryTokens) {
			if (primaryTokens.has(token)) primary++;
			if (bodyTokens.has(token)) bodyHits++;
		}
		const qualifies =
			primary >= MIN_TOKEN_OVERLAP ||
			(primary >= 1 && bodyHits >= SECONDARY_BODY_MIN);
		if (qualifies) scored.push({ mem, primary, bodyHits });
	}

	scored.sort((a, b) =>
		a.primary !== b.primary ? b.primary - a.primary
			: a.bodyHits !== b.bodyHits ? b.bodyHits - a.bodyHits
				: a.mem.title < b.mem.title ? -1 : 1);

	let remaining = budget.sessionBytes - sessionBytesUsed;
	const files: SelectableMemory[] = [];
	for (const { mem } of scored) {
		if (files.length >= budget.maxFiles) break;
		const bytes = byteLength(mem.body);
		if (bytes > budget.perFileBytes) continue; // oversized: skip, never truncate silently
		const prePaid = isPrePaid?.(mem) === true;
		if (!prePaid) {
			if (bytes > remaining) break;
			remaining -= bytes;
		}
		files.push(mem);
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
