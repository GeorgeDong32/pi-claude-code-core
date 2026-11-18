/**
 * Pure context-projection step (arch B5, SPEC OBS-01..10 + CMP-04).
 *
 * Everything the mechanism does per provider request, expressed as a pure
 * function over injected ports: the candidate loop, the send-count recovery
 * heuristic, the FULL_SENDS/placeholder decision, the sentinel streak, and
 * the OBS-09 counters (cumulative) plus their OBS-09-SITES per-site payload:
 * display-only data for the first-replacement requests — it rides the
 * capability bus and never enters the projected messages (invariant 9).
 * Each site entry carries the source message's toolCallId: the projection
 * only rewrites the provider request, so toolCallId is the ONLY key that
 * correlates a site with the tool row the user sees. No pi runtime, no bus, no console — the adapter in
 * index.ts owns those side effects (CON-03/04 keep pinning the wiring
 * end-to-end; node:test drives this step directly).
 *
 * BH-E3 (2026-11-14, spec 2026-11-14-backtest-hardening): obs_recall results
 * are exempt from projection entirely (they are themselves bounded recall
 * excerpts — packing them again nests packs inside packs); the placeholder
 * ledger row is written once per object id per process (per-request rows
 * ballooned session ledgers to 43 MB); and the candidate check sits inside
 * the per-message fail-open try, so even a malformed message fails open.
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
	RECALL_TOOL_NAME,
	type Observation,
} from "./observation.ts";

export const SENTINEL_STREAK_LIMIT = 3;

export interface ProjectionPorts {
	readonly store: (observation: Observation) => Promise<void>;
	readonly appendLedger: (entry: Record<string, unknown>) => Promise<void>;
}

export interface ProjectionState {
	readonly sentCounts: Map<string, number>;
	/** C1 (arch review 2026-10-03): candidate identity memo, key
	 * `${root}\0${toolName}\0${toolCallId}` (toolCallId alone is NOT unique —
	 * different tools can share call ids across messages). value = the
	 * memoized Observation, or null = already judged ineligible
	 * (<THRESHOLD_BYTES / reducer receipt) — never re-analyzed. Premise:
	 * a tool result is immutable once in the transcript (append-only
	 * history; invariant 9 only ever rewrites the projection copy), so the
	 * per-request join/byteLength/2×sha256/countLines work is pure waste
	 * after the first request. Retention cost (code review R1 P3-2): each
	 * entry holds the Observation INCLUDING its full text — roughly 2x the
	 * bytes those large results already occupy in the session, held for the
	 * session's lifetime and NOT reclaimed at compaction (proportional to
	 * eligible-result volume; accepted). */
	readonly identity: Map<string, Observation | null>;
	/** C1: observation ids already stored through ports.store. Skips the
	 * EEXIST full-read + re-hash verification on every later request.
	 * Disclosure: after the first successful store, an object file corrupted
	 * externally mid-session no longer surfaces via that verification —
	 * accepted (content-addressed, write-once objects). A FAILED store is
	 * not memoized here, so the per-message fail-open retry semantics
	 * (OBS-08) are unchanged. */
	readonly stored: Set<string>;
	readonly placeholder: Map<string, { text: string; tokens: number }>;
	placeholderConstructions: number;
	readonly placeholderLedgered: Set<string>;
	sentinelWarned: boolean;
	sentinelStreak: number;
	placeholderCount: number;
	savedTokens: number;
}

export function createProjectionState(): ProjectionState {
	return {
		sentCounts: new Map<string, number>(),
		identity: new Map<string, Observation | null>(),
		stored: new Set<string>(),
		placeholder: new Map<string, { text: string; tokens: number }>(),
		placeholderConstructions: 0,
		placeholderLedgered: new Set<string>(),
		sentinelWarned: false,
		sentinelStreak: 0,
		placeholderCount: 0,
		savedTokens: 0,
	};
}

export interface ProjectionOutcome {
	readonly messages: readonly AgentMessage[];
	readonly replacedThisRequest: number;
	/** OBS-08 fail-open reasons, one per failed message — the adapter logs them. */
	readonly failOpenReasons: readonly string[];
	readonly sentinelWarning: string | null;
	readonly counters: {
		readonly tokensAvoided: number;
		readonly placeholders: number;
		readonly sites: ReadonlyArray<{ readonly tool: string; readonly id: string; readonly avoidedTokens: number; readonly toolCallId?: string }>;
	} | null;
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
	const firstReplacementSites: Array<{ tool: string; id: string; avoidedTokens: number; toolCallId?: string }> = [];
	const failOpenReasons: string[] = [];

	const priorAssistantCounts = new Array<number>(args.messages.length);
	let assistantCount = 0;
	for (let index = args.messages.length - 1; index >= 0; index -= 1) {
		priorAssistantCounts[index] = assistantCount;
		if (args.messages[index]?.role === "assistant") assistantCount += 1;
	}

	for (let index = 0; index < args.messages.length; index += 1) {
		const message = args.messages[index];
		try {
			if (!message || !isPureTextResult(message) || message.toolName === RECALL_TOOL_NAME) continue;
			const memoKey = `${args.root}\0${message.toolName}\0${message.toolCallId}`;
			let observation = args.state.identity.get(memoKey);
			if (observation === undefined) {
				observation = createObservation(message, args.root) ?? null;
				args.state.identity.set(memoKey, observation);
			}
			if (!observation) continue;
			if (!args.state.stored.has(observation.id)) {
				await args.ports.store(observation);
				args.state.stored.add(observation.id);
			}

			const sendCountKey = `${args.root}\0${observation.id}`;
			const previousSends = args.state.sentCounts.get(sendCountKey) ?? priorAssistantCounts[index] ?? 0;
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

			let memo = args.state.placeholder.get(memoKey);
			if (memo === undefined) {
				const text = placeholderFor(observation);
				memo = { text, tokens: estimateTokens(text) };
				args.state.placeholder.set(memoKey, memo);
				args.state.placeholderConstructions += 1;
			}
			const placeholder = memo.text;
			const placeholderTokens = memo.tokens;
			const removedTokens = Math.max(0, observation.tokens - placeholderTokens);
			if (!args.state.placeholderLedgered.has(sendCountKey)) {
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
				args.state.placeholderLedgered.add(sendCountKey);
			}
			projected[index] = { ...message, content: [{ type: "text", text: placeholder }] };
			args.state.sentCounts.set(sendCountKey, previousSends + 1);
			replacedThisRequest += 1;
			if (previousSends === FULL_SENDS) {
				args.state.placeholderCount += 1;
				args.state.savedTokens += removedTokens;
				firstReplacementSites.push({
					tool: observation.toolName,
					id: observation.id,
					avoidedTokens: removedTokens,
					...(typeof message.toolCallId === "string" ? { toolCallId: message.toolCallId } : {}),
				});
			}
		} catch (error) {
			failOpenReasons.push(error instanceof Error ? error.message : String(error));
		}
	}

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
		counters:
			firstReplacementSites.length > 0
				? { tokensAvoided: args.state.savedTokens, placeholders: args.state.placeholderCount, sites: firstReplacementSites }
				: null,
	};
}
