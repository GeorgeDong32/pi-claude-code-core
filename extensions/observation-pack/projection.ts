/**
 * Pure context-projection step (arch B5, SPEC OBS-01..10 + CMP-04).
 *
 * Everything the mechanism does per provider request, expressed as a pure
 * function over injected ports: the candidate loop, the send-count recovery
 * heuristic, the FULL_SENDS/placeholder decision, the sentinel streak, and
 * the OBS-09 counters. No pi runtime, no bus, no console — the adapter in
 * index.ts owns those side effects (CON-03/04 keep pinning the wiring
 * end-to-end; node:test drives this step directly).
 *
 * Port discipline (three side-effect channels, nothing else):
 *   - store(observation)       → observation storage (ensureStored in prod)
 *   - appendLedger(entry)      → the append-only audit trail
 *   - and the OUTCOME carries everything the adapter must emit:
 *     failOpenReasons (console.error), sentinelWarning (console.warn),
 *     counters (coreBus publish).
 *
 * invariant 9 (never edits history): the projection only ever REPLACES the
 * `content` array of an eligible tool-result message (spread-copied); every
 * other message passes through BY REFERENCE — pinned by identity tests.
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";

import {
	createObservation,
	estimateTokens,
	FULL_SENDS,
	isPureTextResult,
	placeholderFor,
	type Observation,
} from "./observation.ts";

/** CMP-04: warn once per factory when candidates exist but nothing packs. */
export const SENTINEL_STREAK_LIMIT = 3;

export interface ProjectionPorts {
	/** Persist an observation's original bytes (idempotent, content-addressed). */
	readonly store: (observation: Observation) => Promise<void>;
	/** Append one ledger event (audit trail — write-only, see ledger.ts). */
	readonly appendLedger: (entry: Record<string, unknown>) => Promise<void>;
}

/** All mutable per-session mechanism state — owned by the adapter, one object. */
export interface ProjectionState {
	/** Requests each `${root}\0${id}` has been part of — the send authority. */
	readonly sentCounts: Map<string, number>;
	sentinelWarned: boolean;
	sentinelStreak: number;
	placeholderCount: number;
	savedTokens: number;
}

export function createProjectionState(): ProjectionState {
	return {
		sentCounts: new Map<string, number>(),
		sentinelWarned: false,
		sentinelStreak: 0,
		placeholderCount: 0,
		savedTokens: 0,
	};
}

export interface ProjectionOutcome {
	/** The projected message list (unaffected messages pass through by reference). */
	readonly messages: readonly AgentMessage[];
	/** How many messages were replaced with placeholders this request. */
	readonly replacedThisRequest: number;
	/** OBS-08 fail-open reasons, one per failed message — the adapter logs them. */
	readonly failOpenReasons: readonly string[];
	/** CMP-04 sentinel tripped this request — the adapter warns once. */
	readonly sentinelWarning: string | null;
	/** OBS-09 cumulative counters to publish, or null when nothing new. */
	readonly counters: { readonly tokensAvoided: number; readonly placeholders: number } | null;
}

export async function projectContext(args: {
	readonly messages: readonly AgentMessage[];
	readonly root: string;
	readonly state: ProjectionState;
	readonly ports: ProjectionPorts;
}): Promise<ProjectionOutcome> {
	const projected = [...args.messages];
	let replacedThisRequest = 0;
	let eligiblePastFullSends = 0;
	let firstReplacement = false;
	const failOpenReasons: string[] = [];

	// Requests each candidate has already been part of, counted by the
	// assistant messages that precede it (upstream recovery heuristic: a
	// process restarted mid-session resumes its send counts approximately).
	const priorAssistantCounts = new Array<number>(args.messages.length);
	let assistantCount = 0;
	for (let index = args.messages.length - 1; index >= 0; index -= 1) {
		priorAssistantCounts[index] = assistantCount;
		if (args.messages[index]?.role === "assistant") assistantCount += 1;
	}

	for (let index = 0; index < args.messages.length; index += 1) {
		const message = args.messages[index];
		if (!message || !isPureTextResult(message)) continue;

		try {
			const observation = createObservation(message, args.root);
			if (!observation) continue;
			await args.ports.store(observation);

			const sendCountKey = `${args.root}\0${observation.id}`;
			const previousSends = args.state.sentCounts.get(sendCountKey) ?? priorAssistantCounts[index] ?? 0;
			// CMP-04: eligibility is counted before any replacement attempt so a
			// broken store or a dropped projection still trips the sentinel.
			if (previousSends >= FULL_SENDS) eligiblePastFullSends += 1;
			if (previousSends < FULL_SENDS) {
				await args.ports.appendLedger({
					event: "full",
					id: observation.id,
					tool: observation.toolName,
					originalBytes: observation.bytes,
					originalLines: observation.lines,
					originalTokens: observation.tokens,
					contentHash: observation.contentHash,
				});
				args.state.sentCounts.set(sendCountKey, previousSends + 1);
				continue;
			}

			const placeholder = placeholderFor(observation);
			const placeholderTokens = estimateTokens(placeholder);
			const removedTokens = Math.max(0, observation.tokens - placeholderTokens);
			await args.ports.appendLedger({
				event: "placeholder",
				id: observation.id,
				sendNumber: previousSends + 1,
				tool: observation.toolName,
				originalBytes: observation.bytes,
				originalTokens: observation.tokens,
				placeholderTokens,
				removedTokens,
			});
			// invariant 9: replace ONLY the content array; the spread copy keeps
			// every other field of the original message intact.
			projected[index] = { ...message, content: [{ type: "text", text: placeholder }] };
			args.state.sentCounts.set(sendCountKey, previousSends + 1);
			replacedThisRequest += 1;
			if (previousSends === FULL_SENDS) {
				args.state.placeholderCount += 1;
				args.state.savedTokens += removedTokens;
				firstReplacement = true;
			}
		} catch (error) {
			// OBS-08 fail-open, per-message: one failure keeps that message's
			// original bytes; the rest of the loop continues.
			failOpenReasons.push(error instanceof Error ? error.message : String(error));
		}
	}

	// CMP-04 sentinel: eligible candidates but the projection produced nothing
	// — the chain broke somewhere upstream (e.g. a pi upgrade).
	let sentinelWarning: string | null = null;
	if (!args.state.sentinelWarned && eligiblePastFullSends > 0 && replacedThisRequest === 0) {
		args.state.sentinelStreak += 1;
		if (args.state.sentinelStreak >= SENTINEL_STREAK_LIMIT) {
			args.state.sentinelWarned = true;
			sentinelWarning =
				"[observation-pack] projection appears ineffective (candidates past FULL_SENDS but no placeholders) — check pi context-event semantics";
		}
	} else {
		args.state.sentinelStreak = 0;
	}

	return {
		messages: projected,
		replacedThisRequest,
		failOpenReasons,
		sentinelWarning,
		counters: firstReplacement
			? { tokensAvoided: args.state.savedTokens, placeholders: args.state.placeholderCount }
			: null,
	};
}
