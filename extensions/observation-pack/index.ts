/*
 * ObservationPack core module (SPEC OBS-01..10).
 *
 * Keeps large tool results reachable without replaying them: a pure-text
 * tool result larger than THRESHOLD_BYTES is sent in full for its first
 * FULL_SENDS provider requests, then the projection replaces it with a short
 * stable placeholder; the original bytes live in a per-session store and the
 * agent pages them back with `obs_recall`.
 *
 * The mechanism never edits history: it rewrites only the projection layer
 * (`pi.on("context")`), so the transcript, the TUI rendering, native
 * compaction and session resume are all unaffected.
 *
 * Ported from NVlabs/SoL-Pi (MIT) with three core-side changes (PORT §7.5):
 * storage root derived via sessionManager public API; the SoL-Pi TUI banner
 * replaced by a capability-bus patch; a request-level sentinel that warns
 * when the projection stops taking effect (CMP-04).
 */
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
	/** Per-session observation root; empty string = no persistent session. */
	readonly root: string;
}

/** OBS-03: core storage topology (sessionManager public API, no SoL-Pi runtime module). */
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
		// CMP-02 version gate: degrade, never block the session. B4: the tail
		// is the shared helper — version-only probing stays noise-free.
		const compat = probePiCompat({ version: hostExports.version ?? VERSION });
		// P1-1 §4.4 (F2): pure assessment — warn at LOAD time, publish the
		// footer line from the FIRST session_start (bus invariant 3).
		const assessment = assessEconomyModule(compat, "observation-pack");
		if (!assessment.enabled) {
			console.warn(assessment.warning);
			pi.on("session_start", () => {
				setFooterLine("observation-pack", assessment.footerLine);
			});
			return;
		}

		const ledgers = new Map<string, Ledger>();
		// B5: ALL mutable mechanism state lives in one object owned by this
		// factory instance (was module-global — leaked across tests).
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
			name: "obs_recall",
			label: "Recall Observation",
			description: "Read a stored large tool result by observation id and byte offset.",
			promptSnippet: "Recall a paged excerpt from a previously replaced large tool result",
			parameters: Type.Object({
				id: Type.String({ description: "Observation id from a placeholder, e.g. obs_<24 hex>" }),
				offset: Type.Optional(Type.Number({ description: "Byte offset to resume from (0 first)" })),
			}),
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				const id = String(params.id);
				if (!isObservationId(id)) {
					return { content: [{ type: "text", text: `Unknown observation id: ${id}` }], details: {} };
				}
				const offset = Math.max(0, Number(params.offset ?? 0));
				const { root } = observationRootsFor(ctx);
				try {
					const chunk = await readRecallChunk(observationPath(root, id), offset, RECALL_LIMITS);
					// Upstream protocol: the paging header must live in the model-visible
					// text — details never reach the provider request, and the placeholder
					// promises "continue with returned next_offset".
					const header = [
						`[obs_recall id=${id} offset=${offset} next_offset=${chunk.nextOffset} eof=${chunk.eof}]`,
						`[chunk_bytes=${chunk.bytes} chunk_lines=${chunk.lines}; use next_offset to continue]`,
					].join("\n");
					const text = `${header}\n${chunk.text}`;
					if (Buffer.byteLength(text, "utf8") > RECALL_MAX_BYTES || countLines(text) > RECALL_MAX_LINES) {
						return { content: [{ type: "text", text: "Recall output exceeded its hard limit" }], details: { id, offset } };
					}
					return {
						content: [{ type: "text", text }],
						details: { id, offset, bytes: chunk.bytes, lines: chunk.lines, nextOffset: chunk.nextOffset, eof: chunk.eof },
					};
				} catch (error) {
					const reason = error instanceof Error ? error.message : String(error);
					return { content: [{ type: "text", text: `Unknown observation id: ${id} (${reason})` }], details: { id } };
				}
			},
			// TR A: human-shaped rows — the model protocol (paging header,
			// retrieve instruction) is stripped from what the user sees; the
			// preview budget goes to the CONTENT. Read-only over details+text.
			renderCall: (args, theme) => renderRecallCall(args as RecallCallArgs, theme as never),
			renderResult: (result, options, theme, context) =>
				renderRecallResult(result, options as { isError?: boolean; isPartial?: boolean; expanded?: boolean }, theme as never, (context as { lastComponent?: unknown }).lastComponent),
		});

		pi.on("context", async (event, ctx) => {
			// B5: thin adapter — the projection itself is a pure step over
			// injected ports (projection.ts); this handler only resolves the
			// session root, wires the ports, and emits the outcome's side
			// effects (console / bus). CON-03 pins the fail-open contract,
			// CON-04 pins the final-slot registration order.
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
				// OBS-09: cumulative avoided tokens on the capability bus.
				// OBS-09-SITES: per-site display-only savings for the
				// first-replacement requests (never in the projection itself).
				coreBus().publish({
					observation: {
						tokensAvoided: outcome.counters.tokensAvoided,
						placeholders: outcome.counters.placeholders,
						sites: outcome.counters.sites,
					},
				});
			}
			return { messages: [...outcome.messages] };
		});
	};
}

export default createObservationPackExtension;
