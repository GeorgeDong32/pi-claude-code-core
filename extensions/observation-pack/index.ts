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
import { probePiCompat } from "../../lib/pi-compat.ts";
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

const RECALL_MAX_BYTES = 16 * 1024;
const RECALL_MAX_LINES = 400;
const RECALL_HEADER_RESERVE_BYTES = 512;
const RECALL_HEADER_LINES = 2;

const RECALL_LIMITS = {
	maxBytes: RECALL_MAX_BYTES - RECALL_HEADER_RESERVE_BYTES,
	maxLines: RECALL_MAX_LINES - RECALL_HEADER_LINES,
};

/** CMP-04: warn once per process when candidates exist but nothing packs. */
const SENTINEL_STREAK_LIMIT = 3;
let sentinelWarned = false;
let sentinelStreak = 0;
let noSessionWarned = false;

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
		// CMP-02 version gate: degrade, never block the session.
		const compat = probePiCompat({ version: hostExports.version ?? VERSION });
		if (!compat.versionOk) {
			console.warn(`[observation-pack] disabled: ${compat.problems.join("; ")}`);
			coreBus().publish({ display: { footer: [`observation-pack requires pi >=0.87`] } });
			return;
		}

		const sentCounts = new Map<string, number>();
		const ledgers = new Map<string, Ledger>();
		let placeholderCount = 0;
		let savedTokens = 0;

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
		});

		pi.on("context", async (event, ctx) => {
			const { root } = observationRootsFor(ctx);
			if (!root) {
				if (!noSessionWarned) {
					noSessionWarned = true;
					console.warn("[observation-pack] no persistent session directory; projection disabled for this session");
				}
				return undefined;
			}

			const projected = [...event.messages];
			let replacedThisRequest = 0;
			let eligiblePastFullSends = 0;

			// Requests each candidate has already been part of, counted by the
			// assistant messages that precede it (upstream heuristic).
			const priorAssistantCounts = new Array<number>(event.messages.length);
			let assistantCount = 0;
			for (let index = event.messages.length - 1; index >= 0; index -= 1) {
				priorAssistantCounts[index] = assistantCount;
				if (event.messages[index]?.role === "assistant") assistantCount += 1;
			}

			for (let index = 0; index < event.messages.length; index += 1) {
				const message = event.messages[index];
				if (!message || !isPureTextResult(message)) continue;

				try {
					const observation = createObservation(message, root);
					if (!observation) continue;
					await ensureStored(observation);

					const sendCountKey = `${root}\0${observation.id}`;
					const previousSends = sentCounts.get(sendCountKey) ?? priorAssistantCounts[index] ?? 0;
					// CMP-04: eligibility is counted before any replacement attempt so a
					// broken store or a dropped projection still trips the sentinel.
					if (previousSends >= FULL_SENDS) eligiblePastFullSends += 1;
					if (previousSends < FULL_SENDS) {
						await ledgerFor(root)({
							event: "full",
							id: observation.id,
							tool: observation.toolName,
							originalBytes: observation.bytes,
							originalLines: observation.lines,
							originalTokens: observation.tokens,
							contentHash: observation.contentHash,
						});
						sentCounts.set(sendCountKey, previousSends + 1);
						continue;
					}

					const placeholder = placeholderFor(observation);
					const placeholderTokens = estimateTokens(placeholder);
					const removedTokens = Math.max(0, observation.tokens - placeholderTokens);
					await ledgerFor(root)({
						event: "placeholder",
						id: observation.id,
						sendNumber: previousSends + 1,
						tool: observation.toolName,
						originalBytes: observation.bytes,
						originalTokens: observation.tokens,
						placeholderTokens,
						removedTokens,
					});
					projected[index] = { ...message, content: [{ type: "text", text: placeholder }] };
					sentCounts.set(sendCountKey, previousSends + 1);
					replacedThisRequest += 1;
					if (previousSends === FULL_SENDS) {
						placeholderCount += 1;
						savedTokens += removedTokens;
						// OBS-09: cumulative avoided tokens on the capability bus.
						coreBus().publish({ observation: { tokensAvoided: savedTokens, placeholders: placeholderCount } });
					}
				} catch (error) {
					// OBS-08 fail-open, per-message: one failure keeps that
					// message's original bytes; the rest of the loop continues.
					const reason = error instanceof Error ? error.message : String(error);
					console.error(`[observation-pack] fail-open for tool result: ${reason}`);
				}
			}

			// CMP-04 sentinel: eligible candidates but the projection produced
			// nothing — the chain broke somewhere upstream (e.g. a pi upgrade).
			if (!sentinelWarned && eligiblePastFullSends > 0 && replacedThisRequest === 0) {
				// Counted per provider request; warn once per process.
				sentinelStreak += 1;
				if (sentinelStreak >= SENTINEL_STREAK_LIMIT) {
					sentinelWarned = true;
					console.warn("[observation-pack] projection appears ineffective (candidates past FULL_SENDS but no placeholders) — check pi context-event semantics");
				}
			} else {
				sentinelStreak = 0;
			}

			return { messages: projected };
		});
	};
}

export default createObservationPackExtension;
