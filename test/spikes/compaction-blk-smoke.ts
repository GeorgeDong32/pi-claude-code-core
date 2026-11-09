/*
 * W0 scratch spike #2: BLK-1 (length recovery), native threshold compaction
 * + extension supply (H6/H13), reasoning-only native summary (H10), steer
 * survival (S1⑤), agent_before_settle draft variant (S1). Throwaway driver.
 */
import { fauxAssistantMessage, fauxText, fauxThinking } from "@earendil-works/pi-ai";
import type { CompactionEntry } from "@earendil-works/pi-coding-agent";
import assert from "node:assert/strict";
import { createCompactionHost, compactionDraft, contextCapturingResponse } from "../contracts/support/compaction-host.ts";

function bigText(chars: number): string {
	return "x".repeat(chars);
}

async function blk1Baseline() {
	// No draft: recoverable length-stop must trigger overflow compact-and-retry.
	// Conversation must exceed keepRecentTokens or prepareCompaction returns
	// undefined BEFORE any event fires (silent no-op — discovered in W0 spike).
	const host = await createCompactionHost({
		settingsOverrides: { compaction: { enabled: true, reserveTokens: 16000, keepRecentTokens: 100 } },
		probe: {},
	});
	try {
		host.faux.setResponses([
			fauxAssistantMessage(`${bigText(16000)} cut short`, { stopReason: "length" }),
			fauxAssistantMessage("## Summary\n- did things\n- more things"),
			fauxAssistantMessage("recovered answer"),
		]);
		await host.session.prompt("do something long");
		const names = host.events.map((e) => `${e.name}${e.reason ? `(${e.reason})` : ""}`).join(",");
		console.log("BLK1-baseline events:", names);
		console.log("BLK1-baseline callCount:", host.faux.state.callCount);
		const before = host.events.find((e) => e.name === "session_before_compact");
		console.log("BLK1-baseline before_compact reason:", before?.reason, "willRetry:", before?.willRetry);
		console.log("BLK1-baseline outcome(length):", host.events.filter((e) => e.name === "turn_end").map((e) => e.outcome).join("|"));
	} finally {
		host.cleanup();
	}
}

async function blk1Hazard() {
	// Draft at the length turn_end: recovery must be swallowed.
	const host = await createCompactionHost({
		settingsOverrides: { compaction: { enabled: true, reserveTokens: 16000, keepRecentTokens: 100 } },
		probe: {
			turnEndDraft: (event) =>
				event.message?.stopReason === "length" ? [compactionDraft("SUMMARY-HAZARD", event.messageEntryId)] : undefined,
		},
	});
	try {
		host.faux.setResponses([
			fauxAssistantMessage(`${bigText(16000)} cut short`, { stopReason: "length" }),
			fauxAssistantMessage("never used"),
		]);
		await host.session.prompt("do something long");
		const names = host.events.map((e) => e.name).join(",");
		console.log("BLK1-hazard events:", names);
		console.log("BLK1-hazard callCount:", host.faux.state.callCount);
		const compact = host.sessionManager.getBranch().filter((e: any) => e.type === "compaction");
		console.log("BLK1-hazard compaction:", compact.length, "lastStop:", host.events.filter((e) => e.name === "turn_end").map((e) => e.stopReason).join("|"));
	} finally {
		host.cleanup();
	}
}

async function nativeThresholdSupply() {
	// H6/H13: threshold fires, probe supplies an oversized compaction → host
	// must accept it as-is (no capacity validation) and emit session_compact.
	const host = await createCompactionHost({
		model: { contextWindow: 3000, maxTokens: 1000 },
		settingsOverrides: { compaction: { enabled: true, reserveTokens: 500, keepRecentTokens: 300 } },
		probe: {
			beforeCompact: () => ({
				compaction: {
					summary: bigText(20000) /* ~5K tokens — way over the 3K window */,
					firstKeptEntryId: "nonexistent-entry",
					tokensBefore: 999999,
					usage: undefined,
					details: { readFiles: [], modifiedFiles: [] },
				},
			}),
		},
	});
	try {
		host.faux.setResponses([fauxAssistantMessage(bigText(12000))]);
		await host.session.prompt("grow the context");
		const names = host.events.map((e) => `${e.name}${e.reason ? `(${e.reason})` : ""}${e.fromExtension === true ? "[ext]" : ""}`).join(",");
		console.log("H13 events:", names);
		const compact = host.sessionManager.getBranch().filter((e: any) => e.type === "compaction");
		const h13c = compact[0] as CompactionEntry | undefined;
		console.log("H13 compaction:", compact.length, "summaryChars:", h13c?.summary?.length, "fromHook:", h13c?.fromHook, "firstKept:", h13c?.firstKeptEntryId, "tokensBefore:", h13c?.tokensBefore);
		console.log("H13 callCount (supply must skip summary LLM):", host.faux.state.callCount);
	} finally {
		host.cleanup();
	}
}

