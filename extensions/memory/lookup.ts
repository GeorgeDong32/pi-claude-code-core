/**
 * memory/lookup.ts — the on-demand half of the memory context diet
 * (spec core-context-diet v3): the index stays compact (slug +
 * description), and the model pulls the rest when it needs it.
 *
 *   memory_lookup(name)                 full text of one memory file
 *   knowledge_search(query, scope)      case-insensitive substring search
 *                                       over the memory dir, the configured
 *                                       searchRoots and/or past sessions
 *
 * Both are registered with exposure "deferred": nothing in the tool list
 * until tool_search finds them (codemode can call them directly).
 *
 * Safety: a lookup name must pass the same file-name whitelist as writes
 * (no traversal); root search is substring-only (no regex, no ReDoS), reads
 * only .md/.txt files under the allowed roots, caps the files scanned and
 * the hits returned, and never returns file bodies — the model reads a hit
 * through the regular `read` tool, behind the normal permission gate.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { Type } from "typebox";
import { defineTool, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { safeMemoryFileName } from "./store.ts";
import { readFrontmatterField } from "./memdir.ts";

export const SEARCH_MAX_FILES = 2_000;
export const SEARCH_MAX_HITS = 20;
export const SEARCH_MAX_FILE_BYTES = 256 * 1024;
const SKIP_DIRS = new Set([".git", "node_modules", ".obsidian", ".trash"]);
const TEXT_FILE = /\.(md|txt)$/i;

export interface LookupResult {
	ok: boolean;
	/** File stem on success; on a miss the closest candidates. */
	text: string;
	near: string[];
}

export function lookupMemory(dir: string, name: string): LookupResult {
	const file = name.endsWith(".md") ? name : `${name}.md`;
	if (!safeMemoryFileName(file)) return { ok: false, text: "", near: [] };
	const path = join(dir, file);
	let content: string;
	try {
		content = readFileSync(path, "utf8");
	} catch {
		const stem = file.slice(0, -3);
		const tokens = new Set(stem.split("-").filter((t) => t.length >= 4));
		const near = readdirSync(dir)
			.filter((f) => f.endsWith(".md") && f !== "MEMORY.md")
			.map((f) => f.slice(0, -3))
			.filter((s) => s.split("-").some((t) => tokens.has(t)))
			.slice(0, 5);
		return { ok: false, text: "", near };
	}
	return { ok: true, text: content, near: [] };
}

export interface SearchHit {
	root: string;
	path: string;
	hint: string;
}

export interface SearchInput {
	roots: string[];
	query: string;
	maxHits?: number;
}

function firstLineHint(content: string): string {
	const description = readFrontmatterField(content, "description");
	if (description) return description;
	for (const raw of content.split("\n").slice(0, 20)) {
		const line = raw.trim();
		if (line.startsWith("#")) return line.replace(/^#+\s*/, "").slice(0, 120);
	}
	return "";
}

function* walk(root: string, budget: { files: number }): Generator<string> {
	const queue = [root];
	while (queue.length > 0 && budget.files > 0) {
		const dir = queue.shift()!;
		let entries;
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			if (budget.files <= 0) return;
			if (entry.name.startsWith(".")) continue;
			const full = join(dir, entry.name);
			if (entry.isDirectory()) {
				if (!SKIP_DIRS.has(entry.name)) queue.push(full);
				continue;
			}
			if (!TEXT_FILE.test(entry.name)) continue;
			budget.files--;
			yield full;
		}
	}
}

/** Case-insensitive substring search over text files under the given roots. */
export function searchRoots(input: SearchInput): { hits: SearchHit[]; scanned: number; truncated: boolean } {
	const needle = input.query.trim().toLowerCase();
	const maxHits = input.maxHits ?? SEARCH_MAX_HITS;
	const hits: SearchHit[] = [];
	const budget = { files: SEARCH_MAX_FILES };
	let scanned = 0;
	if (needle.length === 0) return { hits, scanned, truncated: false };
	for (const root of input.roots) {
		for (const path of walk(root, budget)) {
			if (hits.length >= maxHits) return { hits, scanned, truncated: true };
			scanned++;
			const rel = relative(root, path);
			const pathHit = rel.toLowerCase().includes(needle);
			let content = "";
			try {
				if (statSync(path).size <= SEARCH_MAX_FILE_BYTES) content = readFileSync(path, "utf8");
			} catch {
				content = "";
			}
			const hint = content ? firstLineHint(content) : "";
			if (!pathHit && !hint.toLowerCase().includes(needle)) continue;
			hits.push({ root, path, hint });
		}
	}
	return { hits, scanned, truncated: budget.files <= 0 };
}

/** A scope root the user configured must be an existing absolute directory;
 * the memory dir is always allowed. */
