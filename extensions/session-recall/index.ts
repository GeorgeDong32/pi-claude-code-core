import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { Type } from "typebox";
import { defineTool, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { sessionsDirFor } from "../../lib/agent-paths.ts";
import { renderRows } from "../../lib/tool-render.ts";
import { recallTransparencyLine, sessionRecall } from "./session-recall.ts";
import { renderSessionRecallCall, sessionRecallResultRows, type SessionRecallArgs } from "./renderers.ts";

export default function sessionRecallExtension(pi: ExtensionAPI): void {
	const home = homedir();

	pi.registerTool(defineTool({
		name: "session_recall",
		label: "Session Recall",
		exposure: "codemode",
		description:
			"Search past pi sessions for this project (read-only). AND-matched query over user/assistant text. Returns matching excerpts with file/line pointers.",
		parameters: Type.Object({
			query: Type.String({ description: "Space-separated AND terms" }),
			project: Type.Optional(Type.String({ description: "Project cwd (defaults to current)" })),
			since: Type.Optional(Type.String({ description: "ISO date or -Nd (days ago)" })),
			until: Type.Optional(Type.String({ description: "ISO date" })),
			limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, description: "Max hits (default 20)" })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx: ExtensionContext) {
			const p = params as { query: string; project?: string; since?: string; until?: string; limit?: number };
			const effectiveCwd = p.project ?? ctx.cwd ?? process.cwd();
			const result = await sessionRecall({
				query: p.query,
				project: effectiveCwd,
				since: p.since,
				until: p.until,
				limit: p.limit,
				home,
			});
			const footer = `\n\n${recallTransparencyLine(result)}`;
			if (result.hits.length === 0) {
				const dir = sessionsDirFor(effectiveCwd, home);
				const text = existsSync(dir)
					? `session_recall: no matches for "${p.query}" (${result.scannedFiles} files scanned${result.skippedLines ? `, ${result.skippedLines} malformed lines skipped` : ""})${footer}`
					: `session_recall: no sessions found for ${dir}`;
				return { content: [{ type: "text", text }], details: { hits: 0, skippedLines: 0 } };
			}
			const text = result.hits
				.map(
					(h) =>
						`[${h.file}:${h.line}] ${h.role}${h.timestamp ? ` @ ${h.timestamp}` : ""}:\n${h.text.slice(0, 500)}`,
				)
				.join("\n\n");
			return {
				content: [{ type: "text", text: `session_recall: ${result.hits.length} hit(s)\n\n${text}${footer}` }],
				details: { hits: result.hits.length, skippedLines: result.skippedLines },
			};
		},
		renderCall: (args, theme) => renderSessionRecallCall(args as SessionRecallArgs, theme as never),
		renderResult: (result, _options, theme) =>
			renderRows(sessionRecallResultRows(result), theme as never),
	}));
}
