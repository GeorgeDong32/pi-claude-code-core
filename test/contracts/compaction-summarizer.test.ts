/*
 * Smart Compaction summarizer-callface host contracts (SPEC SC §4.1 H2/H14,
 * §4.3 S2/S3, §4.4 BLK-4; contract row SC-HOST-09).
 *
 * Pure-function layer: the PUBLIC compact()/generateSummaryWithUsage()
 * driven through a scripted streamFn — the only per-call observation and
 * injection point (H14). BLK-4's matrix proves the host-side gap the
 * SUM-03/04 gates must close: a split-turn summary whose turn-prefix
 * sub-call returned reasoning-only STILL merges into a whole-looking
 * string. The differential vs the dist-internal prepareCompaction oracle
 * (S2) uses a test-only deep import — production code must never do this.
 *
 * Fixture notes (spike findings, backfilled to spec §4.3):
 * - synthetic usage objects MUST carry a `cost` object — combineUsage in
 *   the split-turn merge dereferences usage.cost.input;
 * - retryAssistantCall retries RESPONSES (stopReason:"error" + retryable
 *   errorMessage), not thrown exceptions.
 */
import { describe, expect, it } from "vitest";
import {
	compact,
	findCutPoint,
	buildSessionProjection,
	SessionManager,
	type CompactionResult,
} from "@earendil-works/pi-coding-agent";
import { fauxProvider, fauxText, fauxThinking, type AssistantMessage, type Model } from "@earendil-works/pi-ai";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// S2 oracle — test-only deep import past the package exports map.
import { prepareCompaction } from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/compaction/compaction.js";

const COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
const usageOf = (output: number) => ({ input: 5, output, cacheRead: 0, cacheWrite: 0, totalTokens: 5 + output, cost: { ...COST } });

function assistantOf(text: string): AssistantMessage {
	return { role: "assistant", content: [fauxText(text)], stopReason: "stop", usage: usageOf(text.length) } as never;
}

function reasoningOnly(thinkingChars: number): AssistantMessage {
	return {
		role: "assistant",
		content: [fauxThinking("r".repeat(thinkingChars)), fauxText("")],
		stopReason: "stop",
		usage: usageOf(thinkingChars),
	} as never;
}

interface CapturedCall {
	promptText: string;
	/** Text of the first user-role message (the summarization prompt body). */
	userText: string;
	options: Record<string, unknown>;
}

/** streamFn double: classifies each call, returns scripted messages. */
function scripted(responses: Array<() => AssistantMessage>, captured: CapturedCall[]) {
	return async (_model: unknown, context: { messages?: Array<{ role: string; content?: Array<{ text?: string }> | string }> }, options: Record<string, unknown>) => {
		// Content may be a plain string (system) or content blocks (user).
		const textsByRole = (context.messages ?? []).map((m) => ({
			role: m.role,
			text: (typeof m.content === "string" ? [m.content] : (m.content ?? []).map((b) => b.text ?? "")).join(""),
		}));
		const promptText = textsByRole.map((m) => m.text).join("\n");
		const userText = textsByRole.find((m) => m.role === "user")?.text ?? "";
		captured.push({ promptText, userText, options: { ...options } });
		const produce = responses.shift();
		if (!produce) throw new Error("script exhausted");
		const message = produce();
		return { result: async () => message };
	};
}

const SPLIT_SEPARATOR = "\n\n---\n\n**Turn Context (split turn):**\n\n";

function splitPreparation() {
	const userMsg = (text: string) => ({ role: "user" as const, content: [fauxText(text)], timestamp: Date.now() });
	const preparation = {
		firstKeptEntryId: "kept-1",
		messagesToSummarize: [userMsg("history content ".repeat(50))],
		turnPrefixMessages: [userMsg("turn prefix start")],
		isSplitTurn: true,
		tokensBefore: 12345,
		previousSummary: undefined,
		fileOps: { read: new Set<string>(), written: new Set<string>(), edited: new Set<string>() },
		settings: { enabled: true, reserveTokens: 16000, keepRecentTokens: 20000 },
	};
	return preparation as unknown as never;
}

