/**
 * rules/render.ts — the rules engine's pure core (DESIGN-RULES "D1 主测试面").
 *
 * renderRules is a total function: missing directories contribute nothing,
 * invalid files are skipped with a trailing count note, and identical input
 * yields byte-identical output (P3-RU-05).
 *
 * Rendering model (P3-RU-04):
 *   - `always` rules render inline (title + body) unless larger than
 *     inlineThresholdChars, then they degrade to an index row.
 *   - `globs` rules render as one index row each; rules whose globs match
 *     one of `touchedPaths` render inline (activation fold-in).
 *   - A single file whose expanded content exceeds budgetChars is dropped
 *     entirely (no index row either).
 *   - When the inline total overflows the budget, always-rules degrade to
 *     index rows (largest first) until it fits; the index itself is never
 *     truncated mid-content — rows are dropped whole from the tail.
 *
 * No filesystem access: callers pass a RuleFs adapter (real fs in wiring,
 * in-memory map in tests — one internal seam, two adapters).
 */
import { INCLUDE_DEPTH_LIMIT, extractIncludes, parseFrontmatter, type IncludeRef } from "./scan.ts";
import { RULES_MAX } from "../../lib/context-budget.js";

export type RuleScope = "builtin" | "global" | "compat" | "project";

/** Scope priority for same-name shadowing: later beats earlier. */
export const SCOPE_PRIORITY: RuleScope[] = ["builtin", "global", "compat", "project"];

export interface RuleDir {
	scope: RuleScope;
	path: string;
}

export interface RuleFs {
	/** Sorted list of `*.md` file names in a directory ([] when missing). */
	listMarkdownFiles(dir: string): string[];
	/** File content; throws on unreadable (callers treat as invalid). */
	readFile(path: string): string;
}

export interface RenderRulesInput {
	dirs: RuleDir[];
	cwd: string;
	projectTrusted: boolean;
	/** Paths the session already touched — matching globs rules render inline. */
	touchedPaths?: string[];
	budgetChars?: number;
	inlineThresholdChars?: number;
	fs: RuleFs;
}

export interface RenderedRule {
	scope: RuleScope;
	path: string;
	name: string;
	description: string;
	globs?: string[];
	always: boolean;
	/** Fully expanded content (frontmatter resolved, includes inlined). */
	content: string;
}

/** Resolve an @include target against the including file's location. */
export function resolveIncludeTarget(ref: IncludeRef, includingPath: string, home: string): string {
	const target = ref.target;
	if (ref.kind === "home") return join(home, target.slice(2));
	if (ref.kind === "absolute") return target.startsWith("/") ? target : `/${target}`;
	// relative: resolve against the directory of the including file
	const baseDir = includingPath.slice(0, Math.max(includingPath.lastIndexOf("/"), 0));
	return join(baseDir, target.slice(ref.kind === "relative-file" ? 2 : 0));
}

function join(a: string, b: string): string {
	if (a === "" || a === ".") return b;
	if (a.endsWith("/")) return a + b;
	return `${a}/${b}`;
}

/** Inline expansion of @include refs: all included bodies first, then the host body. */
export function expandIncludes(
	content: string,
	includingPath: string,
	fs: RuleFs,
	home: string,
	visited: Set<string>,
	depth: number,
): string {
	if (depth >= INCLUDE_DEPTH_LIMIT) return content;
	const refs = extractIncludes(content);
	if (refs.length === 0) return content;
	const includedBodies: string[] = [];
	let out = content;
	for (const ref of refs) {
		const target = resolveIncludeTarget(ref, includingPath, home);
		if (visited.has(target)) continue; // cycle → drop at revisit point
		let included: string;
		try {
			included = fs.readFile(target);
		} catch {
			continue; // missing → silent
		}
		const innerVisited = new Set(visited);
		innerVisited.add(target);
		const parsed = parseFrontmatter(included);
		const body = parsed.invalid ? included : parsed.body;
		includedBodies.push(
			expandIncludes(body, target, fs, home, innerVisited, depth + 1).trim(),
		);
		out = out.replace(ref.raw, ""); // token removed; body hoisted above
	}
	if (includedBodies.length === 0) return content;
	// include bodies first, then the remainder of the host file
	return `${includedBodies.join("\n\n")}\n\n${out.trim()}`;
}

/** Collect rules from all dirs with same-name shadowing (project wins). */
export function collectRules(input: RenderRulesInput): { rules: RenderedRule[]; invalidCount: number } {
	const { dirs, fs, projectTrusted } = input;
	const home = homeDir();
	const byName = new Map<string, RenderedRule>();
	let invalidCount = 0;

	for (const dir of SCOPE_PRIORITY) {
		if ((dir === "project" || dir === "compat") && !projectTrusted) continue;
		const entries = dirs.filter((d) => d.scope === dir);
		for (const entry of entries) {
		let files: string[];
		try {
			files = fs.listMarkdownFiles(entry.path);
		} catch {
			continue;
		}
		for (const file of files) {
			const path = join(entry.path, file);
			let raw: string;
			try {
				raw = fs.readFile(path);
			} catch {
				invalidCount++;
				continue;
			}
			const parsed = parseFrontmatter(raw);
			if (parsed.invalid) {
				invalidCount++;
				continue;
			}
			const slug = file.replace(/\.md$/, "");
			const fm = parsed.frontmatter ?? {};
			const name = fm.name ?? slug;
			// `**` (or a lone unmatched glob) degrades to always (P3-RU-02)
			const rawGlobs = fm.globs;
			const globs = rawGlobs?.filter((g) => g !== "**");
			const effectiveGlobs = globs && globs.length > 0 ? globs : undefined;
			const always = effectiveGlobs === undefined && (fm.always ?? true);
			const expanded = expandIncludes(parsed.body, path, fs, home, new Set([path]), 0);
			byName.set(slug, {
				scope: dir,
				path,
				name,
				description: fm.description ?? "",
				globs: effectiveGlobs,
				always,
				content: expanded,
			});
		}
		}
	}
	return { rules: [...byName.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)), invalidCount };
}

