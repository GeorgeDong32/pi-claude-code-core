/**
 * lib/glob.ts — the one glob engine (**, *, ?, {a,b}, plain substrings).
 *
 * Uprooted verbatim from extensions/rules/render.ts (R3, RV-14): the
 * user-memory `paths:` scoping needs the same matching semantics as rule
 * activation globs, and two engines would drift. rules/render.ts now
 * re-exports from here — dependency direction lib ← extensions holds.
 */

/** Glob → RegExp: `**` crosses directory separators, `*` and `?` do not,
 * `{a,b}` alternates, anything else is a literal (anchored to path
 * segments).
 *
 * quickwin-2 (arch review 2026-10-03): compiled once per glob — the rules
 * tool_call hot path re-compiled every glob × every path. Pattern sets come
 * from rule files (a handful per file), so the cache is bounded by config
 * surface, not session traffic; a plain Map with no eviction is deliberate. */
const globRegExpCache = new Map<string, RegExp>();

export function globToRegExp(glob: string): RegExp {
	const cached = globRegExpCache.get(glob);
	if (cached) return cached;
	const compiled = compileGlob(glob);
	globRegExpCache.set(glob, compiled);
	return compiled;
}

function compileGlob(glob: string): RegExp {
	let re = "";
	for (let i = 0; i < glob.length; i++) {
		const c = glob[i];
		if (c === "*") {
			if (glob[i + 1] === "*") {
				re += ".*";
				i++;
				if (glob[i + 1] === "/") i++;
			} else {
				re += "[^/]*";
			}
		} else if (c === "?") re += "[^/]";
		else if (c === "{") {
			re += "(?:";
			// consume to matching }
			let depth = 1;
			let j = i + 1;
			let buf = "";
			for (; j < glob.length && depth > 0; j++) {
				const d = glob[j];
				if (d === "{") depth++;
				else if (d === "}") {
					depth--;
					if (depth === 0) break;
				} else if (d === "," && depth === 1) {
					re += buf + "|";
					buf = "";
				} else buf += escapeRe(d);
			}
			re += buf + ")";
			i = j;
		} else re += escapeRe(c);
	}
	return new RegExp(`(?:^|/|\\\\)${re}(?:$|/|\\\\)`);
}

/** True when ANY of the globs matches the path. */
export function globMatches(path: string, globs: readonly string[]): boolean {
	for (const g of globs) {
		if (globToRegExp(g).test(path)) return true;
	}
	return false;
}

function escapeRe(c: string): string {
	return /[.*+?^${}()|[\]\\]/.test(c) ? `\\${c}` : c;
}
