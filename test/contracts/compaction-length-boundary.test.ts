/**
 * POL-07's stopReason authority is the SESSION BRANCH
 * (ctx.sessionManager.getBranch(), backward scan for the last assistant
 * message) — event.message covers turn_end only, and the host's boundary
 * `entries` are the draft accumulator, never messages.
 */
import { describe, expect, it, vi } from "vitest";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { createCompactionHost } from "./support/compaction-host.ts";
import { metricFromEntry, summarizeCompactionMetrics, type CompactionMetric } from "../../extensions/compaction/metrics.ts";
import { SessionRuntime } from "../../extensions/compaction/state.ts";

const metricsOf = (entries: unknown[]) => entries.map(metricFromEntry).filter((row): row is CompactionMetric => row !== undefined);

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
			const overflows = host.events.filter((e) => e.name === "session_before_compact" && (e as { reason?: string }).reason === "overflow");
			expect(overflows.length).toBeGreaterThanOrEqual(1);
			const stops = branch.filter(isAssistant).map(assistantStop);
			expect(stops[stops.length - 1]).toBe("stop");
			const idx = branch.findIndex((e, i) => isAssistant(e) && assistantStop(e) === "length" && !branch.slice(0, i).some((p) => isAssistant(p) && assistantStop(p) === "length"));
			expect(idx).toBeGreaterThanOrEqual(0);
			const after = branch.slice(idx + 1).filter((e) => (e as { type?: string }).type === "compaction");
			expect(after.length).toBeGreaterThan(0);
			expect(precomputeOrigin(after[0])).not.toBe("precompute");
			expect(branch.filter((e) => (e as { type?: string }).type === "compaction" && precomputeOrigin(e) === "precompute").length).toBe(0);
			const firstAfter = after[0] as { details?: { ccCore?: { origin?: string } }; summary?: string };
			expect(firstAfter.details?.ccCore?.origin).toBe("native-backfill");
			expect(firstAfter.summary ?? "").toContain('<cc-core-ledger v="1">');
			const metrics = metricsOf(branch);
			expect(metrics.find((row) => row.event === "fallback-start")?.reason).toBe("overflow");
			expect(metrics.find((row) => row.event === "fallback-end")?.fromExtension).toBe(true);
			expect(summarizeCompactionMetrics([metrics]).earlyCommits).toBe(0);
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
			expect(stops[stops.length - 1]).toBe("length");
			const drafts = branch.filter((e) => (e as { type?: string }).type === "compaction" && precomputeOrigin(e) === "precompute");
			expect(drafts.length).toBe(0);
			expect(metricsOf(branch).filter((row) => row.event === "applied")).toHaveLength(0);
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
		const original = SessionRuntime.prototype.onBoundary;
		let observedRuntime: SessionRuntime | undefined;
		const boundarySpy = vi.spyOn(SessionRuntime.prototype, "onBoundary").mockImplementation(function (this: SessionRuntime, event) {
			observedRuntime = this;
			return original.call(this, event);
		});
		try {
			host.faux.setResponses(responses("stop"));
			await host.session.prompt("one\nsecond line of the request");
			await host.session.prompt("two\nanother follow-up line here");
			await host.session.prompt("three\nfinal multiline instruction");
			const branch = host.sessionManager.getBranch();
			const drafts = branch.filter((e) => (e as { type?: string }).type === "compaction" && precomputeOrigin(e) === "precompute");
			expect(drafts.length).toBe(1);
			expect((drafts[0] as { summary?: string }).summary ?? "").toContain('<cc-core-ledger v="1">');
			const metrics = metricsOf(branch);
			expect(metrics.map((row) => row.event)).toEqual(["compute-start", "compute-ready", "proposal", "applied"]);
			const applied = metrics.find((row) => row.event === "applied")!;
			const proposed = metrics.find((row) => row.event === "proposal")!;
			expect(applied.proposalId).toBe(proposed.proposalId);
			expect(applied.tokens).toBe(proposed.tokens);
			expect(applied.tn).toBe(4000);
			expect(summarizeCompactionMetrics([metrics]).earlyCommits).toBe(1);
			const boundaries = host.events.filter((event) => event.name === "turn_end" || event.name === "agent_before_settle");
			expect(observedRuntime?.state.turns).toBe(boundaries.length);
		} finally {
			host.cleanup();
			boundarySpy.mockRestore();
		}
	});
});
