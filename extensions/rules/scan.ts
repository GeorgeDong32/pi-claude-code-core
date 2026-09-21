/**
 * rules/scan.ts — pure file parsing for the rules engine (P3-RU-02/03/05).
 *
 * No I/O here: callers hand in file contents, the functions return parsed
 * structures or `null` for "invalid, skip silently". Everything is
 * deterministic so renderRules stays byte-stable for identical input.
 */

export interface RuleFrontmatter {
	name?: string;
	description?: string;
	globs?: string[];
	always?: boolean;
}

export interface ParsedRuleFile {
	frontmatter: RuleFrontmatter | null;
	/** Body after the frontmatter block (or the whole file when none). */
	body: string;
	/** True when a frontmatter block existed but was invalid → skip file. */
	invalid: boolean;
}

const KNOWN_KEYS = new Set(["name", "description", "globs", "always"]);

/**
 * Split a markdown file into frontmatter + body. Files without a leading
 * `---` block are plain always-rules (frontmatter null, invalid false).
 * A block that exists but fails validation is invalid → skip.
 */
export function parseFrontmatter(content: string): ParsedRuleFile {
	if (!content.startsWith("---")) {
		return { frontmatter: null, body: content, invalid: false };
	}
	const lines = content.split("\n");
	// find the closing fence
	let closeIdx = -1;
	for (let i = 1; i < lines.length; i++) {
		if (lines[i].trim() === "---") {
			closeIdx = i;
			break;
		}
	}
	if (closeIdx === -1) {
		return { frontmatter: null, body: content, invalid: true };
	}

	const fm: RuleFrontmatter = {};
	let sawKnownKey = false;
	for (let i = 1; i < closeIdx; i++) {
		const line = lines[i];
		const trimmed = line.trim();
		if (trimmed === "" || trimmed.startsWith("#")) continue;
		const match = /^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/.exec(trimmed);
		if (!match) return { frontmatter: null, body: content, invalid: true };
		const key = match[1];
		const value = match[2].trim();
		if (!KNOWN_KEYS.has(key)) {
			// unknown keys are tolerated but must still be scalars (validated
			// by the regex above); they don't drive behavior
			continue;
		}
		sawKnownKey = true;
		if (key === "globs") {
			if (value.startsWith("[")) {
				// inline array: ["a", "b"] or ["a"," b "]
				if (!value.endsWith("]")) return { frontmatter: null, body: content, invalid: true };
				const inner = value.slice(1, -1);
				const items = inner.length === 0 ? [] : inner.split(",").map((s) => unquote(s.trim()));
				if (items.some((s) => s.length === 0)) return { frontmatter: null, body: content, invalid: true };
				fm.globs = items;
			} else if (value.length === 0) {
				// block list: "- pattern" lines until a non-list line
				const items: string[] = [];
				let j = i + 1;
				for (; j < closeIdx; j++) {
					const l = lines[j].trim();
					if (l.startsWith("- ")) items.push(unquote(l.slice(2).trim()));
					else break;
				}
				if (items.length === 0) return { frontmatter: null, body: content, invalid: true };
				i = j - 1;
				fm.globs = items;
			} else {
				fm.globs = [unquote(value)];
			}
		} else if (key === "always") {
			if (value !== "true" && value !== "false") {
				return { frontmatter: null, body: content, invalid: true };
			}
			fm.always = value === "true";
		} else {
			const text = unquote(value);
			if (!text) return { frontmatter: null, body: content, invalid: true };
			fm[key as "name" | "description"] = text;
		}
	}

	if (!sawKnownKey) {
		// a frontmatter block with none of our keys is malformed for our
		// purposes; treat as invalid (counted in the skip note)
		return { frontmatter: null, body: content, invalid: true };
	}
	const body = lines.slice(closeIdx + 1).join("\n");
	return { frontmatter: fm, body, invalid: false };
}

function unquote(s: string): string {
	if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
		return s.slice(1, -1);
	}
	return s;
}

/** The four @include forms: `@./rel` `@~/` `@/abs` and bare `@path`. */
export interface IncludeRef {
	/** Raw token as written (without surrounding whitespace). */
	raw: string;
	/** Path after the `@`. */
	target: string;
	kind: "relative-file" | "relative-dir" | "home" | "absolute";
}

/** Extract @include tokens from a rule body, in order, deduplicated. */
export function extractIncludes(body: string): IncludeRef[] {
	const out: IncludeRef[] = [];
	const seen = new Set<string>();
	const re = /@(\/[^\s]+|~\/[^\s]+|\.[^\s]+|[^\s@]+)/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(body)) !== null) {
		const raw = m[0];
		const target = raw.slice(1);
		if (seen.has(target)) continue;
		seen.add(target);
		let kind: IncludeRef["kind"];
		if (target.startsWith("./")) kind = "relative-file";
		else if (target.startsWith("~/")) kind = "home";
		else if (target.startsWith("/")) kind = "absolute";
		else kind = "relative-dir";
		out.push({ raw, target, kind });
	}
	return out;
}

export const INCLUDE_DEPTH_LIMIT = 5;