function homeDir(): string {
	// deterministic per process; tests substitute via HOME-independent fakes
	// where needed by passing absolute paths
	return globalHome;
}

let globalHome = "";

/** Set the home dir used to resolve `@~/` includes (wiring calls once). */
export function setRulesHome(home: string): void {
	globalHome = home;
}

function matchesGlobs(path: string, globs: string[]): boolean {
	for (const g of globs) {
		if (globToRegExp(g).test(path)) return true;
	}
	return false;
}

/** Minimal glob → RegExp (**, *, ?, {a,b}, and plain substrings). */
export function globToRegExp(glob: string): RegExp {
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

function escapeRe(c: string): string {
	return /[.*+?^${}()|[\]\\]/.test(c) ? `\\${c}` : c;
}

export interface RenderResult {
	output: string;
	/** Rules whose globs matched touchedPaths (activation fold-ins). */
	activated: string[];
}

export function renderRules(input: RenderRulesInput): RenderResult {
	const budget = input.budgetChars ?? RULES_MAX;
	const inlineThreshold = input.inlineThresholdChars ?? 4_000;
	const { rules, invalidCount } = collectRules(input);
	const touched = input.touchedPaths ?? [];

	interface InlineBlock {
		text: string;
		name: string;
		/** Touched-globs fold-in (spec P3-RU-04: these degrade first). */
		conditional: boolean;
	}
	const inlineBlocks: InlineBlock[] = [];
	const indexRows: string[] = [];
	const activated: string[] = [];

	for (const rule of rules) {
		if (rule.content.length > budget) continue; // >40K → drop entirely
		const touchedHit = rule.globs !== undefined && touched.some((p) => matchesGlobs(p, rule.globs!));
		const inline = rule.always || touchedHit;
		if (touchedHit) activated.push(rule.name);
		const size = rule.content.length + rule.name.length + 16;
		if (inline && size <= inlineThreshold) {
			inlineBlocks.push({
				text: `### ${rule.name}\n\n${rule.content.trim()}\n`,
				name: rule.name,
				conditional: touchedHit,
			});
		} else {
			const desc = rule.description ? ` — ${rule.description}` : "";
			const g = rule.globs ? ` (globs: ${rule.globs.join(", ")})` : "";
			indexRows.push(`- ${rule.name} [${rule.scope}]${g}${desc} — read ${rule.path} on demand`);
		}
	}

	const INDEX_SECTION_HEADER = "## Rule details (read on demand)\n\n";
	const inlineLen = () => inlineBlocks.reduce((n, b) => n + b.text.length, 0);
	const indexLen = () =>
		(indexRows.length > 0 ? INDEX_SECTION_HEADER.length + 2 : 0) +
		indexRows.reduce((n, r) => n + r.length + 1, 0);
	// Every emitted byte is accounted for: header + block connectors + the
	// index section (with its own header) + the trailing skip note. When the
	// budget binds, conditional fold-ins degrade to index rows FIRST
	// (P3-RU-04: 条件规则先降为索引行), then the largest always blocks, then
	// index rows drop whole from the tail — never mid-content.
	const overBudget = () =>
		inlineLen() +
			indexLen() +
			HEADER.length +
			NOTE_RESERVE +
			2 * (inlineBlocks.length > 0 ? 1 : 0) +
			// block/connectors: (N-1) "\n" between inline blocks + (R-1) between rows
			Math.max(0, inlineBlocks.length - 1) +
			Math.max(0, indexRows.length - 1) >
		budget;
	while (overBudget()) {
		const conditionalIdx = inlineBlocks.findIndex((b) => b.conditional);
		if (conditionalIdx !== -1) {
			const block = inlineBlocks.splice(conditionalIdx, 1)[0];
			indexRows.unshift(`- ${block.name} — content trimmed for budget; read the rules directory on demand`);
		} else if (inlineBlocks.length > 0) {
			let biggest = 0;
			for (let i = 1; i < inlineBlocks.length; i++) {
				if (inlineBlocks[i].text.length > inlineBlocks[biggest].text.length) biggest = i;
			}
			const block = inlineBlocks.splice(biggest, 1)[0];
			indexRows.unshift(`- ${block.name} — content trimmed for budget; read the rules directory on demand`);
		} else if (indexRows.length > 0) {
			indexRows.pop();
		} else break;
	}

	const parts: string[] = [HEADER];
	if (inlineBlocks.length > 0) {
		parts.push(inlineBlocks.map((b) => b.text).join("\n"));
	}
	if (indexRows.length > 0) {
		parts.push(INDEX_SECTION_HEADER + indexRows.join("\n"));
	}
	// no hard slice: the loop above accounts for every emitted byte, so
	// mid-content truncation never happens (P3-RU-04 red line)
	const output = `${parts.join("\n\n")}\n<!-- rules: skipped ${invalidCount} invalid -->\n`;
	return { output, activated };
}

const HEADER = "## Rules\n";
/** Reserved room for the trailing skip note inside the budget loop. */
const NOTE_RESERVE = "\n<!-- rules: skipped 000 invalid -->\n".length;
