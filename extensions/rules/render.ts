import { INCLUDE_DEPTH_LIMIT, extractIncludes, parseFrontmatter, type IncludeRef } from "./scan.ts";
import { RULES_MAX } from "../../lib/context-budget.js";
export { globToRegExp } from "../../lib/glob.ts";
import { globMatches } from "../../lib/glob.ts";

export type RuleScope = "builtin" | "global" | "compat" | "project";

export const SCOPE_PRIORITY: RuleScope[] = ["builtin", "global", "compat", "project"];

export interface RuleDir {
	scope: RuleScope;
	path: string;
}

export interface RuleFs {
	listMarkdownFiles(dir: string): string[];
	readFile(path: string): string;
}

export interface RenderRulesInput {
	dirs: RuleDir[];
	cwd: string;
	projectTrusted: boolean;
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
	content: string;
}

export function resolveIncludeTarget(ref: IncludeRef, includingPath: string, home: string): string {
	const target = ref.target;
	if (ref.kind === "home") return join(home, target.slice(2));
	if (ref.kind === "absolute") return target.startsWith("/") ? target : `/${target}`;
	const baseDir = includingPath.slice(0, Math.max(includingPath.lastIndexOf("/"), 0));
	return join(baseDir, target.slice(ref.kind === "relative-file" ? 2 : 0));
}

function join(a: string, b: string): string {
	if (a === "" || a === ".") return b;
	if (a.endsWith("/")) return a + b;
	return `${a}/${b}`;
}

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
		if (visited.has(target)) continue;
		let included: string;
		try {
			included = fs.readFile(target);
		} catch {
			continue;
		}
		const innerVisited = new Set(visited);
		innerVisited.add(target);
		const parsed = parseFrontmatter(included);
		const body = parsed.invalid ? included : parsed.body;
		includedBodies.push(
			expandIncludes(body, target, fs, home, innerVisited, depth + 1).trim(),
		);
		out = out.replace(ref.raw, "");
	}
	if (includedBodies.length === 0) return content;
	return `${includedBodies.join("\n\n")}\n\n${out.trim()}`;
}

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
	if (globalHome === null) globalHome = process.env.HOME ?? "";
	return globalHome;
}

let globalHome: string | null = null;

export function setRulesHome(home: string): void {
	globalHome = home;
}

export interface RenderResult {
	output: string;
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
		conditional: boolean;
	}
	const inlineBlocks: InlineBlock[] = [];
	const indexRows: string[] = [];
	const activated: string[] = [];

	for (const rule of rules) {
		if (rule.content.length > budget) continue;
		const touchedHit = rule.globs !== undefined && touched.some((p) => globMatches(p, rule.globs!));
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
	const degradeRow = (name: string) =>
		`- ${name} — content trimmed for budget; read the rules directory on demand`;
	const worthDegrading = (b: InlineBlock) => b.text.length > degradeRow(b.name).length + 1;
	const overBudget = () =>
		inlineLen() +
			indexLen() +
			HEADER.length +
			NOTE_RESERVE +
			2 * (inlineBlocks.length > 0 ? 1 : 0) +
			Math.max(0, inlineBlocks.length - 1) +
			Math.max(0, indexRows.length - 1) >
		budget;
	while (overBudget()) {
		const conditionalIdx = inlineBlocks.findIndex((b) => b.conditional && worthDegrading(b));
		if (conditionalIdx !== -1) {
			const block = inlineBlocks.splice(conditionalIdx, 1)[0];
			indexRows.unshift(degradeRow(block.name));
		} else {
			let biggest = -1;
			for (let i = 0; i < inlineBlocks.length; i++) {
				const b = inlineBlocks[i];
				if (b.conditional || !worthDegrading(b)) continue;
				if (biggest === -1 || b.text.length > inlineBlocks[biggest].text.length) biggest = i;
			}
			if (biggest !== -1) {
				const block = inlineBlocks.splice(biggest, 1)[0];
				indexRows.unshift(degradeRow(block.name));
			} else if (inlineBlocks.length > 0) {
				let smallest = 0;
				for (let i = 1; i < inlineBlocks.length; i++) {
					if (inlineBlocks[i].text.length < inlineBlocks[smallest].text.length) smallest = i;
				}
				inlineBlocks.splice(smallest, 1);
			} else if (indexRows.length > 0) {
				indexRows.pop();
			} else break;
		}
	}

	const parts: string[] = [HEADER];
	if (inlineBlocks.length > 0) {
		parts.push(inlineBlocks.map((b) => b.text).join("\n"));
	}
	if (indexRows.length > 0) {
		parts.push(INDEX_SECTION_HEADER + indexRows.join("\n"));
	}
	const output = `${parts.join("\n\n")}\n<!-- rules: skipped ${invalidCount} invalid -->\n`;
	return { output, activated };
}

const HEADER = "## Rules\n";
const NOTE_RESERVE = "\n<!-- rules: skipped 000 invalid -->\n".length;
