
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

export function globMatches(path: string, globs: readonly string[]): boolean {
	for (const g of globs) {
		if (globToRegExp(g).test(path)) return true;
	}
	return false;
}

function escapeRe(c: string): string {
	return /[.*+?^${}()|[\]\\]/.test(c) ? `\\${c}` : c;
}
