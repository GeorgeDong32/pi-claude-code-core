/**
 * Thin wrapper that adapts `runReportTool` to `pi.registerTool`. The tool
 * loads the manifest, validates the workflow return value's reviewer/gate
 * structuredOutput, runs the deterministic verdict + report builder, and
 * persists a session entry.
 *
 * v0.8.6 (user decision): the tool no longer pushes the report into chat as
 * a rendered card. The result text carries the FULL markdown plus an
 * instruction to output it verbatim as the main agent's final chat message —
 * the report lives in the conversation as plain assistant text, not inside a
 * tool-result card.
 */
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { coreBus } from "../../bus.js";
import { runReportTool, type ReportToolSuccess } from "./report-tool.js";

/** Build the tool result text: summary anchor + verbatim-output instruction + full markdown. */
export function buildReportReply(result: ReportToolSuccess): string {
	const t = result.report.totals.bySeverity;
	const summary = `pi-review result: ${result.verdict} · ${t.blocker} blocker · ${t.major} major · ${t.minor} minor · ${t.nit} nit`;
	return [
		summary,
		"",
		`Report finalized and persisted (runId ${result.runId}). Now output the FULL markdown below verbatim as your final chat message — every line unchanged, no summarizing, no reformatting, no extra commentary before or after. The chat message IS the user's report.`,
		"",
		result.markdown,
	].join("\n");
}

export function registerReviewReportTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "pi_review_report",
		label: "pi-review Report",
		description:
			"Finalize a pi-review run. Inputs: runId + the workflow return value from the reviewer's `runs.all`/`runs.run` call. Loads the manifest, enforces the verdict in code, persists a session entry, and returns the report markdown — which you must then output verbatim as your final chat message.",
		parameters: Type.Object({
			runId: Type.String({ description: "Run id from the prepared manifest (e.g. 'xyz123-abc')." }),
			workflowReturn: Type.Any({
				description: "The workflow return value `{ reviewers, gate }` from the most recent subagent() call.",
			}),
			threshold: Type.Optional(Type.Integer({ minimum: 0, maximum: 10 })),
			verdictPolicy: Type.Optional(Type.Union([
				Type.Literal("strict"),
				Type.Literal("legacy"),
			])),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const result = runReportTool({
				runId: params.runId,
				workflowReturn: params.workflowReturn,
				threshold: params.threshold,
				verdictPolicy: params.verdictPolicy,
				cwd: ctx.cwd,
			});
			if (!result.ok) {
				return {
					content: [{ type: "text", text: `pi_review_report failed: ${result.error}` }],
					details: { error: result.error },
				};
			}
			// P2-BUS-01: the report landed — publish done on the bus.
			try {
				coreBus().publish({ review: { status: "done", lastRunAt: Date.now() } });
			} catch {
				/* bus publish is best-effort */
			}
			// Persist a session entry so `/review-show` can re-render the report
			// later and old sessions replay their cards.
			try {
				pi.appendEntry("pi-review", {
					runId: result.runId,
					verdict: result.verdict,
					markdown: result.markdown,
					report: result.report,
					createdAt: Date.now(),
				});
			} catch {
				// appendEntry is best-effort; the agent still has the markdown.
			}
			return {
				content: [{ type: "text", text: buildReportReply(result) }],
				details: { runId: result.runId, verdict: result.verdict, report: result.report },
			};
		},
	});
}
