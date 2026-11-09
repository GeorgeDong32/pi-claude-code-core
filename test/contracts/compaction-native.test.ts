/*
 * Smart Compaction native-path host contracts (SPEC SC §4.1 H6/H10/H13,
 * §4.4 BLK-3/BLK-5 baselines; contract rows SC-HOST-01/08).
 *
 * These pin the session_before_compact supply leg against a REAL
 * AgentSession + faux provider (H16 scaffold): last-non-empty-wins, cancel
 * short-circuit, no summary LLM on supply, NO capacity validation of
 * extension results, and the native path landing an effectively-empty
 * (reasoning-only) summary. Baselines are green NOW — the protected
 * counterparts are expected-failures in compaction-protection.test.ts
 * until W3/W4 land.
 */
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
			// Threshold fired with our supply…
			const beforeCompact = host.events.find((e) => e.name === "session_before_compact");
			expect(beforeCompact?.reason).toBe("threshold");
			const compactEvent = host.events.find((e) => e.name === "session_compact");
			expect(compactEvent?.fromExtension).toBe(true);
			// …and the summary LLM was skipped: only the one conversation call.
			expect(host.faux.state.callCount).toBe(1);
			const entry = branchCompactions(host.sessionManager)[0];
			expect(entry.fromHook).toBe(true);
			expect(entry.summary).toBe("supplied summary");
			// tokensBefore is taken VERBATIM from the supply on this path
			// (unlike the draft path where the host re-estimates).
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
			// Cancelled compaction: no compaction entry, session_compact_failed fired.
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
						// ~5000 estimated tokens of summary — far beyond the 3K window.
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
			// session_compact reported success. The host does not fit-check
			// extension results — V8a's job (INV-12), pinned as expected-fail
			// in compaction-protection.test.ts.
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
				turnEndDraft: (event) => [compactionDraft("z".repeat(24000) /* ~6K tokens > 3K window */, event.messageEntryId)],
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
				// The summary call: thinking only, empty body, stopReason "stop".
				fauxAssistantMessage([fauxThinking("chain of thought with no answer"), fauxText("")], { stopReason: "stop" }),
			]);
			await host.session.prompt("grow then summarize nothing");
			const entry = branchCompactions(host.sessionManager)[0];
			expect(entry).toBeDefined();
			// getSummarizationFailure only rejects error/length — a "stop" with
			// an empty body passes and is persisted (H10). In this fixture the
			// cut is split-turn, so what lands is the fixed separator plus an
			// empty turn-prefix section — no narrative at all.
			expect(entry.summary).not.toContain("chain of thought");
			expect(entry.summary.trim().length).toBeLessThan(200);
			expect(entry.fromHook).toBeFalsy();
			// session_compact reported success — nothing flagged the emptiness.
			expect(host.events.find((e) => e.name === "session_compact")).toBeDefined();
		} finally {
			host.cleanup();
		}
	});
});
