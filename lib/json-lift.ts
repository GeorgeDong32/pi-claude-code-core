/**
 * lib/json-lift.ts — lift JSON objects out of model text (arch review C4,
 * 2026-10-03; AR1005-JS 2026-10-05). ONE string-aware implementation replacing
 * four drifted copies: modes/classifier-client.ts (the strongest),
 * memory/llm.ts, memory/selector.ts (was NOT string-aware — a `}` inside a
 * string value broke the span) and review/src/report-tool.ts (was a bare
 * indexOf/lastIndexOf lift).
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
 * AR1005-JS-02: candidates are produced by a private lazy generator shared
 * by jsonCandidates (collects) and liftJson (iterates). Generating stops at
 * the first accepted candidate, so when stage 1 or 2 wins, the stage-3 span
 * scan never runs — the old code paid the (potentially quadratic) span scan
 * even for inputs whose fenced block or whole text already parsed. Scanning
 * fences to determine their order is fine; balanced spans must not be
 * expanded early. AR1005-JS-03 deliberately keeps balancedObjectSpans's
 * restoration rules: inputs that still NEED the span fallback keep their
 * quadratic worst case (disclosed in DEVIATIONS, not fixed here).
 *
 * AR1005-JS-01: repair is a character-state scan (tracks double-quoted
 * strings and backslash escapes), so a real trailing comma authorizes the
 * removal of that comma — and ONLY that comma. The old regex
 * /,\s*([}\]])/ did not recognize strings and rewrote string bodies
 * ("literal ,} sequence" became "literal } sequence") whenever the document
 * also had a genuine trailing comma. Everything else — escapes, unicode,
 * commas followed by non-closers — passes through byte-identical.
 *
 * Pure text layer only — no fs, no pi imports (invariant: lib never imports
 * extensions).
 */

function* iterateCandidates(trimmed: string): Generator<string> {
	const seen = new Set<string>();
	const fenced = [...trimmed.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map((m) => m[1]!.trim());
	for (let i = fenced.length - 1; i >= 0; i--) {
		const f = fenced[i]!;
		if (!seen.has(f)) {
			seen.add(f);
			yield f;
		}
	}
	if (!seen.has(trimmed)) {
		seen.add(trimmed);
		yield trimmed;
	}
	spanScanCount++;
	for (const span of balancedObjectSpans(trimmed)) {
		if (!seen.has(span)) {
			seen.add(span);
			yield span;
		}
	}
	const start = trimmed.indexOf("{");
	const end = trimmed.lastIndexOf("}");
	if (start !== -1 && end > start) {
		const slice = trimmed.slice(start, end + 1);
		if (!seen.has(slice)) yield slice;
	}
}

export function jsonCandidates(text: string): string[] {
	return [...iterateCandidates(text.trim())];
}

/**
 * Parse the first candidate whose mapped value is non-null. `map` is the
 * consumer's payload validation (return null to reject a candidate);
 * `repair` (default true) additionally retries each candidate with BOM
 * stripped and trailing commas before `}`/`]` removed — a plain parse is
 * always attempted first so repair can never corrupt an already-valid text.
 * Iterates the lazy generator directly: the first accepted candidate ends
 * generation (AR1005-JS-02).
 */
export function liftJson<T>(
	text: string,
	map: (value: unknown) => T | null,
	opts: { repair?: boolean } = {},
): T | null {
	const repairOn = opts.repair !== false;
	for (const candidate of iterateCandidates(text.trim())) {
		for (const variant of repairOn ? [candidate, repairJsonCandidate(candidate)] : [candidate]) {
			try {
				const parsed: unknown = JSON.parse(variant);
				const mapped = map(parsed);
				if (mapped !== null && mapped !== undefined) return mapped;
			} catch {
			}
		}
	}
	return null;
}

let spanScanCount = 0;
export function _spanScanCountForTests(): number {
	return spanScanCount;
}
export function _resetSpanScanCountForTests(): void {
	spanScanCount = 0;
}

export function repairJsonCandidate(raw: string): string {
	let s = raw.replace(/^\uFEFF/, "");
	let out = "";
	let inString = false;
	let escaped = false;
	for (let i = 0; i < s.length; i++) {
		const ch = s[i]!;
		if (inString) {
			if (escaped) escaped = false;
			else if (ch === "\\") escaped = true;
			else if (ch === '"') inString = false;
			out += ch;
			continue;
		}
		if (ch === '"') {
			inString = true;
			out += ch;
			continue;
		}
		if (ch === ",") {
			let j = i + 1;
			while (j < s.length && (s[j] === " " || s[j] === "\t" || s[j] === "\n" || s[j] === "\r")) j++;
			if (j < s.length && (s[j] === "}" || s[j] === "]")) {
				i = j - 1;
				continue;
			}
		}
		out += ch;
	}
	return out;
}

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
