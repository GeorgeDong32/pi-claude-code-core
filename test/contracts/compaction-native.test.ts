import { describe, expect, it } from "vitest";
import { fauxAssistantMessage, fauxText, fauxThinking } from "@earendil-works/pi-ai";
import type { CompactionEntry } from "@earendil-works/pi-coding-agent";
import { compactionDraft, createCompactionHost } from "./support/compaction-host.ts";

/** Enough conversation mass for prepareCompaction to find a cut (spike finding). */
const BIG = "x".repeat(12000);

function branchCompactions(sm: { getBranch: () => Array<{ type: string }> }): CompactionEntry[] {
	return sm.getBranch().filter((e) => e.type === "compaction") as CompactionEntry[];
}

describe("SC-HOST-01 session_before_compact supply leg (H6)", () => {
	it("{compaction} supply: skips the summary LLM, appends fromHook entry, session_compact fires fromExtension:true", async () => {
		const host = await createCompactionHost({
			model: { contextWindow: 3000, maxTokens: 1000 },
			settingsOverrides: { compaction: { enabled: true, reserveTokens: 500, keepRecentTokens: 300 } },
			probe: {
				beforeCompact: (event) => ({
					compaction: {
						summary: "supplied summary",
						firstKeptEntryId: "nonexistent-entry",
						tokensBefore: 42,
						usage: undefined,
						details: { readFiles: [], modifiedFiles: [] },
					},
				}),
			},
		});
		try {
			host.faux.setResponses([fauxAssistantMessage(BIG)]);
			await host.session.prompt("grow the context");
			const beforeCompact = host.events.find((e) => e.name === "session_before_compact");
			expect(beforeCompact?.reason).toBe("threshold");
			const compactEvent = host.events.find((e) => e.name === "session_compact");
			expect(compactEvent?.fromExtension).toBe(true);
			expect(host.faux.state.callCount).toBe(1);
			const entry = branchCompactions(host.sessionManager)[0];
			expect(entry.fromHook).toBe(true);
			expect(entry.summary).toBe("supplied summary");
			// tokensBefore is taken VERBATIM from the supply on this path
			expect(entry.tokensBefore).toBe(42);
		} finally {
			host.cleanup();
		}
	});

	it("multi-handler: last non-empty result wins (H6)", async () => {
		const host = await createCompactionHost({
			model: { contextWindow: 3000, maxTokens: 1000 },
			settingsOverrides: { compaction: { enabled: true, reserveTokens: 500, keepRecentTokens: 300 } },
			probe: {
				beforeCompact: () => ({
					compaction: {
						summary: "first handler summary",
						firstKeptEntryId: "a",
						tokensBefore: 1,
						details: { readFiles: [], modifiedFiles: [] },
					},
				}),
				extraBeforeCompact: () => ({
					compaction: {
						summary: "second handler summary",
						firstKeptEntryId: "b",
						tokensBefore: 2,
						details: { readFiles: [], modifiedFiles: [] },
					},
				}),
			},
		});
		try {
			host.faux.setResponses([fauxAssistantMessage(BIG)]);
			await host.session.prompt("grow the context");
			expect(branchCompactions(host.sessionManager)[0].summary).toBe("second handler summary");
		} finally {
			host.cleanup();
		}
	});

	it("multi-handler: {cancel} short-circuits later handlers (H6)", async () => {
		let laterHandlerRan = false;
		const host = await createCompactionHost({
			model: { contextWindow: 3000, maxTokens: 1000 },
			settingsOverrides: { compaction: { enabled: true, reserveTokens: 500, keepRecentTokens: 300 } },
			probe: {
				beforeCompact: () => ({ cancel: true }),
				extraBeforeCompact: () => {
					laterHandlerRan = true;
					return undefined;
				},
			},
		});
		try {
			host.faux.setResponses([fauxAssistantMessage(BIG)]);
			await host.session.prompt("grow the context");
			expect(laterHandlerRan).toBe(false);
			expect(branchCompactions(host.sessionManager).length).toBe(0);
			expect(host.events.map((e) => e.name)).toContain("session_compact_failed");
		} finally {
			host.cleanup();
		}
	});
});

describe("SC-HOST-08 no capacity validation of extension results (H13, BLK-3 baseline)", () => {
	it("an oversized supplied compaction (~5K tokens into a 3K window) is accepted verbatim", async () => {
		const host = await createCompactionHost({
			model: { contextWindow: 3000, maxTokens: 1000 },
			settingsOverrides: { compaction: { enabled: true, reserveTokens: 500, keepRecentTokens: 300 } },
			probe: {
				beforeCompact: () => ({
					compaction: {
						summary: "y".repeat(20000),
						firstKeptEntryId: "nonexistent-entry",
						tokensBefore: 999999,
						usage: undefined,
						details: { readFiles: [], modifiedFiles: [] },
					},
				}),
			},
		});
		try {
			host.faux.setResponses([fauxAssistantMessage(BIG)]);
			await host.session.prompt("grow the context");
			// Host took it as-is: entry landed with our bytes and numbers,
			const entry = branchCompactions(host.sessionManager)[0];
			expect(entry.summary.length).toBe(20000);
			expect(entry.tokensBefore).toBe(999999);
			expect(host.events.find((e) => e.name === "session_compact")).toBeDefined();
		} finally {
			host.cleanup();
		}
	});

	it("boundary draft path equally accepts an oversized result (H13/BLK-3 draft half)", async () => {
		const host = await createCompactionHost({
			model: { contextWindow: 3000, maxTokens: 1000 },
			probe: {
				turnEndDraft: (event) => [compactionDraft("z".repeat(24000), event.messageEntryId)],
			},
		});
		try {
			host.faux.setResponses([fauxAssistantMessage("answer")]);
			await host.session.prompt("hello");
			const entry = branchCompactions(host.sessionManager)[0];
			expect(entry).toBeDefined();
			expect(entry.summary.length).toBe(24000);
		} finally {
			host.cleanup();
		}
	});
});

describe("SC-HOST-09 native summary generation does not reject stop+empty bodies (H10, BLK-5 baseline)", () => {
	it("a reasoning-only native summary lands as boilerplate-only text (E3 shape)", async () => {
		const host = await createCompactionHost({
			model: { contextWindow: 3000, maxTokens: 1000, reasoning: true },
			settingsOverrides: { compaction: { enabled: true, reserveTokens: 500, keepRecentTokens: 300 } },
			probe: {},
		});
		try {
			host.faux.setResponses([
				fauxAssistantMessage(BIG),
				fauxAssistantMessage([fauxThinking("chain of thought with no answer"), fauxText("")], { stopReason: "stop" }),
			]);
			await host.session.prompt("grow then summarize nothing");
			const entry = branchCompactions(host.sessionManager)[0];
			expect(entry).toBeDefined();
			// getSummarizationFailure only rejects error/length — a "stop" with
			expect(entry.summary).not.toContain("chain of thought");
			expect(entry.summary.trim().length).toBeLessThan(200);
			expect(entry.fromHook).toBeFalsy();
			expect(host.events.find((e) => e.name === "session_compact")).toBeDefined();
		} finally {
			host.cleanup();
		}
	});
});
