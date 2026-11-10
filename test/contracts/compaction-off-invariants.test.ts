/*
 * C6 test rails (2026-11-10 review, Batch C):
 *  - OFF-MODE integration: controllerSettings mode:"off" — the controller
 *    writes NOTHING: no cc-core-compaction telemetry entries and no
 *    compaction carrying details.ccCore, end to end on a real session.
 *  - INV-7: telemetry entries never carry summary NARRATIVE text — a
 *    sentinel planted in the faux summary must not appear in any
 *    serialized cc-core-compaction custom entry (the draft compaction
 *    itself legitimately carries the narrative; telemetry must not).
 */
import { describe, expect, it } from "vitest";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { createCompactionHost } from "./support/compaction-host.ts";

const AGGRESSIVE = {
	targetPostRatio: 0.5,
	precomputeRatio: 0.63,
	applyRatio: 0.7,
	summaryTokenEstimate: 200,
	keepSlackTokens: 1500,
	fallbackDeadlineMs: 150,
	refusedCooldownTurns: 0,
	minPrecomputeGapTurns: 0,
};
const PI_SMALL = { compaction: { enabled: true, reserveTokens: 2000, keepRecentTokens: 100 } };
const grow = (mass: number) => [
	fauxAssistantMessage([fauxText("inspecting"), fauxToolCall("sc_probe_tool", { value: "r".repeat(mass) })], { stopReason: "toolUse" }),
	fauxAssistantMessage(`closing notes for this run — ${"n".repeat(560)}`),
];
const summaries = () => [
	fauxAssistantMessage(`## History\n- SECRET-NARRATIVE-MARKER ${"h".repeat(400)}\n\n## State\n- stable`),
	fauxAssistantMessage(`# P\n${"p".repeat(200)}`),
];
const telemetryEntries = (host: { sessionManager: { getBranch: () => Array<unknown> } }) =>
	host.sessionManager
		.getBranch()
		.filter((e) => (e as { type?: string }).type === "custom" && (e as { customType?: string }).customType === "cc-core-compaction");

describe("C6: off mode + INV-7 telemetry hygiene", () => {
	it("mode:'off' — zero controller writes: no telemetry entries, no ccCore compactions", async () => {
		const host = await createCompactionHost({
			model: { contextWindow: 6000, maxTokens: 8000 },
			settingsOverrides: PI_SMALL,
			controllerSettings: { ...AGGRESSIVE, mode: "off" },
			envMode: null, // let controllerSettings.mode decide (C6: no env)
			probe: { registerTestTool: true },
		});
		try {
			host.faux.setResponses([
				...grow(600),
				...grow(3000).slice(0, 1),
				...summaries(),
				fauxAssistantMessage(`closing notes for this run — ${"n".repeat(560)}`),
				fauxAssistantMessage(`final answer with substance — ${"f".repeat(1200)}`),
			]);
			await host.session.prompt("one");
			await host.session.prompt("two");
			await host.session.prompt("three");
			expect(telemetryEntries(host).length).toBe(0);
			const ccCoreCompactions = host.sessionManager
				.getBranch()
				.filter((e) => e.type === "compaction")
				.filter((e) => (e as { details?: { ccCore?: unknown } }).details?.ccCore !== undefined);
			expect(ccCoreCompactions.length).toBe(0);
		} finally {
			host.cleanup();
		}
	});

	it("INV-7: telemetry entries never contain the summary narrative (sentinel marker)", async () => {
		const host = await createCompactionHost({
			model: { contextWindow: 6000, maxTokens: 8000 },
			settingsOverrides: PI_SMALL,
			controllerSettings: AGGRESSIVE,
			probe: { registerTestTool: true },
		});
		try {
			host.faux.setResponses([
				...grow(600),
				...grow(3000).slice(0, 1),
				...summaries(),
				fauxAssistantMessage(`closing notes for this run — ${"n".repeat(560)}`),
				fauxAssistantMessage(`final answer with substance — ${"f".repeat(1200)}`),
			]);
			await host.session.prompt("one");
			await host.session.prompt("two");
			await host.session.prompt("three");
			// The draft compaction itself MAY carry the narrative…
			const drafts = host.sessionManager
				.getBranch()
				.filter((e) => e.type === "compaction" && (e as { details?: { ccCore?: { origin?: string } } }).details?.ccCore?.origin === "precompute");
			expect(drafts.length).toBe(1);
			// …but NO serialized telemetry entry may contain the sentinel.
			for (const entry of telemetryEntries(host)) {
				expect(JSON.stringify(entry)).not.toContain("SECRET-NARRATIVE-MARKER");
			}
		} finally {
			host.cleanup();
		}
	});
});
