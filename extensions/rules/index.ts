/**
 * rules/index.ts — the rules module's ONLY exported symbol (DESIGN-RULES D3
 * factory shell): createRulesExtension(options). v1 is read-only
 * (/rules command); lifecycle objects (setEnabled/lint/subscribe) are
 * deliberately deferred (P3-RU-12) — the factory shell accepts future
 * commands without breaking the interface.
 *
 * Wiring:
 *   - session_start: reset the activation set; drop the mtime fingerprint.
 *   - before_agent_start: append-only concatenation of renderRules output
 *     onto systemPrompt (never touches contextFiles, never mutates existing
 *     content — P3-RU-06). Emits contextBudget on the bus once (P3-RU-10).
 *   - tool_call: capture edit/write/read target paths; a first hit on a
 *     globs rule steers the full rule text once per session (P3-RU-07).
 *   - Cheapness promise (P3-RU-08, adjusted — DEVIATIONS #42): a
 *     file-level fingerprint (mtimeMs+size per rule file) gates rescans —
 *     an unchanged turn costs one readdir + N stats per dir and ZERO file
 *     content reads.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { statSync, readFileSync, readdirSync } from "node:fs";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { CONTEXT_BUDGET, DYNAMIC_STEER_MAX } from "../../lib/context-budget.js";
import { coreBus } from "../bus.js";
import { BUILTIN_RULES } from "./defaults.ts";
import { collectRules, globToRegExp, renderRules, setRulesHome, type RenderedRule, type RuleDir, type RuleFs } from "./render.ts";

/** In-memory glob hit for the cached-rules activation hot path. */
function globMatches(path: string, glob: string): boolean {
	return globToRegExp(glob).test(path);
}
import { extractToolPaths } from "./paths.ts";

export interface RulesExtensionOptions {
	/** Rare: extra rule directories (monorepo-shared), treated as project scope. */
	extraDirs?: string[];
	/** Total character budget; clamped by lib/context-budget (40K). */
	budgetChars?: number;
	/** Per-file inline threshold (4K default). */
	inlineThresholdChars?: number;
}

interface CtxLike {
	cwd?: string;
	hasUI?: boolean;
	isProjectTrusted?: () => boolean;
}

