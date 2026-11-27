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
