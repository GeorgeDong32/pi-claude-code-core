import { describe, expect, it } from "vitest";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import {
	calculateContextTokens,
	compact,
	createAgentSession,
	estimateTokens,
	findCutPoint,
	findTurnStartIndex,
	generateSummary,
	generateSummaryWithUsage,
	getLastAssistantUsage,
	SettingsManager,
	buildSessionProjection,
	getLatestCompactionEntry,
	serializeConversation,
	shouldCompact,
	SessionManager,
	VERSION,
} from "@earendil-works/pi-coding-agent";
import { readdirSync } from "node:fs";
import { compactionDraft, createCompactionHost } from "./support/compaction-host.ts";

describe("SC-HOST-05 public export set (H1)", () => {
	it("the compaction-relevant public exports exist", () => {
		expect(typeof compact).toBe("function");
		expect(typeof generateSummary).toBe("function");
		expect(typeof generateSummaryWithUsage).toBe("function");
		expect(typeof findCutPoint).toBe("function");
		expect(typeof findTurnStartIndex).toBe("function");
		expect(typeof estimateTokens).toBe("function");
		expect(typeof serializeConversation).toBe("function");
		expect(typeof shouldCompact).toBe("function");
		expect(typeof calculateContextTokens).toBe("function");
		expect(typeof getLastAssistantUsage).toBe("function");
		expect(typeof SettingsManager).toBe("function");
		expect(typeof buildSessionProjection).toBe("function");
		expect(typeof getLatestCompactionEntry).toBe("function");
		expect(typeof VERSION).toBe("string");
	});

	it("the package exports map rejects bare deep imports of dist internals (prepareCompaction et al. are not public)", async () => {
		// Non-literal specifiers so vite/vitest cannot statically resolve them
		// (a literal dynamic import is resolved — and rejected — at collection
		// time, which would fail the whole file instead of this assertion).
		// Node's ESM resolver enforces the exports map at runtime instead.
		const compactionSpecifier = "@earendil-works/pi-coding-agent/dist/core/compaction/compaction.js";
		const sessionSpecifier = "@earendil-works/pi-coding-agent/dist/core/agent-session.js";
		await expect(import(compactionSpecifier)).rejects.toThrow();
		await expect(import(sessionSpecifier)).rejects.toThrow();
	});
});

describe("H16 host scaffold recipe", () => {
	it("boots a real AgentSession with fauxProvider + ModelRuntime.registerNativeProvider and runs a prompt", async () => {
		const host = await createCompactionHost({ probe: {} });
		try {
			expect(host.sessionManager instanceof SessionManager).toBe(true);
			host.faux.setResponses([fauxAssistantMessage("boots fine")]);
			await host.session.prompt("hello");
			expect(host.faux.state.callCount).toBe(1);
			expect(host.events.map((e) => e.name)).toContain("turn_end");
		} finally {
			host.cleanup();
		}
	});

	it("session.prompt does NOT throw on provider errors — stopReason carries the failure (H16 note ②)", async () => {
		const host = await createCompactionHost({ probe: {} });
		try {
			host.faux.setResponses([fauxAssistantMessage("boom", { stopReason: "error", errorMessage: "provider exploded" })]);
			await host.session.prompt("hello");
			const turns = host.events.filter((e) => e.name === "turn_end");
			expect(turns.length).toBe(1);
			expect(turns[0].stopReason).toBe("error");
			expect(host.faux.state.callCount).toBe(1);
		} finally {
			host.cleanup();
		}
	});
});