export function allowedRoots(configured: string[] | undefined, memoryDir: string): string[] {
	const roots = [memoryDir];
	for (const candidate of configured ?? []) {
		if (!isAbsolute(candidate)) continue;
		const real = resolve(candidate);
		try {
			if (!statSync(real).isDirectory()) continue;
		} catch {
			continue;
		}
		if (real === memoryDir || roots.includes(real)) continue;
		roots.push(real);
	}
	return roots;
}

export interface KnowledgeSearchDeps {
	home: string;
	memoryDir: string;
	searchRoots: string[] | undefined;
	sessionSearch: (input: { query: string; project: string; limit: number }) => Promise<{
		hits: Array<{ file: string; line: number; role: string; timestamp?: string; text: string }>;
		scannedFiles: number;
	}>;
}

export type KnowledgeScope = "memory" | "roots" | "sessions" | "all";

export async function knowledgeSearch(deps: KnowledgeSearchDeps, query: string, scope: KnowledgeScope, cwd: string): Promise<string> {
	const lines: string[] = [];
	if (scope !== "sessions") {
		const roots = scope === "memory" ? [deps.memoryDir] : scope === "roots" ? allowedRoots(deps.searchRoots, deps.memoryDir).filter((r) => r !== deps.memoryDir) : allowedRoots(deps.searchRoots, deps.memoryDir);
		const found = searchRoots({ roots, query, maxHits: SEARCH_MAX_HITS });
		if (found.hits.length === 0) {
			lines.push(`notes: no matches for "${query}" (${found.scanned} files scanned under ${roots.length} root(s))`);
		} else {
			lines.push(`notes: ${found.hits.length} hit(s)${found.truncated ? " (search capped — narrow the query)" : ""}`);
			for (const h of found.hits) lines.push(`- ${h.path}${h.hint ? ` — ${h.hint.slice(0, 120)}` : ""}`);
		}
	}
	if (scope === "sessions" || scope === "all") {
		const sessions = await deps.sessionSearch({ query, project: cwd, limit: scope === "all" ? 5 : 10 });
		if (sessions.hits.length === 0) {
			lines.push(`sessions: no matches (${sessions.scannedFiles} session files scanned)`);
		} else {
			lines.push(`sessions: ${sessions.hits.length} hit(s)`);
			for (const h of sessions.hits) lines.push(`- ${h.file}:${h.line} ${h.role}${h.timestamp ? ` @ ${h.timestamp}` : ""}: ${h.text.slice(0, 200)}`);
		}
	}
	return lines.join("\n");
}

export function lookupTool(dir: (ctx: ExtensionContext) => string, onCall: () => void) {
	return defineTool({
		name: "memory_lookup",
		label: "Memory Lookup",
		description: "Return the full text of one project memory by its slug (the index lists slug — description).",
		exposure: "deferred",
		parameters: Type.Object({
			name: Type.String({ description: "Memory slug, e.g. bg-shell-module-facts" }),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			onCall();
			const p = params as { name: string };
			const result = lookupMemory(dir(ctx), p.name);
			if (!result.ok && result.near.length === 0) {
				return { content: [{ type: "text", text: `memory_lookup: "${p.name}" is not a memory file name${result.near.length ? ` — did you mean: ${result.near.join(", ")}?` : ""}` }], details: { ok: false } };
			}
			if (!result.ok) {
				return { content: [{ type: "text", text: `memory_lookup: no memory named "${p.name}" — did you mean: ${result.near.join(", ")}?` }], details: { ok: false, near: result.near } };
			}
			return { content: [{ type: "text", text: result.text }], details: { ok: true } };
		},
	});
}

export function searchTool(deps: (ctx: ExtensionContext) => KnowledgeSearchDeps, onCall: () => void) {
	return defineTool({
		name: "knowledge_search",
		label: "Knowledge Search",
		description: 'Case-insensitive substring search for a topic: scope "memory" (project memories), "roots" (configured notes roots), "sessions" (past sessions of this project) or "all". Returns paths/pointers, not file bodies.',
		exposure: "deferred",
		parameters: Type.Object({
			query: Type.String({ description: "Substring to look for" }),
			scope: Type.Optional(Type.Union([Type.Literal("memory"), Type.Literal("roots"), Type.Literal("sessions"), Type.Literal("all")], { description: "Default: all" })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			onCall();
			const p = params as { query: string; scope?: KnowledgeScope };
			const text = await knowledgeSearch(deps(ctx), p.query, p.scope ?? "all", ctx.cwd ?? process.cwd());
			return { content: [{ type: "text", text: `knowledge_search: ${p.query}\n\n${text}` }], details: { scope: p.scope ?? "all" } };
		},
	});
}
