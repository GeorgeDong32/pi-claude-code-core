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
	/** toolCallId alone is NOT unique — different tools can share call ids
	 * across messages (pi transcript data); the key adds root + toolName. */
	readonly identity: Map<string, Observation | null>;
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
