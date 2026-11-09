/*
 * W0 scratch spike #3: BLK-4 (split-turn partial-empty summaries through
 * public compact() with a scripted streamFn), S2 (hand-built preparation vs
 * dist-internal prepareCompaction oracle), S3 (thinkingLevel:"off" → no
 * reasoning option; maxTokens injection through the streamFn wrapper).
 * Throwaway driver.
 */
import {
	compact,
	estimateTokens,
	findCutPoint,
	buildSessionProjection,
	SettingsManager,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { fauxProvider, fauxText, fauxThinking } from "@earendil-works/pi-ai";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// Test-only oracle deep import (S2 differential; production code must NOT do this).
import { prepareCompaction } from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/compaction/compaction.js";

interface CapturedCall {
	promptHead: string;
	options: Record<string, any>;
}

/** streamFn double: records each call, returns scripted AssistantMessages. */
function scriptedStreamFn(responses: Array<() => any>, captured: CapturedCall[], delegate?: (options: any) => any) {
	return async (model: any, context: any, options: any) => {
		captured.push({
			promptHead: String(context.messages?.[0]?.content?.[0]?.text ?? "").slice(0, 40),
			options: { ...options },
		});
		delegate?.(options);
		const produce = responses.shift() ?? (() => fauxText("fallback"));
		const message = produce();
		console.log("  [streamFn] call", captured.length, "stopReason:", (message as any).stopReason, "hasUsage:", (message as any).usage !== undefined);
		return { result: async () => message };
	};
}

function assistantMsg(text: string, stopReason: "stop" | "length" | "error" = "stop") {
	return {
		role: "assistant" as const,
		content: [{ type: "text" as const, text }],
		timestamp: Date.now(),
		stopReason,
		usage: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 20, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
	};
}

function userMsg(text: string) {
	return { role: "user" as const, content: [{ type: "text" as const, text }], timestamp: Date.now() };
}

/** Build a real SessionManager branch (user/assistant/toolResult interleaved). */
function buildBranchSession(cwd: string) {
	const sm = SessionManager.inMemory(cwd);
	sm.appendMessage(userMsg("first user turn with a fairly long body of text to give the summarizer something to eat") as never);
	sm.appendMessage(assistantMsg("assistant reply one ".repeat(60)) as never);
	sm.appendMessage(userMsg("second user turn ".repeat(40)) as never);
	sm.appendMessage(assistantMsg("assistant reply two ".repeat(60)) as never);
	sm.appendMessage(userMsg("third user turn, the kept tail") as never);
	sm.appendMessage(assistantMsg("final reply") as never);
	return sm;
}

async function blk4() {
	const faux = fauxProvider({ models: [{ id: "faux-1", contextWindow: 128000, maxTokens: 4096, reasoning: true }] });
	const model = faux.getModel();
	const preparation = {
		firstKeptEntryId: "kept-1",
		messagesToSummarize: [userMsg("history content ".repeat(200)), assistantMsg("history answer ".repeat(100))],
		turnPrefixMessages: [userMsg("turn prefix start"), assistantMsg("prefix middle ".repeat(20)), { role: "toolResult" as const, toolCallId: "tc1", toolName: "bash", content: [{ type: "text" as const, text: "tool output" }], isError: false }],
		isSplitTurn: true,
		tokensBefore: 12345,
		previousSummary: undefined,
		fileOps: { read: new Set<string>(), written: new Set<string>(), edited: new Set<string>() },
		settings: { enabled: true, reserveTokens: 16000, keepRecentTokens: 20000 },
	};

	// Case 1: history normal + turn-prefix reasoning-only.
	const captured: CapturedCall[] = [];
	const result1 = await compact(
		preparation as never,
		model as never,
		undefined,
		undefined,
		undefined,
		undefined,
		"off",
		scriptedStreamFn(
			[
				() => fauxAssistantOf("## History Summary\n- point one\n- point two\n- point three with more detail"),
				() => reasoningOnly(),
			],
			captured,
		) as never,
	);
	console.log("BLK4-1 summary chars:", result1.summary.length, "captured:", captured.map((c) => c.promptHead.slice(0, 16)));
	console.log("BLK4-1 merged head:", JSON.stringify(result1.summary.slice(0, 120)));
	console.log("BLK4-1 contains turn-context separator:", result1.summary.includes("**Turn Context (split turn):**"));
	console.log("BLK4-1 prefix part empty:", JSON.stringify(result1.summary.split("**Turn Context (split turn):**")[1]?.trim().slice(0, 60)));

	// Case 4: transient failure → retryAssistantCall re-entry into streamFn.
	// retryAssistantCall retries RESPONSES (stopReason:"error" + retryable
	// errorMessage), not thrown exceptions — the wrapper sees the same logical
	// call twice. Retry policy must be enabled.
	const captured4: CapturedCall[] = [];
	let attempt = 0;
	const retryFn = async (_model: any, _context: any, _options: any) => {
		attempt += 1;
		captured4.push({ promptHead: "call", options: {} });
		if (attempt === 1) {
			return {
				result: async () => ({
					role: "assistant",
					content: [{ type: "text", text: "" }],
					stopReason: "error",
					errorMessage: "Request terminated uncleanly",
					usage: { input: 5, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 5, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				}),
			};
		}
		return { result: async () => fauxAssistantOf("## Summary after retry\n- recovered") };
	};
	const prepNoSplit = { ...preparation, isSplitTurn: false, turnPrefixMessages: [] };
	const retryPolicy = { enabled: true, maxRetries: 2, baseDelayMs: 1, maxAgentDelayMs: 100, provider: { maxRetryDelayMs: 60000 } };
	const result4 = await compact(prepNoSplit as never, model as never, undefined, undefined, undefined, undefined, "off", retryFn as never, undefined, retryPolicy as never);
	console.log("BLK4-4 attempts:", attempt, "summary chars:", result4.summary.length);
}

function fauxAssistantOf(text: string) {
	return { role: "assistant", content: [{ type: "text", text }], stopReason: "stop", usage: { input: 5, output: 100, cacheRead: 0, cacheWrite: 0, totalTokens: 105, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } as never;
}

function reasoningOnly() {
	return {
		role: "assistant",
		content: [fauxThinking("long reasoning ".repeat(50)), fauxText("")],
		stopReason: "stop",
		usage: { input: 5, output: 620, cacheRead: 0, cacheWrite: 0, totalTokens: 625, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
	} as never;
}

async function s2Differential() {
	const cwd = mkdtempSync(join(tmpdir(), "sc-s2-"));
	try {
		const sm = buildBranchSession(cwd);
		const settings = { enabled: true, reserveTokens: 16000, keepRecentTokens: 60 } as never;
		const branch = sm.getBranch();
		const oracle = prepareCompaction(branch, settings)!;

		// Hand builder using PUBLIC pieces only (what W3's preparation.ts may use).
		const projection = buildSessionProjection(branch);
		const projected = projection.entries;
		const sourceIds = projected.map((e: any) => e.sourceEntry.id);
		const cut = findCutPoint(branch, 1, branch.length, 60);
		const hand = {
			firstKeptEntryId: sourceIds[cut.firstKeptEntryIndex],
			isSplitTurn: cut.isSplitTurn,
			turnStartIndex: cut.turnStartIndex,
		};
		console.log("S2 oracle:", JSON.stringify({ first: oracle.firstKeptEntryId, split: oracle.isSplitTurn, msgs: oracle.messagesToSummarize.length, prefix: oracle.turnPrefixMessages.length }));
		console.log("S2 hand  :", JSON.stringify({ first: hand.firstKeptEntryId, split: hand.isSplitTurn, index: cut.firstKeptEntryIndex }));
		console.log("S2 equal firstKept:", oracle.firstKeptEntryId === hand.firstKeptEntryId, "equal split:", oracle.isSplitTurn === hand.isSplitTurn);

		// compact() must accept the oracle preparation (H2: plain data structure in).
		// The oracle chose a split cut → two scripted sub-calls.
		const faux = fauxProvider({ models: [{ id: "faux-1", contextWindow: 128000, maxTokens: 4096 }] });
		const captured: CapturedCall[] = [];
		const result = await compact(
			oracle as never,
			faux.getModel() as never,
			undefined,
			undefined,
			undefined,
			undefined,
			"off",
			scriptedStreamFn([() => fauxAssistantOf("## Summary\n- a\n- b"), () => fauxAssistantOf("## Prefix\n- c")], captured) as never,
		);
		console.log("S2 compact accepted oracle prep, chars:", result.summary.length, "firstKept kept:", result.firstKeptEntryId === oracle.firstKeptEntryId, "subcalls:", captured.length);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
}

async function s3Mechanics() {
	const faux = fauxProvider({ models: [{ id: "faux-1", contextWindow: 128000, maxTokens: 4096, reasoning: true }] });
	const preparation = {
		firstKeptEntryId: "kept-1",
		messagesToSummarize: [userMsg("s3 content"), assistantMsg("s3 answer")],
		turnPrefixMessages: [],
		isSplitTurn: false,
		tokensBefore: 100,
		fileOps: { read: new Set<string>(), written: new Set<string>(), edited: new Set<string>() },
		settings: { enabled: true, reserveTokens: 16000, keepRecentTokens: 20000 },
	};
	const captured: CapturedCall[] = [];
	await compact(preparation as never, faux.getModel() as never, undefined, undefined, undefined, undefined, "off", scriptedStreamFn([() => fauxAssistantOf("ok")], captured) as never);
	console.log("S3 thinkingLevel off → options.reasoning present:", "reasoning" in (captured[0]?.options ?? {}), "options keys:", Object.keys(captured[0]?.options ?? {}));

	// Wrapper injects maxTokens onto the options object before delegating.
	const captured2: CapturedCall[] = [];
	const seenByDelegate: any[] = [];
	const wrapper = async (model: any, context: any, options: any) => {
		captured2.push({ promptHead: "", options: { ...options } });
		const injected = { ...options, maxTokens: 512 };
		// simulate the real streamFn receiving the injected options
		return (await (async () => {
			seenByDelegate.push(injected);
			return { result: async () => fauxAssistantOf("ok") };
		})()) as never;
	};
	await compact(preparation as never, faux.getModel() as never, undefined, undefined, undefined, undefined, "off", wrapper as never);
	console.log("S3 delegate saw maxTokens:", seenByDelegate[0]?.maxTokens, "(pi-ai StreamOptions.maxTokens is a typed field — injection point is type-valid)");
}

async function main() {
	await blk4();
	await s2Differential();
	await s3Mechanics();
	console.log("SPIKE3-OK");
}

main().catch((err) => {
	console.error("SPIKE3 FAILED", err);
	process.exit(1);
});
