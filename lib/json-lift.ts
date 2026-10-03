/**
 * lib/json-lift.ts — lift JSON objects out of model text (arch review C4,
 * 2026-10-03). ONE string-aware implementation replacing four drifted copies:
 * modes/classifier-client.ts (the strongest), memory/llm.ts, memory/selector.ts
 * (was NOT string-aware — a `}` inside a string value broke the span) and
 * review/src/report-tool.ts (was a bare indexOf/lastIndexOf lift).
 *
 * Interface:
 *   jsonCandidates(text)  — best-first candidate texts, deduped, raw (no
 *                           repair applied; callers that iterate themselves
 *                           decide per candidate).
 *   liftJson(text, map)   — per candidate: JSON.parse the raw text, then the
 *                           repaired variant (BOM strip + trailing-comma
 *                           fix, default ON — modes already repaired, the
 *                           other three consumers are upgraded to it); the
 *                           first parse whose mapped value is non-null wins.
 *                           `map` returning null = "not this candidate, keep
 *                           scanning" — payload validation stays with the
 *                           consumer, extraction lives here.
 *
 * Canonical candidate order (ONE order for all consumers; the old copies
 * disagreed — llm preferred trailing fences, review preferred the last
 * well-shaped fence, classifier scanned document order):
 *   1. fenced ```json blocks, document-LAST first (the answer trails any
 *      preamble — llm's proven rationale; also matches review's "verdict
 *      block comes at the end")
 *   2. the whole trimmed text
 *   3. string/escape-aware balanced {...} spans in document order — every
 *      `{` start opens a span (outer before inner), so inner-shape payloads
 *      still hit after their parent fails validation
 *   4. outermost { … } slice (indexOf/lastIndexOf) as the last resort
 *
 * Pure text layer only — no fs, no pi imports (invariant: lib never imports
 * extensions).
 */

/** Candidate texts, best-first (see header for the canonical order). */
export function jsonCandidates(text: string): string[] {
	const trimmed = text.trim();
	const out: string[] = [];
	const fenced = [...trimmed.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map((m) => m[1]!.trim());
	for (let i = fenced.length - 1; i >= 0; i--) out.push(fenced[i]!);
	out.push(trimmed);
	out.push(...balancedObjectSpans(trimmed));
	const start = trimmed.indexOf("{");
	const end = trimmed.lastIndexOf("}");
	if (start !== -1 && end > start) out.push(trimmed.slice(start, end + 1));
	return [...new Set(out)];
}

/**
 * Parse the first candidate whose mapped value is non-null. `map` is the
 * consumer's payload validation (return null to reject a candidate);
 * `repair` (default true) additionally retries each candidate with BOM
 * stripped and trailing commas before `}`/`]` removed — a plain parse is
 * always attempted first so repair can never corrupt an already-valid text.
 */
export function liftJson<T>(
	text: string,
	map: (value: unknown) => T | null,
	opts: { repair?: boolean } = {},
): T | null {
	const repairOn = opts.repair !== false;
	for (const candidate of jsonCandidates(text)) {
		for (const variant of repairOn ? [candidate, repairJsonCandidate(candidate)] : [candidate]) {
			try {
				const parsed: unknown = JSON.parse(variant);
				const mapped = map(parsed);
				if (mapped !== null && mapped !== undefined) return mapped;
			} catch {
				/* keep scanning */
			}
		}
	}
	return null;
}

/** BOM strip + trailing-comma repair (the old classifier variant). */
export function repairJsonCandidate(raw: string): string {
	return raw.replace(/^\uFEFF/, "").replace(/,\s*([}\]])/g, "$1");
}

/**
 * String- and escape-aware balanced {...} spans, in document order (every
 * `{` start opens a span; outer before inner). The shared fix for the old
 * selector copy, whose depth counter did not track string state.
 */
export function balancedObjectSpans(text: string): string[] {
	const results: string[] = [];
	for (let i = 0; i < text.length; i++) {
		if (text[i] !== "{") continue;
		let depth = 0;
		let inString = false;
		let escaped = false;
		for (let j = i; j < text.length; j++) {
			const ch = text[j]!;
			if (inString) {
				if (escaped) escaped = false;
				else if (ch === "\\") escaped = true;
				else if (ch === '"') inString = false;
				continue;
			}
			if (ch === '"') {
				inString = true;
				continue;
			}
			if (ch === "{") depth++;
			else if (ch === "}") {
				depth--;
				if (depth === 0) {
					results.push(text.slice(i, j + 1));
					break;
				}
			}
		}
	}
	return results;
}
