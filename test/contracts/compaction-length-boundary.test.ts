/**
 * BLK-1 protection: ready snapshot + length boundary (POL-07/INV-11).
 *
 * A1 (2026-11-10 review P0, rework R1/R2): POL-07's stopReason authority is
 * the SESSION BRANCH (ctx.sessionManager.getBranch(), backward scan for the
 * last assistant message) — event.message covers turn_end only, and the
 * host's boundary `entries` are the draft accumulator, never messages.
 * Pinned scenarios:
 *  - recoverable length (host retries, final assistant ends at "stop"): no
 *    precompute draft lands over the truncated stretch, and native overflow
 *    recovery proceeds (session_before_compact reason "overflow").
 *  - non-recoverable length (maxTokens 60 — no retry): NO precompute draft
 *    after the length-stop assistant, at ANY boundary (turn_end or
 *    agent_before_settle). This was the review's P0 failure mode.
 *  - clean stop control: exactly one precompute draft (gate not overblocking).
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
	fauxAssistantMessage(`## History\n- ${"h".repeat(500)}\n\n## State\n- stable`),
	fauxAssistantMessage(`# P\n${"p".repeat(200)}`),
];
const responses = (finalStop: "length" | "stop") => [
	...grow(600),
	...grow(3000).slice(0, 1),
	...summaries(),
	fauxAssistantMessage(`closing notes for this run — ${"n".repeat(560)}`),
	fauxAssistantMessage(`final answer with substance — ${"f".repeat(1200)}`, { stopReason: finalStop }),
	fauxAssistantMessage("recovered answer (padding 1)"),
	fauxAssistantMessage("recovered answer (padding 2)"),
	fauxAssistantMessage("recovered answer (padding 3)"),
];
const precomputeOrigin = (e: unknown) => (e as { details?: { ccCore?: { origin?: string } } }).details?.ccCore?.origin;
const assistantStop = (e: unknown) => (e as { message?: { stopReason?: string } }).message?.stopReason;
const isAssistant = (e: unknown) => (e as { type?: string; message?: { role?: string } }).type === "message" && (e as { message?: { role?: string } }).message?.role === "assistant";

describe("BLK-1 protection: ready snapshot + length boundary (POL-07/INV-11)", () => {
	it("recoverable length: no precompute draft over the truncated stretch; native overflow recovery proceeds", async () => {
		const host = await createCompactionHost({
			model: { contextWindow: 6000, maxTokens: 8000 },
			settingsOverrides: PI_SMALL,
			controllerSettings: AGGRESSIVE,
			probe: { registerTestTool: true },
		});
		try {
			host.faux.setResponses(responses("length"));
			await host.session.prompt("one");
			await host.session.prompt("two");
			await host.session.prompt("three");
			const branch = host.sessionManager.getBranch();
			// ① native overflow recovery fired (session_before_compact, reason "overflow")
			const overflows = host.events.filter((e) => e.name === "session_before_compact" && (e as { reason?: string }).reason === "overflow");
			expect(overflows.length).toBeGreaterThanOrEqual(1);
			// ② after recovery the final assistant ends at a clean "stop"
			const stops = branch.filter(isAssistant).map(assistantStop);
			expect(stops[stops.length - 1]).toBe("stop");
			// ③ the first compaction AFTER the length-stop assistant is not ours
			const idx = branch.findIndex((e, i) => isAssistant(e) && assistantStop(e) === "length" && !branch.slice(0, i).some((p) => isAssistant(p) && assistantStop(p) === "length"));
			expect(idx).toBeGreaterThanOrEqual(0);
			const after = branch.slice(idx + 1).filter((e) => (e as { type?: string }).type === "compaction");
			// D8.1 (2026-11-10 review D): unconditional — a recovery compaction
			// MUST have landed, and it must not be ours.
			expect(after.length).toBeGreaterThan(0);
			expect(precomputeOrigin(after[0])).not.toBe("precompute");
			// and no precompute draft landed anywhere over that stretch either
			expect(branch.filter((e) => (e as { type?: string }).type === "compaction" && precomputeOrigin(e) === "precompute").length).toBe(0);
			// RB5 (2026-11-10 review rework): the native overflow recovery USED
			// our supply (native-backfill) and the supplied summary carries
			// the composed ledger block — the end-to-end supply assertion.
			const firstAfter = after[0] as { details?: { ccCore?: { origin?: string } }; summary?: string };
			expect(firstAfter.details?.ccCore?.origin).toBe("native-backfill");
			expect(firstAfter.summary ?? "").toContain('<cc-core-ledger v="1">');
		} finally {
			host.cleanup();
		}
	});

	it("non-recoverable length (maxTokens 60): NO precompute draft after the length-stop assistant, at any boundary", async () => {
		const host = await createCompactionHost({
			model: { contextWindow: 6000, maxTokens: 60 },
			settingsOverrides: PI_SMALL,
			controllerSettings: AGGRESSIVE,
			probe: { registerTestTool: true },
		});
		try {
			host.faux.setResponses(responses("length"));
			await host.session.prompt("one");
			await host.session.prompt("two");
			await host.session.prompt("three");
			const branch = host.sessionManager.getBranch();
			const stops = branch.filter(isAssistant).map(assistantStop);
			// the truncated run is still sitting at "length" (no retry room)
			expect(stops[stops.length - 1]).toBe("length");
			// R1 regression: nothing precompute-originated may land after it
			const drafts = branch.filter((e) => (e as { type?: string }).type === "compaction" && precomputeOrigin(e) === "precompute");
			expect(drafts.length).toBe(0);
		} finally {
			host.cleanup();
		}
	});

	it("clean stop control: exactly one precompute draft (gate not overblocking)", async () => {
		const host = await createCompactionHost({
			model: { contextWindow: 6000, maxTokens: 8000 },
			settingsOverrides: PI_SMALL,
			controllerSettings: AGGRESSIVE,
			probe: { registerTestTool: true },
		});
		try {
			host.faux.setResponses(responses("stop"));
			// D1.4 (2026-11-10 review D): MULTILINE prompts — before the D1
			// self-check fix a newline in the directive text made LED-08 fail
			// forever, so this control produced 0 drafts.
			await host.session.prompt("one\nsecond line of the request");
			await host.session.prompt("two\nanother follow-up line here");
			await host.session.prompt("three\nfinal multiline instruction");
			const branch = host.sessionManager.getBranch();
			const drafts = branch.filter((e) => (e as { type?: string }).type === "compaction" && precomputeOrigin(e) === "precompute");
			expect(drafts.length).toBe(1);
			// B4 (2026-11-10 review): the landed draft went through
			// composeFinalSummary — its summary must carry the ledger block.
			expect((drafts[0] as { summary?: string }).summary ?? "").toContain('<cc-core-ledger v="1">');
		} finally {
			host.cleanup();
		}
	});
});
