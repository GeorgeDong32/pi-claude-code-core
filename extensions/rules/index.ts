import { homedir } from "node:os";
import { join } from "node:path";
import { statSync, readFileSync, readdirSync } from "node:fs";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { CONTEXT_BUDGET } from "../../lib/context-budget.js";
import { createRuleActivation } from "./activation.ts";
import { coreBus } from "../bus.js";
import { collectRules, globToRegExp, renderRules, setRulesHome, type RenderedRule, type RuleDir, type RuleFs } from "./render.ts";

function globMatches(path: string, glob: string): boolean {
	return globToRegExp(glob).test(path);
}
import { extractToolPaths } from "./paths.ts";

export interface RulesExtensionOptions {
	extraDirs?: string[];
	budgetChars?: number;
	inlineThresholdChars?: number;
}

interface CtxLike {
	cwd?: string;
	hasUI?: boolean;
	isProjectTrusted?: () => boolean;
}

export function createRulesExtension(options?: RulesExtensionOptions) {
	return function rulesExtension(pi: ExtensionAPI): void {
		const home = homedir();
		setRulesHome(home);
		const agentDir = join(home, ".pi", "agent");

		const dirsOf = (cwd: string): RuleDir[] => [
			{ scope: "global", path: join(agentDir, "rules") },
			{ scope: "compat", path: join(cwd, ".claude", "rules") },
			{ scope: "project", path: join(cwd, ".pi", "rules") },
			...(options?.extraDirs ?? []).map((extra) => ({ scope: "project" as const, path: extra })),
		];

		const realFs: RuleFs = {
			listMarkdownFiles(dir: string): string[] {
				try {
					return readdirSync(dir).filter((f) => f.endsWith(".md")).sort();
				} catch {
					return [];
				}
			},
			readFile(path: string): string {
				return readFileSync(path, "utf-8");
			},
		};

		let fingerprint: string | null = null;
		let cachedOutput: string | null = null;
		let cachedRules: RenderedRule[] | null = null;
		let budgetPublished = false;

		function fingerprintOf(dirs: RuleDir[]): string {
			return dirs
				.map((d) => {
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
			return ctx?.isProjectTrusted ? ctx.isProjectTrusted() === true : true;
		}

		function renderFor(cwd: string, ctx: CtxLike | undefined): string {
			const dirs = dirsOf(cwd);
			const fp = fingerprintOf(dirs);
			if (fp !== fingerprint || cachedOutput === null) {
				fingerprint = fp;
				const rendered = renderRules({
					dirs,
					cwd,
					projectTrusted: trusted(ctx),
					touchedPaths: [],
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

	const activation = createRuleActivation({
		send: (content) => {
			pi.sendMessage(
				{ customType: "pi-rules-activate", content, display: true },
				{ deliverAs: "steer" },
			);
		},
	});

		pi.on("session_start", () => {
			activation.onSessionStart();
			fingerprint = null;
			cachedOutput = null;
			cachedRules = null;
			if (!budgetPublished) {
				budgetPublished = true;
				coreBus().publish({ contextBudget: { ...CONTEXT_BUDGET } });
			}
		});

		pi.on("turn_start", () => {
			activation.onTurnStart();
		});

		pi.on("before_agent_start", (event, ctx: ExtensionContext) => {
			const block = renderFor(ctx.cwd, ctx);
			return { systemPrompt: `${event.systemPrompt ?? ""}\n\n${block}` };
		});

		pi.on("tool_call", async (event, ctx: ExtensionContext) => {
			const name = typeof event.toolName === "string" ? event.toolName : "";
			if (!/^(read|edit|write)$/.test(name)) return undefined;
			const paths = extractToolPaths(event.input);
			if (paths.length === 0) return undefined;

			const dirs = dirsOf(ctx.cwd);
			if (cachedRules !== null) {
				const fresh: string[] = [];
				for (const rule of cachedRules) {
					if (rule.globs === undefined) continue;
					if (paths.some((p) => rule.globs!.some((g) => globMatches(p, g)))) {
						fresh.push(rule.name);
					}
				}
				if (fresh.length === 0) return undefined;
				activation.activate(fresh.map((ruleName) => cachedRules!.find((r) => r.name === ruleName)!));
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
			const rules = collectRules({ dirs, cwd: ctx.cwd, projectTrusted: trusted(ctx), touchedPaths: [], fs: realFs }).rules;
			activation.activate(
				activated
					.filter((ruleName) => rules.some((r) => r.name === ruleName))
					.map((ruleName) => rules.find((r) => r.name === ruleName)!),
			);
			return undefined;
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
				const summary = `rules: ${inlineCount} inline, ${rowCount} indexed, ${result.output.length}/${budget} chars, ${activation.sessionActivatedCount()} activated this session`;
				pi.sendMessage({
					customType: "pi-rules-list",
					content: `${summary}\n\n${result.output}`,
					details: { command: "/rules" },
					display: true,
				});
			},
		});
	};
}
