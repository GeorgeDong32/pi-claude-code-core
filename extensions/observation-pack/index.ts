// Ported from NVlabs/SoL-Pi (MIT).
import { join } from "node:path";
import { VERSION } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { assessEconomyModule, probePiCompat } from "../../lib/pi-compat.ts";
import { setFooterLine } from "../ui/footer-lines.ts";
import { coreBus } from "../bus.ts";
import { createLedger, type Ledger } from "./ledger.ts";
import {
	countLines,
	createObservation,
	ensureStored,
	estimateTokens,
	FULL_SENDS,
	isObservationId,
	isPureTextResult,
	observationPath,
	placeholderFor,
	readRecallChunk,
	readRecallSelected,
	RecallSelectionError,
	type SelectedRecall,
	RECALL_TOOL_NAME,
	THRESHOLD_BYTES,
} from "./observation.ts";
import { createProjectionState, projectContext } from "./projection.ts";
import { renderRecallCall, renderRecallResult, type RecallCallArgs } from "./renderers.ts";

const RECALL_MAX_BYTES = 16 * 1024;
const RECALL_MAX_LINES = 400;
const RECALL_HEADER_RESERVE_BYTES = 512;
const RECALL_HEADER_LINES = 2;

const RECALL_LIMITS = {
	maxBytes: RECALL_MAX_BYTES - RECALL_HEADER_RESERVE_BYTES,
	maxLines: RECALL_MAX_LINES - RECALL_HEADER_LINES,
};

export interface ObservationRoots {
	readonly root: string;
}

export function observationRootsFor(ctx: ExtensionContext): ObservationRoots {
	const sessionDir = ctx.sessionManager.getSessionDir();
	if (!sessionDir) return { root: "" };
	const sessionId = ctx.sessionManager.getSessionId();
	if (!/^[a-z0-9][a-z0-9._-]*$/iu.test(sessionId)) return { root: "" };
	return { root: join(sessionDir, "observation-pack", sessionId) };
}

export function createObservationPackExtension(hostExports: {
	version?: string;
} = {}): ExtensionFactory {
	return (pi: ExtensionAPI) => {
		const compat = probePiCompat({ version: hostExports.version ?? VERSION });
		const assessment = assessEconomyModule(compat, "observation-pack");
		if (!assessment.enabled) {
			console.warn(assessment.warning);
			pi.on("session_start", () => {
				setFooterLine("observation-pack", assessment.footerLine);
			});
			return;
		}

		const ledgers = new Map<string, Ledger>();
		const projectionState = createProjectionState();
		let noSessionWarned = false;

		const ledgerFor = (root: string): Ledger => {
			let ledger = ledgers.get(root);
			if (!ledger) {
				ledger = createLedger(join(root, "ledger.jsonl"));
				ledgers.set(root, ledger);
			}
			return ledger;
		};

		pi.registerTool({
			name: RECALL_TOOL_NAME,
			label: "Recall Observation",
			description:
				"Read a stored large tool result by observation id. Page by byte `offset`, or select first: `filter` (regex; whole-object matching lines plus `context` lines around each) or `tail` (last N lines). `offset` pages whichever selection is in effect. Selected lines carry their 1-based line number.",
			promptSnippet: "Recall a paged excerpt — or a filtered/tail selection — from a previously replaced large tool result",
			parameters: Type.Object({
				id: Type.String({ description: "Observation id from a placeholder, e.g. obs_<24 hex>" }),
				offset: Type.Optional(Type.Number({ description: "Byte offset to resume from (0 first)" })),
				filter: Type.Optional(Type.String({ description: "Regex; keep only the lines (of the whole result) that match" })),
				context: Type.Optional(Type.Number({ description: "Lines of context before/after each filter match (default 2)" })),
				tail: Type.Optional(Type.Number({ description: "Return the last N lines of the whole result" })),
			}),
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				const id = String(params.id);
				if (!isObservationId(id)) {
					return { content: [{ type: "text", text: `Unknown observation id: ${id}` }], details: {} };
				}
				const offset = Math.max(0, Number(params.offset ?? 0));
				const { root } = observationRootsFor(ctx);
				const wantsSelection = params.filter !== undefined || params.tail !== undefined;
				try {
					const chunk = wantsSelection
						? await readRecallSelected(observationPath(root, id), { offset, filter: params.filter, context: params.context, tail: params.tail }, RECALL_LIMITS)
						: await readRecallChunk(observationPath(root, id), offset, RECALL_LIMITS);
					const selected = wantsSelection ? (chunk as SelectedRecall) : null;
					const header = [
						`[obs_recall id=${id} offset=${offset} next_offset=${chunk.nextOffset} eof=${chunk.eof}]`,
						`[chunk_bytes=${chunk.bytes} chunk_lines=${chunk.lines}; use next_offset to continue]`,
						...(selected ? [selected.selection] : []),
					].join("\n");
					const text = `${header}\n${chunk.text}`;
					if (Buffer.byteLength(text, "utf8") > RECALL_MAX_BYTES || countLines(text) > RECALL_MAX_LINES) {
						return { content: [{ type: "text", text: "Recall output exceeded its hard limit" }], details: { id, offset } };
					}
					const base = { id, offset, bytes: chunk.bytes, lines: chunk.lines, nextOffset: chunk.nextOffset, eof: chunk.eof };
					const details = selected
						? { ...base, filter: params.filter, tail: params.tail, matchedLines: selected.matchedLines, totalLines: selected.totalLines }
						: base;
					return { content: [{ type: "text", text }], details };
				} catch (error) {
					if (error instanceof RecallSelectionError) {
						return { content: [{ type: "text", text: `obs_recall: ${error.message}` }], details: { id, offset, filter: params.filter, tail: params.tail } };
					}
					const reason = error instanceof Error ? error.message : String(error);
					return { content: [{ type: "text", text: `Unknown observation id: ${id} (${reason})` }], details: { id } };
				}
			},
			renderCall: (args, theme) => renderRecallCall(args as RecallCallArgs, theme as never),
			renderResult: (result, options, theme, context) =>
				renderRecallResult(result, options as { isError?: boolean; isPartial?: boolean; expanded?: boolean }, theme as never, (context as { lastComponent?: unknown }).lastComponent),
		});

		pi.on("context", async (event, ctx) => {
			try {
				const { root } = observationRootsFor(ctx);
				if (!root) {
					if (!noSessionWarned) {
						noSessionWarned = true;
						console.warn("[observation-pack] no persistent session directory; projection disabled for this session");
					}
					return undefined;
				}

				const outcome = await projectContext({
					messages: event.messages,
					root,
					state: projectionState,
					ports: {
						store: ensureStored,
						appendLedger: ledgerFor(root),
					},
				});
				for (const reason of outcome.failOpenReasons) {
					console.error(`[observation-pack] fail-open for tool result: ${reason}`);
				}
				if (outcome.sentinelWarning !== null) console.warn(outcome.sentinelWarning);
				if (outcome.counters !== null) {
					coreBus().publish({
						observation: {
							tokensAvoided: outcome.counters.tokensAvoided,
							placeholders: outcome.counters.placeholders,
							sites: outcome.counters.sites,
						},
					});
				}
				return { messages: [...outcome.messages] };
			} catch (error) {
				try {
					console.error(`[observation-pack] context projection failed open: ${error instanceof Error ? error.message : String(error)}`);
				} catch {
				}
				return undefined;
			}
		});
	};
}

export default createObservationPackExtension;