describe("SC-HOST-06 SettingsManager compaction settings resolution (H8, S4)", () => {
	it("modelOverrides keys are 'provider/id' (slash included): override > ordinary > built-in default", async () => {
		// pi's SettingsManager.applyOverrides deep-merges, so each case gets a
		// fresh host to keep the override layers separate.
		const host = await createCompactionHost({
			model: { contextWindow: 64000, maxTokens: 4096 },
			probe: {},
		});
		try {
			const model = host.session.model!;
			host.settingsManager.applyOverrides({
				compaction: {
					enabled: true,
					reserveTokens: 7000, // ordinary
					keepRecentTokens: 3000,
					modelOverrides: {
						[`${model.provider}/${model.id}`]: { reserveTokens: 4242 },
					},
				},
			} as never);
			const settings = host.settingsManager.getCompactionSettings(model);
			expect(settings.reserveTokens).toBe(4242);
			expect(settings.keepRecentTokens).toBe(3000);
		} finally {
			host.cleanup();
		}
		const hostB = await createCompactionHost({ model: { contextWindow: 64000 }, probe: {} });
		try {
			hostB.settingsManager.applyOverrides({ compaction: { reserveTokens: 8000 } } as never);
			expect(hostB.settingsManager.getCompactionSettings(hostB.session.model!).reserveTokens).toBe(8000);
		} finally {
			hostB.cleanup();
		}
		const hostC = await createCompactionHost({ probe: {} });
		try {
			expect(hostC.settingsManager.getCompactionSettings(hostC.session.model!)).toEqual({
				enabled: true,
				reserveTokens: 16384,
				keepRecentTokens: 20000,
			});
		} finally {
			hostC.cleanup();
		}
	});

	it("pi's own threshold computation matches window − effective reserve (S4 consistency half)", async () => {
		const host = await createCompactionHost({ model: { contextWindow: 100000, maxTokens: 4096 }, probe: {} });
		try {
			const model = host.session.model!;
			host.settingsManager.applyOverrides({
				compaction: { enabled: true, reserveTokens: 25000, modelOverrides: { [`${model.provider}/${model.id}`]: { reserveTokens: 30000 } } },
			} as never);
			const settings = host.settingsManager.getCompactionSettings(model);
			// shouldCompact is the exact predicate pi's _checkCompaction uses.
			expect(shouldCompact(69999, 100000, settings)).toBe(false);
			expect(shouldCompact(70001, 100000, settings)).toBe(true);
		} finally {
			host.cleanup();
		}
	});

	it("SettingsManager.create only READS — no files written into agentDir/cwd (S4 side-effect half)", async () => {
		const host = await createCompactionHost({ probe: {} });
		try {
			const before = new Set(readdirSync(host.agentDir));
			const again = SettingsManager.create(host.cwd, host.agentDir);
			again.getCompactionSettings(host.session.model!);
			expect(new Set(readdirSync(host.agentDir))).toEqual(before);
			expect(new Set(readdirSync(host.cwd))).toEqual(new Set([]));
		} finally {
			host.cleanup();
		}
	});
});

describe("SC-HOST-04 getContextUsage null window (H7)", () => {
	it("tokens are null after a draft commit until the next assistant response, then numeric again", async () => {
		let drafted = false;
		const host = await createCompactionHost({
			probe: {
				captureContextUsage: true,
				turnEndDraft: (event) => {
					if (drafted) return undefined;
					drafted = true;
					return [compactionDraft("SUMMARY usage", event.messageEntryId)];
				},
			},
		});
		try {
			host.faux.setResponses([fauxAssistantMessage("first answer")]);
			await host.session.prompt("turn one");
			const firstPassNames = host.events.map((e) => e.name);
			const agentEndIndex = firstPassNames.indexOf("agent_end");
			const usageAtAgentEnd = host.contextUsage[agentEndIndex] as { tokens: number | null; contextWindow: number } | undefined;
			expect(usageAtAgentEnd).toBeDefined();
			expect(usageAtAgentEnd!.tokens).toBeNull();
			expect(usageAtAgentEnd!.contextWindow).toBeGreaterThan(0);
			host.faux.setResponses([fauxAssistantMessage("second answer")]);
			await host.session.prompt("turn two");
			const settleIndex = host.events.map((e) => e.name).lastIndexOf("agent_settled");
			const usageAtSettle = host.contextUsage[settleIndex] as { tokens: number | null } | undefined;
			expect(usageAtSettle?.tokens).toBeGreaterThan(0);
		} finally {
			host.cleanup();
		}
	});
});