/** The module's single public symbol (DESIGN-RULES 定稿接口). */
export function createRulesExtension(options?: RulesExtensionOptions) {
	return function rulesExtension(pi: ExtensionAPI): void {
		const home = homedir();
		setRulesHome(home);
		const agentDir = join(home, ".pi", "agent");

		const dirsOf = (cwd: string): RuleDir[] => [
			{ scope: "builtin", path: "builtin://" },
			{ scope: "global", path: join(agentDir, "rules") },
			{ scope: "compat", path: join(cwd, ".claude", "rules") },
			{ scope: "project", path: join(cwd, ".pi", "rules") },
			...(options?.extraDirs ?? []).map((extra) => ({ scope: "project" as const, path: extra })),
		];

		const realFs: RuleFs = {
			listMarkdownFiles(dir: string): string[] {
				if (dir === "builtin://") return BUILTIN_RULES.map((r) => `${r.slug}.md`);
				try {
					return readdirSync(dir).filter((f) => f.endsWith(".md")).sort();
				} catch {
					return [];
				}
			},
			readFile(path: string): string {
				if (path.startsWith("builtin://")) {
					const slug = path.slice("builtin://".length).replace(/\.md$/, "");
					const rule = BUILTIN_RULES.find((r) => r.slug === slug);
					if (!rule) throw new Error("missing builtin");
					return `---\nname: ${rule.name}\ndescription: ${rule.description}\n---\n\n${rule.content}`;
				}
				return readFileSync(path, "utf-8");
			},
		};

		// mtime fingerprint cache (P3-RU-08): output AND the collected rules
		// (so tool_call activation never re-scans — review #16a)
		let fingerprint: string | null = null;
		let cachedOutput: string | null = null;
		let cachedRules: RenderedRule[] | null = null;
		const activatedNames = new Set<string>();
		let budgetPublished = false;

		function fingerprintOf(dirs: RuleDir[]): string {
			// file-level fingerprint: a bare directory mtime misses in-place
			// content edits on most filesystems (review #16b), so every rule
			// file contributes its (mtimeMs, size). The cost is one readdir +
			// N stats per dir per turn — still zero file-content reads while
			// the fingerprint holds (P3-RU-08 便宜性, adjusted: see
			// DEVIATIONS #39).
			return dirs
				.map((d) => {
					if (d.scope === "builtin") return "builtin:static";
					try {
						const files = readdirSync(d.path)
							.filter((f) => f.endsWith(".md"))
							.sort();
						const sig = files
							.map((f) => {
								try {
									const st = statSync(join(d.path, f));
									return `${f}:${st.mtimeMs}:${st.size}`;
								} catch {
									return `${f}:gone`;
								}
							})
							.join(",");
						return `${d.path}[${sig}]`;
					} catch {
						return `${d.path}:missing`;
					}
				})
				.join("|");
		}

		function trusted(ctx: CtxLike | undefined): boolean {
			// pi gates untrusted projects upstream; honor an explicit signal if present
			return ctx?.isProjectTrusted ? ctx.isProjectTrusted() === true : true;
		}

		function renderFor(cwd: string, touchedPaths: string[], ctx: CtxLike | undefined): string {
			const dirs = dirsOf(cwd);
			const fp = fingerprintOf(dirs);
			if (fp !== fingerprint || cachedOutput === null) {
				fingerprint = fp;
				// NOTE: activatedNames intentionally survives fingerprint
				// changes — "once per session" (P3-RU-07) must not reset
				// because a rule file was edited mid-session (review #16c)
				const rendered = renderRules({
					dirs,
					cwd,
					projectTrusted: trusted(ctx),
					touchedPaths,
					budgetChars: options?.budgetChars,
					inlineThresholdChars: options?.inlineThresholdChars,
					fs: realFs,
				});
				cachedOutput = rendered.output;
				cachedRules = collectRules({
					dirs,
					cwd,
					projectTrusted: trusted(ctx),
					touchedPaths: [],
					fs: realFs,
				}).rules;
			}
			return cachedOutput;
		}

		pi.on("session_start", () => {
			activatedNames.clear();
			fingerprint = null;
			cachedOutput = null;
			cachedRules = null;
			if (!budgetPublished) {
				budgetPublished = true;
				coreBus().publish({ contextBudget: { ...CONTEXT_BUDGET } });
			}
		});

		pi.on("before_agent_start", (event, ctx: ExtensionContext) => {
			const block = renderFor(ctx.cwd, [], ctx);
			return { systemPrompt: `${event.systemPrompt ?? ""}\n\n${block}` };
		});

		pi.on("tool_call", async (event, ctx: ExtensionContext) => {
			const name = typeof event.toolName === "string" ? event.toolName : "";
			if (!/^(read|edit|write)$/.test(name)) return undefined;
			const paths = extractToolPaths(event.input);
			if (paths.length === 0) return undefined;

			const dirs = dirsOf(ctx.cwd);
			if (cachedRules !== null) {
				// hot path: activation from the cached collected rules — pure
				// in-memory glob matching, ZERO scans or content reads
				// (review #16a). Falls back to a full render below when the
				// cache is cold (first tool_call before any agent start).
				const fresh: string[] = [];
				for (const rule of cachedRules) {
					if (rule.globs === undefined) continue;
					if (activatedNames.has(rule.name)) continue;
					if (paths.some((p) => rule.globs!.some((g) => globMatches(p, g)))) {
						fresh.push(rule.name);
					}
				}
				if (fresh.length === 0) return undefined;
				for (const ruleName of fresh) {
					activatedNames.add(ruleName);
					const rule = cachedRules.find((r) => r.name === ruleName)!;
					const full = `### ${rule.name}\n\n${rule.content}`;
					const content =
						full.length <= DYNAMIC_STEER_MAX
							? full
							: `${rule.name}: rule text exceeds the per-turn steer budget (${DYNAMIC_STEER_MAX} chars). Read ${rule.path} on demand.`;
					pi.sendMessage(
						{ customType: "pi-rules-activate", content, display: true },
						{ deliverAs: "steer" },
					);
				}
				return undefined;
			}
			const { activated } = renderRules({
				dirs,
				cwd: ctx.cwd,
				projectTrusted: trusted(ctx),
				touchedPaths: paths,
				budgetChars: options?.budgetChars,
				inlineThresholdChars: options?.inlineThresholdChars,
				fs: realFs,
			});
			if (activated.length === 0) return undefined;
			// steer from the CACHED collected rules — a matching tool call
			// costs zero extra scans (review #16a). Oversized rules steer an
			// index-style pointer instead of the full text, clamped to
			// DYNAMIC_STEER_MAX (P3-RU-10; review #15).
			const rules = cachedRules ?? collectRules({ dirs, cwd: ctx.cwd, projectTrusted: trusted(ctx), touchedPaths: [], fs: realFs }).rules;
			for (const ruleName of activated) {
				if (activatedNames.has(ruleName)) continue; // once per session (P3-RU-07)
				const rule = rules.find((r) => r.name === ruleName);
				if (!rule) continue;
				activatedNames.add(ruleName);
				const full = `### ${rule.name}\n\n${rule.content}`;
				const content =
					full.length <= DYNAMIC_STEER_MAX
						? full
						: `${rule.name}: rule text exceeds the per-turn steer budget (${DYNAMIC_STEER_MAX} chars). Read ${rule.path} on demand.`;
				pi.sendMessage(
					{ customType: "pi-rules-activate", content, display: true },
					{ deliverAs: "steer" },
				);
			}
			return undefined; // activation never blocks a tool call
		});

		pi.registerCommand("rules", {
			description: "List rules (read-only): name, scope, always/globs, budget usage",
			handler: async (_args, ctx) => {
				const commandCtx = ctx as ExtensionContext;
				const cwd = commandCtx.cwd ?? process.cwd();
				const result = renderRules({
					dirs: dirsOf(cwd),
					cwd,
					projectTrusted: trusted(commandCtx),
					touchedPaths: [],
					budgetChars: options?.budgetChars,
					inlineThresholdChars: options?.inlineThresholdChars,
					fs: realFs,
				});
				const inlineCount = (result.output.match(/^### /gm) ?? []).length;
				const rowCount = (result.output.match(/^- .+ read .+ on demand$/gm) ?? []).length;
				const budget = options?.budgetChars ?? CONTEXT_BUDGET.rulesMax;
				const summary = `rules: ${inlineCount} inline, ${rowCount} indexed, ${result.output.length}/${budget} chars, ${activatedNames.size} activated this session`;
				pi.sendMessage({ customType: "pi-rules-list", content: `${summary}\n\n${result.output}`, display: true });
			},
		});
	};
}
