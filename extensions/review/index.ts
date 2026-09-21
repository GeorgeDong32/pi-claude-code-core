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
 */
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

	// P2-REV-03 degradation path: /review needs pi-subagents' `subagent`
	// tool. Probe at session_start (one-time notice) and re-check live at
	// every command call (getAllTools is the source of truth — pi-subagents
	// may register after us).
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
	pi.on("session_start", () => {
		// one-time probe so a headless/console user learns about the missing
		// peer early; degradedNoticeShown is reserved for the first
		// user-visible notice on the command path
		if (!subagentToolAvailable() && !degradedNoticeShown) {
			console.log(`pi-review: ${degradationNotice()}`);
		}
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
				if (ctx.hasUI) ctx.ui.notify(msg, level);
				else console.log(`pi-review: ${msg}`);
			};

			// P2-REV-03: missing peer → clear error, everything else keeps
			// working. The install hint is a once-per-session warning; the
			// per-command error states the command was skipped.
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

				// Visible echo of the command — sent IMMEDIATELY, before the
				// (potentially minutes-long) diff/clone preparation, so the
				// user sees the command registered instead of a long silent
				// gap.
				pi.sendMessage({
					customType: "pi-review",
					content: parsed.input ? `/review ${parsed.input}` : "/review",
					display: true,
				});

				// Dry-run: print the prepared run summary without injecting the directive.
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

				// P2-BUS-01: review run is live — publish running (done comes
				// from the pi_review_report tool landing the report).
				coreBus().publish({ review: { status: "running", lastRunAt: null } });

				// Hidden directive → main agent executes as a turn.
				pi.sendMessage(
					{
						customType: "pi-review-directive",
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
			pi.sendMessage({ customType: "pi-review-agents", content: body, display: true });
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

/** Cheap human summary for `--no-spawn`. */
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
		// Dry runs must stay side-effect free (no pruning).
		cleanup: false,
	});
	if (!prepared) return "pi-review dry run: nothing to review.";
	const m = prepared.manifest;
	const gate = config.gate;
	const lines = [
		"pi-review dry run",
		`input: ${m.targetLabel}`,
		`mode: ${parsed.lite ? "lite (single agent, no gate)" : `agent-fetch (${m.targetKind})`}`,
		`runId: ${m.runId}`,
		`workspace: ${m.workspacePath}`,
		`diff sha256: ${m.diffSha256.slice(0, 16)}…`,
		`changed files: ${m.changedFiles.length}`,
		`docsOnly: ${m.docsOnly}`,
		`historyAvailable: ${m.historyAvailable}`,
		`threshold: ${gate.threshold}`,
		`gate: ${gate.enabled ? `yes (${resolveModel(gate.model, undefined)})` : "no"}`,
	];
	if (m.rulePaths.length > 0) lines.push(`rules: ${m.rulePaths.join(", ")}`);
	return lines.join("\n");
}