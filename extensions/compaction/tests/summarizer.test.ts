/*
 * Summarizer tests (SPEC SC §5.5 SUM-03/05/06/07/08, task W3).
 *
 * Requirement → test map:
 *   SUM-03 → "wrapper classifies / injects / collapses retries"
 *   SUM-05 → "validation failure retries once hardened, then refuses"
 *   SUM-06 → "resolveSummaryModel: null/unknown/window/session"
 *   SUM-07 → "aborted signal short-circuits without transport calls"
 *   SUM-08 → "prompt carries closed-id non-re-narration instructions"
 *   SUM-09 → classification is pinned by SC-HOST-09 (contracts) + W1
 *            validate ⑨; runtime degrade wiring lands with W4 index.
 * Transport is a scripted double (never a network call). Synthetic usage
 * objects carry `cost` (W0 fixture fact #2).
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { fauxProvider, fauxText, fauxThinking, type AssistantMessage } from "@earendil-works/pi-ai";
import type { Api, Model } from "@earendil-works/pi-ai";

import { collapseSubCalls, resolveSummaryModel, runSummarizer } from "../summarizer.ts";
import type { BuiltPreparation } from "../preparation.ts";
import type { SubCallRecord } from "../types.ts";

const COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
const usageOf = (output: number, reasoning = 0) => ({
	input: 5,
	output,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 5 + output,
	cost: { ...COST },
	...(reasoning > 0 ? { reasoning } : {}),
});

function assistantOf(text: string): AssistantMessage {
	return { role: "assistant", content: [fauxText(text)], stopReason: "stop", usage: usageOf(text.length) } as never;
}
function reasoningOnly(thinking: number): AssistantMessage {
	return { role: "assistant", content: [fauxThinking("r".repeat(thinking)), fauxText("")], stopReason: "stop", usage: usageOf(thinking, thinking) } as never;
}

function makeModel(): Model<Api> {
	const faux = fauxProvider({ models: [{ id: "faux-1", contextWindow: 128000, maxTokens: 4096, reasoning: true }] });
	return faux.getModel() as Model<Api>;
}

interface Captured {
	userText: string;
	options: Record<string, unknown>;
}

function splitPreparation(): BuiltPreparation {
	const userMsg = (text: string) => ({ role: "user" as const, content: [fauxText(text)], timestamp: Date.now() });
	return {
		firstKeptEntryId: "kept-1",
		messagesToSummarize: [userMsg("history content ".repeat(50))],
		turnPrefixMessages: [userMsg("turn prefix start")],
		isSplitTurn: true,
		tokensBefore: 12_345,
		previousSummary: undefined,
		fileOps: { read: new Set<string>(), written: new Set<string>(), edited: new Set<string>() },
		settings: { enabled: true, reserveTokens: 16000, keepRecentTokens: 20000 },
	};
}

function thresholds() {
	return { minNarrativeChars: 20, minPrefixChars: 5, maxSummaryChars: 40_000 };
}

function run(
	responses: Array<() => AssistantMessage>,
	captured: Captured[],
	over: Partial<Parameters<typeof runSummarizer>[0]> = {},
) {
	const queue = [...responses];
	return runSummarizer({
		preparation: splitPreparation(),
		model: makeModel(),
		summaryThinking: "off",
		summaryMaxTokens: 2048,
		thresholds: thresholds(),
		signal: new AbortController().signal,
		transport: {
			call: async (_model, context, options) => {
				const messages = (context as { messages?: Array<{ role?: string; content?: unknown }> }).messages ?? [];
				const user = messages.find((m) => m.role === "user");
				const text = typeof user?.content === "string"
					? user.content
					: Array.isArray(user?.content)
						? (user.content as Array<{ text?: string }>).map((b) => b.text ?? "").join("")
						: "";
				captured.push({ userText: text, options: { ...options } });
				const produce = queue.shift();
				if (!produce) throw new Error("script exhausted");
				return produce();
			},
		},
		...over,
	});
}

test("SUM-03: wrapper classifies both call shapes, injects maxTokens, drops reasoning", async () => {
	const captured: Captured[] = [];
	const outcome = await run([() => assistantOf("## History\n- a b c d"), () => assistantOf("## Prefix\n- x")], captured);
	assert.equal(outcome.ok, true);
	if (!outcome.ok) return;
	assert.deepEqual(outcome.subCalls.map((call) => call.kind), ["history", "turn-prefix"]);
	assert.equal(captured.length, 2);
	// Injection (S3 mechanics): the transport sees maxTokens and no reasoning.
	assert.equal(captured[0].options.maxTokens, 2048);
	assert.equal("reasoning" in captured[0].options, false);
	// SUM-09 anchors (mirrors SC-HOST-09): the two prompt shapes.
	assert.ok(captured[0].userText.startsWith("<conversation>"));
	assert.ok(captured[1].userText.startsWith("# Conversation"));
});

test("SUM-03③: retry re-entries of one logical call collapse to the LAST response", () => {
	const raw = [
		{ kind: "history" as const, message: assistantOf("first attempt") },
		{ kind: "history" as const, message: assistantOf("second attempt wins") },
		{ kind: "turn-prefix" as const, message: assistantOf("prefix") },
	];
	const collapsed: SubCallRecord[] = collapseSubCalls(raw);
	assert.equal(collapsed.length, 2);
	assert.equal(collapsed[0].narrativeText, "second attempt wins");
	assert.equal(collapsed[1].narrativeText, "prefix");
});

test("SUM-05: reasoning-only history fails validation → hardened retry succeeds (retried:true)", async () => {
	const captured: Captured[] = [];
	const good = "## History\n- proper narrative with real content\n\n## State\n- stable";
	const prefixOk = () => assistantOf("## Prefix\n- p");
	// Attempt 1: history reasoning-only + prefix ok. Attempt 2: both ok.
	const outcome = await run([() => reasoningOnly(4000), prefixOk, () => assistantOf(good), prefixOk], captured);
	assert.equal(outcome.ok, true);
	if (!outcome.ok) return;
	assert.equal(outcome.retried, true);
	assert.equal(captured.length, 4); // split ⇒ 2 sub-calls per attempt
	// SUM-08 hardened text rides attempt 2's history prompt (index 2).
	assert.match(captured[2].userText, /MUST output a complete summary/);
	assert.doesNotMatch(captured[0].userText, /MUST output a complete summary/);
});

test("SUM-05: both attempts invalid → refused with the failing gates", async () => {
	const captured: Captured[] = [];
	const prefixOk = () => assistantOf("## Prefix\n- p");
	const outcome = await run(
		[() => reasoningOnly(4000), prefixOk, () => reasoningOnly(5000), prefixOk],
		captured,
	);
	assert.equal(outcome.ok, false);
	if (outcome.ok) return;
	assert.equal(outcome.reason, "validation");
	assert.equal(outcome.attempts, 2);
	assert.ok(outcome.failures.some((f) => f.startsWith("sub:")));
});

test("SUM-08: the narrative prompt carries closed-id non-re-narration instructions", async () => {
	const captured: Captured[] = [];
	const outcome = await run(
		[() => assistantOf("## History\n- narrative body here"), () => assistantOf("## Prefix\n- p")],
		captured,
		{ closedIds: ["r5", "r6"] },
	);
	assert.equal(outcome.ok, true);
	assert.match(captured[0].userText, /Already completed \(do not re-narrate\): r5, r6/);
	assert.match(captured[0].userText, /open work/i);
});

test("SUM-07: an aborted signal short-circuits with zero transport calls", async () => {
	const captured: Captured[] = [];
	const controller = new AbortController();
	controller.abort();
	const outcome = await run([() => assistantOf("x")], captured, { signal: controller.signal });
	assert.deepEqual(outcome, { ok: false, reason: "aborted" });
	assert.equal(captured.length, 0);
});

test("SUM-07: a transport exception surfaces as error (not swallowed, not abort)", async () => {
	const outcome = await runSummarizer({
		preparation: splitPreparation(),
		model: makeModel(),
		summaryThinking: "off",
		summaryMaxTokens: null,
		thresholds: thresholds(),
		signal: new AbortController().signal,
		transport: {
			call: async () => {
				throw new Error("socket exploded");
			},
		},
	});
	assert.equal(outcome.ok, false);
	if (outcome.ok) return;
	assert.equal(outcome.reason, "error");
	assert.match(outcome.error, /socket exploded/);
	assert.equal(outcome.attempts, 1);
});

test("SUM-06: resolveSummaryModel — null/unknown → session; small window → fallback; match → resolved", () => {
	const session = { provider: "p", id: "session-model", contextWindow: 100_000 } as unknown as Model<Api>;
	const bigModel = { provider: "zai", id: "glm-4.6", contextWindow: 200_000 };
	const miniModel = { provider: "zai", id: "glm-4.6-mini", contextWindow: 8_000 };
	const registry = { getAll: () => [bigModel, miniModel] };
	assert.equal(resolveSummaryModel(null, registry, 10_000, session).model, session);
	assert.deepEqual(resolveSummaryModel("no-such/model", registry, 10_000, session), {
		model: session,
		fallbackToSession: false,
		reason: "unknown-model",
	});
	const fallback = resolveSummaryModel("zai/glm-4.6-mini", registry, 60_000, session);
	assert.equal(fallback.model, session);
	assert.equal(fallback.fallbackToSession, true);
	assert.equal(fallback.reason, "window-too-small");
	const direct = resolveSummaryModel("zai/glm-4.6", registry, 60_000, session);
	assert.equal(direct.model, bigModel as unknown as Model<Api>);
	assert.equal(direct.fallbackToSession, false);
	// No registry → session model, no fallback flag.
	assert.equal(resolveSummaryModel("zai/glm-4.6", undefined, 60_000, session).model, session);
});
