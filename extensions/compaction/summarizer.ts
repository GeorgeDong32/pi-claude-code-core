/*
 * Smart Compaction — background summarizer (SPEC SC §5.5 SUM-03/05/06/07/08/09,
 * task W3).
 *
 * One background compute = pi's public compact() driven through OUR streamFn
 * wrapper (H14: the only per-call observation/injection point):
 *
 *   - classify every logical call by pi's prompt shapes (SUM-09, SC-HOST-09);
 *     an UNKNOWN shape never validates (⑨) — the caller degrades to shadow;
 *   - capture per-call stopReason/narrative/usage/toolCall; retry re-entries
 *     of the SAME logical call collapse to the LAST response (SUM-03③ —
 *     retryAssistantCall re-enters streamFn per attempt);
 *   - inject `maxTokens` into options when configured and drop `reasoning`
 *     when summaryThinking === "off" (S3 mechanics — pi only omits the
 *     parameter for itself when thinkingLevel:"off" is passed, our injection
 *     is belt-and-braces on the same options object);
 *   - delegate to completeSimple (the exact transport compact() uses when
 *     streamFn is absent) so the default path is behavior-identical.
 *
 * Validation (SUM-04) runs on the merged result BEFORE any ledger assembly:
 * both layers must pass or the attempt fails; one retry with hardened
 * instructions (SUM-05), then refused — the caller drives cooldown/degrade.
 * Abort (SUM-07): the signal is honored before each attempt and inside
 * compact(); aborted outcomes never throw out.
 */

import { compact } from "@earendil-works/pi-coding-agent";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai/compat";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { CompactionSettings } from "./settings.ts";
import { classifySubCall, validateAssembled, validateSubCall, type ValidationThresholds } from "./validate.ts";
import type { BuiltPreparation } from "./preparation.ts";
import type { SubCallKind, SubCallRecord } from "./types.ts";

/** What the wrapper observed for one streamFn invocation. */
interface RawCall {
	kind: SubCallKind;
	message: AssistantMessage;
}

export interface SummarizerTransport {
	/** Defaults to completeSimple (compact()'s own transport). */
	call?: (model: Model<Api>, context: unknown, options: Record<string, unknown>) => Promise<AssistantMessage>;
}

export interface SummarizerOptions {
	preparation: BuiltPreparation;
	model: Model<Api>;
	apiKey?: string;
	headers?: Record<string, string>;
	/** core settings slice (summaryThinking / summaryMaxTokens). */
	summaryThinking: CompactionSettings["summaryThinking"];
	summaryMaxTokens: number | null;
	thresholds: ValidationThresholds;
	/** SUM-08: closed ids the narrative prompt must NOT re-narrate. */
	closedIds?: string[];
	signal: AbortSignal;
	transport?: SummarizerTransport;
}

export type SummarizerOutcome =
	| {
			ok: true;
			/** compact()'s merged result (narrative + pi-appended file lists). */
			summary: string;
			usage?: Usage;
			/** Collapsed logical calls, in call order. */
			subCalls: SubCallRecord[];
			/** True when attempt 2 succeeded after a failed attempt 1. */
			retried: boolean;
	  }
	| { ok: false; reason: "validation"; failures: string[]; attempts: number }
	| { ok: false; reason: "error"; error: string; attempts: number }
	| { ok: false; reason: "aborted" };

/** Narrative text of an assistant message (text blocks only, no thinking). */
function narrativeOf(message: AssistantMessage): string {
	const content = message.content as unknown;
	if (!Array.isArray(content)) return "";
	return (content as Array<{ type?: string; text?: string }>)
		.filter((block) => block?.type === "text" && typeof block.text === "string")
		.map((block) => block.text as string)
		.join("");
}

function hasToolCall(message: AssistantMessage): boolean {
	const content = message.content as unknown;
	if (!Array.isArray(content)) return false;
	return (content as Array<{ type?: string }>).some((block) => block?.type === "toolCall");
}

function usageOf(message: AssistantMessage): SubCallRecord["usage"] {
	const usage = message.usage as { input?: number; output?: number; reasoning?: number } | undefined;
	return usage ? { input: usage.input, output: usage.output, reasoning: usage.reasoning } : undefined;
}

/**
 * Collapse raw invocations into logical calls: consecutive same-kind entries
 * are retryAssistantCall re-entries of one logical call — keep the LAST.
 */
export function collapseSubCalls(raw: RawCall[]): SubCallRecord[] {
	const out: SubCallRecord[] = [];
	for (const call of raw) {
		const record: SubCallRecord = {
			kind: call.kind,
			stopReason: call.message.stopReason ?? "stop",
			narrativeText: narrativeOf(call.message),
			hasToolCall: hasToolCall(call.message),
			usage: usageOf(call.message),
		};
		const previous = out[out.length - 1];
		if (previous && previous.kind === record.kind) out[out.length - 1] = record; // retry — last wins
		else out.push(record);
	}
	return out;
}

