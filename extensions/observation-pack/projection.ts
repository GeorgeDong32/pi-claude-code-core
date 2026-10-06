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
	/** AR1005-OB-01: the STABLE projection memo, keyed by the same
	 * `${root}\0${toolName}\0${toolCallId}` identity as `identity`. Value =
	 * the placeholder string + its token estimate — NOTHING else (no full
	 * text copy, no permanent split array). Populated at the FIRST
	 * replacement need (never during the full-send phase), reused verbatim
	 * on every later request. Lives with the state's lifecycle: different
	 * roots/tools never cross, a process restart regenerates. Survives a
	 * failed ledger append (the computation is kept; the ledger/send
	 * counts/savings are NOT committed — they retry next request). */
	readonly placeholder: Map<string, { text: string; tokens: number }>;
	/** OB test/diagnostic observable: how many times the (line-scanning)
	 * placeholder construction actually ran — one per identity per process. */
	placeholderConstructions: number;
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
	/**
	 * OBS-09 cumulative counters to publish, or null when nothing new.
	 * OBS-09-SITES: non-null counters always carry the per-site entries for
	 * the observations FIRST replaced by this request (the single-shot
	 * semantics upstream SoL-Pi flashes) — display-only, bus-side data.
	 */
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
	// OBS-09-SITES: one entry per observation FIRST replaced by this request —
	// the array's emptiness IS the old firstReplacement boolean (counters stay
	// null without it, so the publish trigger is unchanged).
	const firstReplacementSites: Array<{ tool: string; id: string; avoidedTokens: number; toolCallId?: string }> = [];
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
			// C1: analyze each candidate ONCE per process — the transcript is
			// append-only, so the same (root, toolName, toolCallId) re-appears
			// with identical bytes on every later request.
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

			// AR1005-OB-01: the placeholder is constructed ONCE per identity —
			// the head/tail complete-line excerpt scan is pure waste on every
			// later request (measured ~26 ms/request at 8 MiB). The memo is set
			// BEFORE the ledger append: a failed ledger keeps the computed
			// memo (OB-01) while the counts below stay uncommitted (OBS-08).
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
				// OBS-09-SITES: toolCallId correlates the entry with the tool row the
				// user sees (duck-read: the loop only enters for isPureTextResult
				// ToolResultMessages, but a malformed field degrades to omission,
				// never a throw).
				firstReplacementSites.push({
					tool: observation.toolName,
					id: observation.id,
					avoidedTokens: removedTokens,
					...(typeof message.toolCallId === "string" ? { toolCallId: message.toolCallId } : {}),
				});
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
		counters:
			firstReplacementSites.length > 0
				? { tokensAvoided: args.state.savedTokens, placeholders: args.state.placeholderCount, sites: firstReplacementSites }
				: null,
	};
}