async function nativeEmptySummary() {
	// H10: native path (no supply) with a reasoning-only faux summary response
	// → host appends the empty summary as-is.
	const host = await createCompactionHost({
		model: { contextWindow: 3000, maxTokens: 1000, reasoning: true },
		settingsOverrides: { compaction: { enabled: true, reserveTokens: 500, keepRecentTokens: 300 } },
		probe: {},
	});
	try {
		host.faux.setResponses([
			fauxAssistantMessage(bigText(12000)),
			fauxAssistantMessage([fauxThinking("thinking only, no answer"), fauxText("")], { stopReason: "stop" }),
		]);
		await host.session.prompt("grow then summarize nothing");
		const compact = host.sessionManager.getBranch().filter((e: any) => e.type === "compaction");
		console.log("H10 compaction entries:", compact.length);
		if (compact[0]) {
			console.log("H10 summary len:", (compact[0] as CompactionEntry).summary.length, "JSON head:", JSON.stringify((compact[0] as CompactionEntry).summary.slice(0, 120)));
		}
		const names = host.events.map((e) => e.name).join(",");
		console.log("H10 events:", names);
	} finally {
		host.cleanup();
	}
}

async function steerSurvival() {
	// S1⑤: mid-run draft commit must not lose a queued steering message.
	const host = await createCompactionHost({
		probe: {
			registerTestTool: true,
			turnEndDraft: (event, ctx) => {
				if (event.message?.stopReason === "toolUse") {
					try {
						void host.session.steer("steered direction");
					} catch {}
					return [compactionDraft("SUMMARY-STEER", event.messageEntryId)];
				}
				return undefined;
			},
		},
	});
	try {
		host.faux.setResponses([
			contextCapturingResponse(host, fauxAssistantMessage([{ type: "toolCall", id: "tc1", name: "sc_probe_tool", arguments: { value: "x" } }], { stopReason: "toolUse" })),
			contextCapturingResponse(host, fauxAssistantMessage("final answer")),
		]);
		await host.session.prompt("run a tool");
		const branchTexts = host.sessionManager.getBranch().filter((e: any) => e.type === "message").map((e: any) => e.message?.role).join(",");
		console.log("STEER branch roles:", branchTexts);
		console.log("STEER requestContexts:", JSON.stringify(host.requestContexts.map((c) => c.texts)));
		console.log("STEER compaction:", host.sessionManager.getBranch().filter((e: any) => e.type === "compaction").length);
	} finally {
		host.cleanup();
	}
}

async function beforeSettleDraft() {
	// S1 agent_before_settle variant: draft lands at settle boundary.
	const host = await createCompactionHost({
		probe: {
			beforeSettleDraft: () => [compactionDraft("SUMMARY-SETTLE", "seed-kept")],
		},
	});
	try {
		host.faux.setResponses([fauxAssistantMessage("plain stop turn")]);
		await host.session.prompt("hello");
		const compact = host.sessionManager.getBranch().filter((e: any) => e.type === "compaction");
		console.log("SETTLE compaction:", compact.length, (compact[0] as CompactionEntry | undefined)?.fromHook, (compact[0] as CompactionEntry | undefined)?.firstKeptEntryId);
		const names = host.events.map((e) => e.name).join(",");
		console.log("SETTLE events:", names);
	} finally {
		host.cleanup();
	}
}

async function main() {
	await blk1Baseline();
	await blk1Hazard();
	await nativeThresholdSupply();
	await nativeEmptySummary();
	await steerSurvival();
	await beforeSettleDraft();
	console.log("SPIKE2-OK");
}

main().catch((err) => {
	console.error("SPIKE2 FAILED", err);
	process.exit(1);
});