/** Build the observation/injection wrapper (SUM-03) around a transport. */
export function createStreamFnWrapper(
	options: { summaryMaxTokens: number | null; dropReasoning: boolean },
	observed: RawCall[],
	transport: NonNullable<SummarizerTransport["call"]>,
) {
	return async (model: Model<Api>, context: unknown, callOptions: Record<string, unknown>) => {
		// Classify by the first user-role message's opening shape (SUM-09).
		const messages = (context as { messages?: Array<{ role?: string; content?: unknown }> }).messages ?? [];
		const userText = messages.find((m) => m.role === "user");
		const text = typeof userText?.content === "string"
			? userText.content
			: Array.isArray(userText?.content)
				? (userText.content as Array<{ text?: string }>).map((b) => b.text ?? "").join("")
				: "";
		const kind = classifySubCall(text.trimStart());
		// Injection (S3): maxTokens cap + reasoning removal, then delegate.
		const injected: Record<string, unknown> = { ...callOptions };
		if (options.summaryMaxTokens !== null) injected.maxTokens = options.summaryMaxTokens;
		if (options.dropReasoning) delete injected.reasoning;
		const message = await transport(model, context, injected);
		observed.push({ kind, message });
		return { result: async () => message };
	};
}

function customInstructions(closedIds: string[] | undefined, hardened: boolean): string | undefined {
	const closed = (closedIds ?? []).filter((id) => id.length > 0).slice(0, 40);
	const lines = [
		"Create a structured checkpoint summary of the work so far.",
		"Focus on: open work and its current state, decisions made and their rationale, open questions.",
		"Do NOT re-narrate completed item ids — list them at most as one-line completions.",
	];
	if (closed.length > 0) lines.push(`Already completed (do not re-narrate): ${closed.join(", ")}.`);
	if (hardened) {
		lines.push("CRITICAL: your previous attempt was empty, truncated or reasoning-only. You MUST output a complete summary with at least two markdown section headings and substantive narrative prose.");
	}
	return lines.join("\n");
}

/** Run the compute (attempts ≤ 2, SUM-05). Never throws for abort reasons. */
export async function runSummarizer(input: SummarizerOptions): Promise<SummarizerOutcome> {
	const transport = input.transport?.call ?? ((model: Model<Api>, context: unknown, options: Record<string, unknown>) =>
		completeSimple(model, context as never, options as never) as unknown as Promise<AssistantMessage>);
	const dropReasoning = input.summaryThinking === "off";
	let attempts = 0;
	let lastFailures: string[] = [];
	while (attempts < 2) {
		if (input.signal.aborted) return { ok: false, reason: "aborted" };
		attempts += 1;
		const observed: RawCall[] = [];
		const wrapper = createStreamFnWrapper(
			{ summaryMaxTokens: input.summaryMaxTokens, dropReasoning },
			observed,
			transport,
		);
		try {
			const result = await compact(
				input.preparation as never,
				input.model,
				input.apiKey,
				input.headers,
				customInstructions(input.closedIds, attempts > 1),
				input.signal,
				input.summaryThinking === "default" ? undefined : input.summaryThinking,
				wrapper as never,
			);
			const subCalls = collapseSubCalls(observed);
			// Layer 1: per logical sub-call.
			const subFailures: string[] = [];
			for (let i = 0; i < subCalls.length; i += 1) {
				const verdict = validateSubCall(subCalls[i], input.thresholds);
				if (!verdict.ok) subFailures.push(...verdict.failures.map((f) => `${f}[${i}]`));
			}
			// Layer 2: assembled merged result.
			const assembled = validateAssembled(
				{
					summary: result.summary,
					isSplitTurn: input.preparation.isSplitTurn,
					hasHistory: input.preparation.messagesToSummarize.length > 0,
					subCalls,
				},
				input.thresholds,
			);
			const failures = [...subFailures, ...assembled.failures];
			if (failures.length === 0) {
				return { ok: true, summary: result.summary, usage: result.usage, subCalls, retried: attempts > 1 };
			}
			lastFailures = failures;
			if (input.signal.aborted) return { ok: false, reason: "aborted" };
			// SUM-05: one hardened retry.
		} catch (error) {
			if (input.signal.aborted) return { ok: false, reason: "aborted" };
			return { ok: false, reason: "error", error: error instanceof Error ? error.message : String(error), attempts };
		}
	}
	return { ok: false, reason: "validation", failures: lastFailures, attempts };
}

// ─── SUM-06: summary model resolution ───────────────────────────────────────

export interface SummaryModelResolution {
	model: Model<Api> | undefined;
	fallbackToSession: boolean;
	reason?: string;
}

/**
 * Resolve the configured summaryModel ("provider/id" or null = session
 * model), mirroring extensions/memory/llm.ts#resolveModelRef; when the
 * resolved model's window cannot hold the estimated input ×1.1 plus output
 * reserve, fall back to the session model (telemetry: summaryModelFallback).
 */
export function resolveSummaryModel(configured: string | null, registry: { getAll?: () => unknown[] } | undefined, inputTokens: number, sessionModel: Model<Api> | undefined): SummaryModelResolution {
	if (configured === null || configured.trim() === "") return { model: sessionModel, fallbackToSession: false };
	const key = configured.trim().toLowerCase();
	const all = (registry?.getAll?.() ?? []) as Model<Api>[];
	if (all.length === 0) return { model: sessionModel, fallbackToSession: false };
	const canonical = all.filter((m) => `${m.provider}/${m.id}`.toLowerCase() === key);
	const byId = all.filter((m) => m.id.toLowerCase() === key);
	const resolved = canonical.length === 1 ? canonical[0] : byId.length === 1 ? byId[0] : undefined;
	if (!resolved) return { model: sessionModel, fallbackToSession: false, reason: "unknown-model" };
	const window = (resolved as { contextWindow?: number }).contextWindow ?? 0;
	const outputReserve = 16_384;
	if (window > 0 && window < inputTokens * 1.1 + outputReserve) {
		return { model: sessionModel, fallbackToSession: true, reason: "window-too-small" };
	}
	return { model: resolved, fallbackToSession: false };
}