function makeModel(reasoning = true) {
	const faux = fauxProvider({ models: [{ id: "faux-1", contextWindow: 128000, maxTokens: 4096, reasoning }] });
	return { faux, model: faux.getModel() as Model<string> };
}

describe("SC-HOST-09 compact() callface (H14)", () => {
	it("split-turn issues two sub-calls with the two prompt shapes and merges with the fixed separator", async () => {
		const { model } = makeModel();
		const captured: CapturedCall[] = [];
		const result = (await compact(
			splitPreparation(),
			model as never,
			undefined,
			undefined,
			undefined,
			undefined,
			"off",
			scripted([() => assistantOf("## History\n- a"), () => assistantOf("## Prefix\n- b")], captured) as never,
		)) as CompactionResult;
		expect(captured.length).toBe(2);
		// SUM-09 classification anchors: history opens with <conversation>,
		// turn-prefix with "# Conversation" (pi-internal copy — pinned here).
		expect(captured[0].userText.startsWith("<conversation>\n")).toBe(true);
		expect(captured[1].userText.startsWith("# Conversation\n")).toBe(true);
		expect(result.summary).toBe(`## History\n- a${SPLIT_SEPARATOR}## Prefix\n- b`);
		// Merged usage combines both sub-calls' usage.
		expect(result.usage?.totalTokens).toBeGreaterThan(0);
		// The returned CompactionResult carries NO stopReason (H14).
		expect("stopReason" in (result as object)).toBe(false);
	});

	it("thinkingLevel:'off' omits the reasoning option; a level passes it through", async () => {
		const { model } = makeModel(true);
		const off: CapturedCall[] = [];
		await compact(
			splitPreparation(),
			model as never,
			undefined, undefined, undefined, undefined,
			"off",
			scripted([() => assistantOf("ok"), () => assistantOf("ok")], off) as never,
		);
		expect("reasoning" in off[0].options).toBe(false);

		const low: CapturedCall[] = [];
		await compact(
			splitPreparation(),
			model as never,
			undefined, undefined, undefined, undefined,
			"low",
			scripted([() => assistantOf("ok"), () => assistantOf("ok")], low) as never,
		);
		expect(low[0].options.reasoning).toBe("low");
	});

	it("a streamFn wrapper can inject maxTokens onto the options (S3 injection mechanics; endpoint compliance is a W9 evidence item)", async () => {
		const { model } = makeModel(true);
		const seenByDelegate: Array<Record<string, unknown>> = [];
		const wrapper = async (
			_model: unknown,
			context: { messages?: Array<{ role: string; content?: Array<{ text?: string }> | string }> },
			options: Record<string, unknown>,
		) => {
			const injected = { ...options, maxTokens: 512 };
			seenByDelegate.push(injected);
			return { result: async () => assistantOf("ok") };
		};
		const base = splitPreparation() as unknown as Record<string, unknown>;
		const prep = { ...base, isSplitTurn: false, turnPrefixMessages: [] } as never;
		await compact(prep, model as never, undefined, undefined, undefined, undefined, "off", wrapper as never);
		// pi-ai's StreamOptions declares maxTokens — the wrapper's injection is
		// type-valid and reaches the delegate unchanged.
		expect(seenByDelegate[0].maxTokens).toBe(512);
	});
});

