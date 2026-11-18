/**
 * @georgedong32/pi-review — fan-out code review for Pi.
 *
 * v0.7 pipeline:
 *   1. `/review` resolves the target, prepares the diff + target repo
 *      checkout, and writes `.pi/pi-review/runs/<runId>/manifest.json`.
 *   2. The hidden directive tells the main agent to call `subagent({...})`
 *      exactly once with a generated workflowScript. The script fans out
 *      reviewers via `runs.all([...])` and feeds their `structuredOutput`
 *      objects into `runs.run("gate")`. Every child passes `cwd` and
 *      `outputSchema`.
 *   3. The main agent calls `pi_review_report` (a tool registered below)
 *      with the workflow return value. The tool re-validates outputs,
 *      enforces verdict in code, persists a session entry, and renders the
 *      deterministic markdown.
 *
 * No project-level permission files are written — diff/clone/fetch happen
 * via the extension's own `pi.exec`; reviewer children only need read/grep
 * and a few read-only git commands, all already permitted in the agent
 * frontmatter.
 *
 * R11 (D-CH-2, 2026-11-15): the review bus channel reconciles at three
 * points (agent_end for a report-less live run, session_start for stale
 * running, a new /review entry for residual running) so `review.status` can
 * no longer get stuck at "running". Since CH-8b the live run is armed by
 * the directive message itself (message_start, customType
 * "pi-review-directive"), not by any agent_start. See the liveRun closure.
 */
import { notify as sharedNotify } from "../ui/notify.ts";
import { existsSync, readFileSync } from "node:fs";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import { coreBus } from "../bus.js";
import { parseReviewArgs } from "./src/cli-args.js";
import {
	DEFAULT_CONFIG,
	configPath,
	loadConfig,
	mergeWithDefaults,
	resolveModel,
	validateConfig,
	writeConfig,
} from "./src/config.js";
import { prepareRun } from "./src/review-run.js";
import { REVIEW_DIRECTIVE_CUSTOM_TYPE } from "./src/directive.js";
import { registerReviewReportTool } from "./src/tool-wrapper.js";
import { registerPiReviewRenderer } from "./src/tui-renderer.js";

function parentModelId(ctx: ExtensionCommandContext): string | undefined {
	const m = ctx.model;
	if (!m) return undefined;
	return `${m.provider}/${m.id}`;
}

