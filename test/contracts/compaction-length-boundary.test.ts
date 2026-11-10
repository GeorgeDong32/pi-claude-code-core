/**
 * BLK-1 protection (A1, 2026-11-10 review P0): a ready snapshot must never
 * draft over a recoverable `length` boundary — the proposal is withheld and
 * native recovery (H12/H13) takes over. Covers both turn_end (message.stopReason)
 * and agent_before_settle (stopReason read from the boundary branch entries).
 * Pinned from the review repro; SC_TEST_OVERRIDE_DEGRADE_AFTER seam unused here.
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
const SMALL_WINDOW = { contextWindow: 6000, maxTokens: 8000 };
const PI_SMALL = { compaction: { enabled: true, reserveTokens: 2000, keepRecentTokens: 100 } };
const grow = (mass: number) => [
	fauxAssistantMessage([fauxText("inspecting"), fauxToolCall("sc_probe_tool", { value: "r".repeat(mass) })], { stopReason: "toolUse" }),
	fauxAssistantMessage(`closing notes for this run — ${"n".repeat(560)}`),
];
const summaries = () => [
	fauxAssistantMessage(`## History\n- ${"h".repeat(500)}\n\n## State\n- stable`),
	fauxAssistantMessage(`# P\n${"p".repeat(200)}`),
];

describe("REVIEW repro POL-07: ready snapshot + length boundary", () => {
	for (const finalStop of ["length", "stop"] as const) {
		it(`final assistant stopReason=${finalStop}`, async () => {
			const host = await createCompactionHost({
				model: SMALL_WINDOW,
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
					fauxAssistantMessage(`final answer with substance — ${"f".repeat(1200)}`, { stopReason: finalStop }),
					fauxAssistantMessage("recovered answer (padding 1)"),
					fauxAssistantMessage("recovered answer (padding 2)"),
					fauxAssistantMessage("recovered answer (padding 3)"),
				]);
				await host.session.prompt("one");
				await host.session.prompt("two");
				await host.session.prompt("three");
				const branch = host.sessionManager.getBranch();
				const drafts = branch
					.filter((e) => e.type === "compaction")
					.filter((e) => (e as { details?: { ccCore?: { origin?: string } } }).details?.ccCore?.origin === "precompute");
				const lastAssistantStops = branch
					.filter((e) => e.type === "message" && (e as { message?: { role?: string } }).message?.role === "assistant")
					.map((e) => (e as { message?: { stopReason?: string } }).message?.stopReason);
				console.log(
					`[REPRO finalStop=${finalStop}] precomputeDrafts=${drafts.length} before_compact=${JSON.stringify(
						host.events.filter((e) => e.name === "session_before_compact").map((e) => e.reason),
					)} assistantStops=${JSON.stringify(lastAssistantStops)}`,
				);
				if (finalStop === "length") expect(drafts.length).toBe(0);
			} finally {
				host.cleanup();
			}
		});
	}
});