describe("SC-HOST-09 split-turn partial-empty summaries (H10/H14, BLK-4 baseline matrix)", () => {
	const wholeLooks = (summary: string) => ({
		chars: summary.length,
		headings: (summary.match(/^##\s/gm) ?? []).length,
	});

	it("history normal + turn-prefix reasoning-only: merged string still looks whole — the gap BLK-4 pins", async () => {
		const { model } = makeModel(true);
		const result = (await compact(
			splitPreparation(),
			model as never,
			undefined, undefined, undefined, undefined, "off",
			scripted([
				() => assistantOf("## History Summary\n- point one\n- point two\n- point three with more detail"),
				() => reasoningOnly(2400),
			], []) as never,
		)) as CompactionResult;
		// The merged result passes a naive whole-summary check (non-trivial
		// length, headings present) while the turn-prefix section is EMPTY.
		const looks = wholeLooks(result.summary);
		expect(looks.chars).toBeGreaterThan(100);
		expect(looks.headings).toBeGreaterThanOrEqual(1);
		const prefixPart = result.summary.split("**Turn Context (split turn):**")[1] ?? "";
		expect(prefixPart.trim()).toBe("");
	});

	it("reverse: history reasoning-only + turn-prefix normal — same gap on the other sub-call", async () => {
		const { model } = makeModel(true);
		const result = (await compact(
			splitPreparation(),
			model as never,
			undefined, undefined, undefined, undefined, "off",
			scripted([() => reasoningOnly(2400), () => assistantOf("## Prefix\n- real content here")], []) as never,
		)) as CompactionResult;
		const [historyPart] = result.summary.split(SPLIT_SEPARATOR);
		expect(historyPart.trim()).toBe("");
	});

	it("both normal: merged summary is genuinely whole (control case)", async () => {
		const { model } = makeModel(true);
		const result = (await compact(
			splitPreparation(),
			model as never,
			undefined, undefined, undefined, undefined, "off",
			scripted([() => assistantOf("## History\n- a"), () => assistantOf("## Prefix\n- b")], []) as never,
		)) as CompactionResult;
		expect(result.summary).toContain("## History");
		expect(result.summary.split(SPLIT_SEPARATOR)[1]).toContain("## Prefix");
	});

	it("transient failure: retryAssistantCall re-enters the wrapper for the SAME logical call", async () => {
		const { model } = makeModel(true);
		let attempts = 0;
		const retryFn = async () => {
			attempts += 1;
			if (attempts === 1) {
				// A retryable error RESPONSE (not a thrown exception — the retry
				// loop only inspects responses).
				const failure = {
					role: "assistant",
					content: [fauxText("")],
					stopReason: "error",
					errorMessage: "Request terminated uncleanly",
					usage: usageOf(0),
				} as never;
				return { result: async () => failure };
			}
			return { result: async () => assistantOf("## Summary after retry\n- recovered") };
		};
		const base = splitPreparation() as unknown as Record<string, unknown>;
		const prep = { ...base, isSplitTurn: false, turnPrefixMessages: [] } as never;
		const retryPolicy = { enabled: true, maxRetries: 2, baseDelayMs: 1, maxAgentDelayMs: 100, provider: { maxRetryDelayMs: 60000 } };
		const result = (await compact(prep, model as never, undefined, undefined, undefined, undefined, "off", retryFn as never, undefined, retryPolicy as never)) as CompactionResult;
		// The wrapper saw the logical call twice; only the LAST response counts.
		expect(attempts).toBe(2);
		expect(result.summary).toContain("recovered");
	});
});

describe("SC-HOST-05 hand-built preparation vs dist oracle (H2, S2 differential)", () => {
	it("public-piece builder reproduces prepareCompaction's cut, and compact() accepts the hand-built structure", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "sc-s2-"));
		try {
			const sm = SessionManager.inMemory(cwd);
			const userMsg = (text: string) => ({ role: "user" as const, content: [{ type: "text" as const, text }], timestamp: Date.now() });
			const assistantMsg = (text: string) => ({
				role: "assistant" as const,
				content: [{ type: "text" as const, text }],
				timestamp: Date.now(),
				stopReason: "stop" as const,
				usage: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 20, cost: { ...COST } },
			});
			sm.appendMessage(userMsg("first user turn with a fairly long body of text for the summarizer") as never);
			sm.appendMessage(assistantMsg("assistant reply one ".repeat(60)) as never);
			sm.appendMessage(userMsg("second user turn ".repeat(40)) as never);
			sm.appendMessage(assistantMsg("assistant reply two ".repeat(60)) as never);
			sm.appendMessage(userMsg("third user turn, the kept tail") as never);
			sm.appendMessage(assistantMsg("final reply") as never);

			const settings = { enabled: true, reserveTokens: 16000, keepRecentTokens: 60 };
			const branch = sm.getBranch();
			const oracle = prepareCompaction(branch, settings);
			expect(oracle).toBeDefined();

			// Hand builder on PUBLIC pieces only (what W3's preparation.ts may use).
			const projection = buildSessionProjection(branch);
			const projected = projection.entries;
			const cut = findCutPoint(branch, 1, branch.length, settings.keepRecentTokens);
			const handFirstKept = projected[cut.firstKeptEntryIndex]?.sourceEntry.id;

			// The differential (S2 通过判据): cut + message slices field-by-field.
			expect(handFirstKept).toBe(oracle!.firstKeptEntryId);
			expect(cut.isSplitTurn).toBe(oracle!.isSplitTurn);
			// Hand-side message slices from the SAME public projection:
			// non-system messages of projected entries (the internal
			// getMessagesFromProjectedEntryForCompaction rule), between the
			// previous-compaction boundary and the cut.
			const prevCompactionIndex = projected.findIndex(
				(e) => (e.sourceEntry as { type?: string }).type === "compaction" && e.messages.length > 0,
			);
			const boundaryStart = prevCompactionIndex >= 0 ? prevCompactionIndex + 1 : 0;
			const historyEnd = cut.isSplitTurn ? cut.turnStartIndex : cut.firstKeptEntryIndex;
			const msgsOf = (e: (typeof projected)[number]) =>
				(e.sourceEntry as { type?: string }).type === "compaction"
					? []
					: e.messages.filter((m) => m.role !== "system");
			const handHistory = projected.slice(boundaryStart, historyEnd).flatMap(msgsOf);
			expect(handHistory).toEqual(oracle!.messagesToSummarize);
			if (cut.isSplitTurn) {
				const handPrefix = projected.slice(cut.turnStartIndex, cut.firstKeptEntryIndex).flatMap(msgsOf);
				expect(handPrefix).toEqual(oracle!.turnPrefixMessages);
			} else {
				expect(oracle!.turnPrefixMessages).toEqual([]);
			}
			// previousSummary/fileOps differential needs a prior-compaction
			// fixture and a fileOps extraction replica — owned by W3's
			// SUM-01/02 differential tests (this fixture has neither: no
			// previous compaction, no file tool calls).

			// compact() accepts a fully hand-built preparation (H2: plain data).
			const { model } = makeModel(false);
			const captured: CapturedCall[] = [];
			const result = (await compact(
				{
					firstKeptEntryId: handFirstKept!,
					messagesToSummarize: oracle!.messagesToSummarize,
					turnPrefixMessages: oracle!.turnPrefixMessages,
					isSplitTurn: oracle!.isSplitTurn,
					tokensBefore: oracle!.tokensBefore,
					previousSummary: oracle!.previousSummary,
					fileOps: oracle!.fileOps,
					settings,
				} as never,
				model as never,
				undefined, undefined, undefined, undefined, "off",
				scripted(
					[() => assistantOf("## Summary\n- a"), () => assistantOf("## Prefix\n- b")].slice(0, oracle!.isSplitTurn ? 2 : 1),
					captured,
				) as never,
			)) as CompactionResult;
			expect(result.firstKeptEntryId).toBe(handFirstKept);
			expect(captured.length).toBe(oracle!.isSplitTurn ? 2 : 1);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});