export default function (pi: ExtensionAPI) {
	registerReviewReportTool(pi);
	registerPiReviewRenderer(pi);

	let degradedNoticeShown = false;
	function subagentToolAvailable(): boolean {
		try {
			return pi.getAllTools().some((t) => t.name === "subagent");
		} catch {
			return false;
		}
	}
	function degradationNotice(): string {
		return "pi-review requires pi-subagents: pi install npm:pi-subagents";
	}
	function checkSubagentAvailability(): boolean {
		return subagentToolAvailable();
	}

	let liveRun: { runId: string } | null = null;
	let liveRunArmed = false;
	function busReviewStatus(): string {
		try {
			return coreBus().snapshot().review.status;
		} catch {
			return "idle";
		}
	}
	function reconcileIdle(): void {
		try {
			coreBus().publish({ review: { status: "idle", lastRunAt: null } });
		} catch {
		}
	}
	pi.on("session_start", () => {
		// R11 ②: stale running from a previous session/process must not leak in.
		if (busReviewStatus() === "running") reconcileIdle();
		if (!subagentToolAvailable() && !degradedNoticeShown) {
			console.log(`pi-review: ${degradationNotice()}`);
		}
	});
	pi.on("message_start", (event) => {
		const m = event?.message as { role?: string; customType?: string } | undefined;
		if (liveRun && m?.role === "custom" && m.customType === REVIEW_DIRECTIVE_CUSTOM_TYPE) liveRunArmed = true;
	});
	pi.on("agent_end", () => {
		if (!liveRun || !liveRunArmed) return;
		liveRun = null;
		liveRunArmed = false;
		if (busReviewStatus() === "running") reconcileIdle();
	});
	pi.registerCommand("review", {
		description: "Foreground code review (lean pi-review.* agents). --lite = single-agent.",
		getArgumentCompletions: (prefix: string) => {
			const trimmed = prefix.trimStart();
			const tokens = trimmed.split(/\s+/).filter(Boolean);
			const last = tokens[tokens.length - 1] ?? "";
			if (last.startsWith("--")) {
				return [
					{ value: "--lite", label: "--lite", description: "Fast single-agent review (no gate)" },
					{ value: "--gate-model", label: "--gate-model", description: "Override gate model for this run" },
				].filter((o) => o.value.startsWith(last));
			}
			return null;
		},
		handler: async (args, ctx) => {
			const notify = (msg: string, level: "info" | "warning" | "error" = "info") => {
				if (ctx.hasUI) sharedNotify(ctx, msg, level);
				else console.log(`pi-review: ${msg}`);
			};

			if (!checkSubagentAvailability()) {
				if (!degradedNoticeShown) {
					degradedNoticeShown = true;
					notify(degradationNotice(), "warning");
				}
				notify("pi-review: subagent tool unavailable — review skipped", "error");
				return;
			}

			try {
				const parsed = parseReviewArgs(args);
				const { config, legacyWarnings } = loadConfig();
				for (const w of legacyWarnings) notify(`pi-review: ${w}`, "warning");

				if (!liveRun && busReviewStatus() === "running") reconcileIdle();

				pi.sendMessage({
					customType: "pi-review",
					content: parsed.input ? `/review ${parsed.input}` : "/review",
					display: true,
				});

				if (parsed.noSpawn) {
					const dryRunText = await renderDryRun(ctx, parsed, config);
					pi.sendMessage({ customType: "pi-review", content: dryRunText, display: true });
					return;
				}

				const prepared = await prepareRun({ cwd: ctx.cwd, input: parsed.input, lite: parsed.lite, gateModel: parsed.gateModel });
				if (!prepared) {
					notify("Nothing to review (no PR/url/diff and not a git repo).", "info");
					return;
				}

				coreBus().publish({ review: { status: "running", lastRunAt: null } });
				liveRun = { runId: prepared.runId };
				liveRunArmed = false;

				pi.sendMessage(
					{
						customType: REVIEW_DIRECTIVE_CUSTOM_TYPE,
						content: prepared.directiveText,
						display: false,
					},
					{ triggerTurn: true },
				);
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				notify(`pi-review failed: ${message}`, "error");
			}
		},
	});

	pi.registerCommand("review-config", {
		description: "Edit pi-review config (~/.pi/agent/pi-review.json)",
		handler: async (_args, ctx) => {
			const path = configPath();
			if (!existsSync(path)) {
				writeConfig(DEFAULT_CONFIG);
			}

			let raw: string;
			if (ctx.hasUI) {
				const current = readFileSync(path, "utf-8");
				const edited = await ctx.ui.editor("Edit pi-review config (JSON)", current);
				if (edited === undefined) {
					ctx.ui.notify("Config edit cancelled.", "info");
					return;
				}
				raw = edited;
			} else {
				const editor = process.env.VISUAL ?? process.env.EDITOR;
				if (!editor) {
					ctx.ui.notify(`Set $EDITOR or use TUI. Config path: ${path}`, "warning");
					return;
				}
				await pi.exec(editor, [path], { cwd: ctx.cwd });
				raw = readFileSync(path, "utf-8");
			}

			let parsed: unknown;
			try {
				parsed = JSON.parse(raw);
			} catch {
				ctx.ui.notify("Invalid JSON — config not saved.", "error");
				return;
			}

			const merged = mergeWithDefaults(parsed);
			const validation = validateConfig(merged);
			if (!validation.ok) {
				ctx.ui.notify(`Config errors: ${validation.errors.join("; ")}`, "error");
				return;
			}
			writeConfig(merged);
			ctx.ui.notify("pi-review config saved.", "info");
		},
	});

	pi.registerCommand("review-agents", {
		description: "List bundled reviewers and resolved models",
		handler: async (_args, ctx) => {
			const { config } = loadConfig();
			const parent = parentModelId(ctx);
			const lines: string[] = ["## pi-review agents", ""];
			for (const r of Object.values(config.reviewers)) {
				const model = resolveModel(r.model, parent);
				const status = r.enabled ? "enabled" : "disabled";
				lines.push(`- **${r.id}** (${r.label}) — ${status}`);
				lines.push(`  - model: ${model}`);
				lines.push(`  - thinking: ${r.thinking ?? "default"}`);
			}
			lines.push("");
			lines.push(`Gate: ${resolveModel(config.gate.model, parent)} · threshold ${config.gate.threshold} · policy ${config.gate.verdictPolicy}`);
			lines.push(`Routing: ${config.routing.mode}`);
			const body = lines.join("\n");
			pi.sendMessage({
				customType: "pi-review-agents",
				content: body,
				details: { command: "/review-agents" },
				display: true,
			});
		},
	});

	pi.registerCommand("review-show", {
		description: "Re-render the most recent pi-review session entry",
		handler: async (_args, ctx) => {
			let last: { markdown?: string } | null = null;
			for (const entry of ctx.sessionManager.getBranch()) {
				if (
					entry.type === "custom" &&
					(entry as { customType?: string }).customType === "pi-review" &&
					(entry as { data?: { markdown?: string } }).data?.markdown
				) {
					last = (entry as { data: { markdown?: string } }).data;
				}
			}
			if (!last?.markdown) {
				ctx.ui.notify("No pi-review report found in this session.", "info");
				return;
			}
			pi.sendMessage({ customType: "pi-review", content: last.markdown, display: true });
		},
	});
}

async function renderDryRun(
	ctx: ExtensionCommandContext,
	parsed: ReturnType<typeof parseReviewArgs>,
	config: ReturnType<typeof loadConfig>["config"],
): Promise<string> {
	const prepared = await prepareRun({
		cwd: ctx.cwd,
		input: parsed.input,
		lite: parsed.lite,
		gateModel: parsed.gateModel,
		cleanup: false,
		dryRun: true,
	});
	if (!prepared) return "pi-review dry run: nothing to review.";
	const m = prepared.manifest;
	const gate = config.gate;
	const prDryRun = prepared.dryRun === true && m.targetKind === "pr";
	const lines = [
		"pi-review dry run",
		`input: ${m.targetLabel}`,
		`mode: ${parsed.lite ? "lite (single agent, no gate)" : `agent-fetch (${m.targetKind})`}`,
		`runId: ${m.runId}`,
		prDryRun ? "workspace: not cloned (dry run)" : `workspace: ${m.workspacePath}`,
		`diff sha256: ${m.diffSha256.slice(0, 16)}…`,
		`changed files: ${m.changedFiles.length}`,
		`docsOnly: ${m.docsOnly}`,
		prDryRun ? "historyAvailable: not computed (dry run)" : `historyAvailable: ${m.historyAvailable}`,
		`threshold: ${gate.threshold}`,
		`gate: ${gate.enabled ? `yes (${resolveModel(gate.model, undefined)})` : "no"}`,
	];
	if (prDryRun) lines.push("rules: not computed (dry run)");
	else if (m.rulePaths.length > 0) lines.push(`rules: ${m.rulePaths.join(", ")}`);
	return lines.join("\n");
}
