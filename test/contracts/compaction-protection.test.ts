import { describe, expect, it } from "vitest";
import { fauxAssistantMessage, fauxText, fauxThinking, fauxToolCall } from "@earendil-works/pi-ai";
import { createCompactionHost } from "./support/compaction-host.ts";
import { registerCompactionSubscriber, resetCompactionSeam } from "../../lib/compaction-seam.ts";

const BIG = "x".repeat(16000);
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
const RECOVERY_SAFE = {
	...AGGRESSIVE,
	overflowFitRatio: 0.05,
	hardFitRatio: 0.95,
};
/** maxTokens ABOVE the truncated output keeps pi's isRecoverableLength true (overflow retry). */
const SMALL_WINDOW = { contextWindow: 6000, maxTokens: 8000 };
const PI_SMALL = { compaction: { enabled: true, reserveTokens: 2000, keepRecentTokens: 100 } };

function growResponses(toolMassChars: number) {
	return [
		fauxAssistantMessage(
			[fauxText("inspecting"), fauxToolCall("sc_probe_tool", { value: "r".repeat(toolMassChars) })],
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage(`closing notes for this run — ${"n".repeat(560)}`),
	];
}
function summaryResponses() {
	return [
		fauxAssistantMessage(`## History\n- ${"h".repeat(500)}\n\n## State\n- stable`),
		fauxAssistantMessage(`# P\n${"p".repeat(200)}`),
	];
}

describe("BLK-1 protection: controller declines to propose at a recoverable length boundary (POL-07/INV-11)", () => {
	it("with the controller installed, the length-stop turn keeps its native compact-and-retry recovery", async () => {
		const host = await createCompactionHost({
			model: SMALL_WINDOW,
			settingsOverrides: PI_SMALL,
			controllerSettings: RECOVERY_SAFE,
			probe: {},
		});
		try {
			host.faux.setResponses([
				fauxAssistantMessage(`${BIG} cut short`, { stopReason: "length" }),
				fauxAssistantMessage(`## History\n- ${"h".repeat(500)}\n\n## State\n- stable`),
				fauxAssistantMessage(`# P\n${"p".repeat(200)}`),
				fauxAssistantMessage("## Summary\n- native recovery summary"),
				fauxAssistantMessage("recovered answer"),
				fauxAssistantMessage("recovered answer (padding 1)"),
				fauxAssistantMessage("recovered answer (padding 2)"),
			]);
			await host.session.prompt("do something long");
			expect(host.events.find((e) => e.name === "session_before_compact")?.reason).toBe("overflow");
			const finalAssistant = [...host.sessionManager.getBranch()]
				.reverse()
				.find((e) => e.type === "message" && (e as { message?: { role?: string } }).message?.role === "assistant");
			expect((finalAssistant as { message?: { stopReason?: string } }).message?.stopReason).toBe("stop");
			const drafts = host.sessionManager
				.getBranch()
				.filter((e) => e.type === "compaction")
				.filter((e) => (e as { details?: { ccCore?: { origin?: string } } }).details?.ccCore?.origin === "precompute");
			expect(drafts.length).toBe(0);
		} finally {
			host.cleanup();
		}
	});
});

describe("BLK-2 protection: reconciliation + seam exactness (APP-04/05/08, SM-02)", () => {
	it("(a) override: proposal classified lost, snapshot survives, no seam after; a later clean boundary commits", async () => {
		resetCompactionSeam();
		const afterNotifications: Array<{ entryId?: string }> = [];
		registerCompactionSubscriber({
			after: (info: { entryId?: string }) => afterNotifications.push(info),
		});
		const host = await createCompactionHost({
			model: SMALL_WINDOW,
			settingsOverrides: PI_SMALL,
			controllerSettings: AGGRESSIVE,
			probe: { registerTestTool: true },
			postFactories: [
				((pi: { on: (event: string, handler: (event: Record<string, unknown>) => unknown) => void }) => {
					pi.on("turn_end", () => ({ entries: [] }));
				}) as never,
			],
		});
		try {
			host.faux.setResponses([
				...growResponses(600),
				...growResponses(3000).slice(0, 1),
				...summaryResponses(),
				fauxAssistantMessage(`closing notes for this run — ${"n".repeat(560)}`),
				fauxAssistantMessage(`final answer with substance — ${"f".repeat(1200)}`),
			]);
			await host.session.prompt("first");
			await host.session.prompt("second");
			await host.session.prompt("third");
			expect(afterNotifications.length).toBe(1);
			const committed = host.sessionManager
				.getBranch()
				.filter((e) => e.type === "compaction")
				.filter((e) => (e as { details?: { ccCore?: { origin?: string } } }).details?.ccCore?.origin === "precompute");
			expect(committed.length).toBe(1);
		} finally {
			resetCompactionSeam();
			host.cleanup();
		}
	});

	it("(b) conflict-edit: committed compaction with a post-boundary edit targeting the compressed region is audited (conflictEdit telemetry)", async () => {
		const host = await createCompactionHost({
			model: SMALL_WINDOW,
			settingsOverrides: PI_SMALL,
			controllerSettings: AGGRESSIVE,
			probe: { registerTestTool: true },
			postFactories: [
				((pi: { on: (event: string, handler: (event: { entries?: Array<{ type?: string }> }, ctx: unknown) => unknown) => void }) => {
					pi.on("turn_end", (event, ctx) => {
						if (!(event.entries ?? []).some((e) => e.type === "compaction")) return undefined;
						const branch = (ctx as { sessionManager: { getBranch: () => Array<{ id?: string; type?: string; message?: { role?: string } }> } }).sessionManager.getBranch();
						// context_edit only applies to message entries; a model_change id
						// would make appendContextEdit throw and abort the whole boundary
						// commit. An appendContextEdit miss aborts the commit of every
						// later draft too.
						const targetId = branch.find((e) => e.type === "message" && (e.message?.role === "user" || e.message?.role === "assistant"))?.id ?? "<no-target>";
						return {
							entries: [
								...(event.entries ?? []),
								{ type: "context_edit", targetId, replacement: { content: "retro-edited away from the projection" } },
							],
						};
					});
				}) as never,
			],
		});
		try {
			host.faux.setResponses([
				...growResponses(600),
				...growResponses(3000).slice(0, 1),
				...summaryResponses(),
				fauxAssistantMessage(`closing notes for this run — ${"n".repeat(560)}`),
				fauxAssistantMessage(`final answer with substance — ${"f".repeat(1200)}`),
			]);
			await host.session.prompt("one");
			await host.session.prompt("two");
			await host.session.prompt("three");
			const audit = host.sessionManager
				.getBranch()
				.filter((e) => e.type === "custom" && (e as { customType?: string }).customType === "cc-core-compaction")
				.map((e) => (e as { data?: { conflictEdit?: number } }).data?.conflictEdit ?? 0);
			expect(Math.max(0, ...audit)).toBeGreaterThanOrEqual(1);
		} finally {
			host.cleanup();
		}
	});

	it("(c) clean commit: reconciliation hits on the first visible event, seam after fires exactly once with the real entryId", async () => {
		resetCompactionSeam();
		const afterNotifications: Array<{ entryId?: string }> = [];
		registerCompactionSubscriber({
			after: (info: { entryId?: string }) => afterNotifications.push(info),
		});
		const host = await createCompactionHost({
			model: SMALL_WINDOW,
			settingsOverrides: PI_SMALL,
			controllerSettings: AGGRESSIVE,
			probe: { registerTestTool: true },
		});
		try {
			host.faux.setResponses([
				...growResponses(600),
				...growResponses(3000).slice(0, 1),
				...summaryResponses(),
				fauxAssistantMessage(`closing notes for this run — ${"n".repeat(560)}`),
				fauxAssistantMessage(`final answer with substance — ${"f".repeat(1200)}`),
			]);
			await host.session.prompt("one");
			await host.session.prompt("two");
			await host.session.prompt("three");
			expect(afterNotifications.length).toBe(1);
			const committedIds = new Set(
				host.sessionManager
					.getBranch()
					.filter((e) => e.type === "compaction")
					.map((e) => e.id),
			);
			expect(committedIds.has(afterNotifications[0].entryId!)).toBe(true);
		} finally {
			resetCompactionSeam();
			host.cleanup();
		}
	});
});

describe("BLK-3 protection: hard capacity gate on every write path (V8a/INV-12)", () => {
	it("an oversized precomputed summary is neither proposed as a draft nor supplied to the native leg", async () => {
		const host = await createCompactionHost({
			model: SMALL_WINDOW,
			settingsOverrides: { compaction: { enabled: true, reserveTokens: 3000, keepRecentTokens: 300 } },
			controllerSettings: {},
			probe: {},
		});
		try {
			host.faux.setResponses([
				fauxAssistantMessage("x".repeat(12000)),
				fauxAssistantMessage("## Summary\n- native fallback summary"),
			]);
			await host.session.prompt("grow the context");
			const controllerWritten = host.sessionManager
				.getBranch()
				.filter((e) => e.type === "compaction")
				.filter((e) => (e as { details?: { ccCore?: unknown } }).details?.ccCore !== undefined);
			expect(controllerWritten.length).toBe(0);
			expect(host.sessionManager.getBranch().some((e) => e.type === "compaction")).toBe(true);
		} finally {
			host.cleanup();
		}
	});
});

describe("BLK-4 protection: per-sub-call validation refuses partial-empty summaries (SUM-03/04/09)", () => {
	it("a reasoning-only turn-prefix sub-call never lands: no controller-originated compaction with an empty section", async () => {
		const host = await createCompactionHost({
			model: SMALL_WINDOW,
			settingsOverrides: PI_SMALL,
			controllerSettings: { ...AGGRESSIVE },
			probe: {},
		});
		try {
			host.faux.setResponses([
				fauxAssistantMessage("a single giant turn with lots of mass ".repeat(120)),
				fauxAssistantMessage("## History\n- real narrative content for the history sub-call"),
				fauxAssistantMessage([fauxThinking("only thoughts here"), fauxText("")], { stopReason: "stop" }),
				fauxAssistantMessage("## History\n- retry narrative content\n\n## State\n- stable"),
				fauxAssistantMessage("## Prefix\n- prefix content"),
				fauxAssistantMessage("second answer"),
			]);
			await host.session.prompt("hello");
			await host.session.prompt("again");
			const bad = host.sessionManager
				.getBranch()
				.filter((e) => e.type === "compaction")
				.filter((e) => {
					const summary = (e as { summary?: string }).summary ?? "";
					const prefix = summary.split("**Turn Context (split turn):**")[1] ?? "";
					return prefix.trim() === "" && (e as { details?: { ccCore?: unknown } }).details?.ccCore !== undefined;
				});
			expect(bad.length).toBe(0);
		} finally {
			host.cleanup();
		}
	});
});

describe("BLK-5 protection: native empty summary is audited, not rewritten (FB-08)", () => {
	it("a native reasoning-only summary still lands verbatim, and the controller emits native-summary-invalid telemetry", async () => {
		const host = await createCompactionHost({
			model: { contextWindow: 6000, maxTokens: 1000, reasoning: true },
			settingsOverrides: { compaction: { enabled: true, reserveTokens: 3000, keepRecentTokens: 300 } },
			controllerSettings: {},
			probe: {},
		});
		try {
			host.faux.setResponses([
				fauxAssistantMessage("x".repeat(12000)),
				fauxAssistantMessage([fauxThinking("only thoughts"), fauxText("")], { stopReason: "stop" }),
			]);
			await host.session.prompt("grow then summarize nothing");
			const native = host.sessionManager.getBranch().filter((e) => e.type === "compaction");
			expect(native.length).toBe(1);
			expect((native[0] as { fromHook?: boolean }).fromHook).toBeFalsy();
			const audit = host.sessionManager
				.getBranch()
				.filter((e) => e.type === "custom" && (e as { customType?: string }).customType === "cc-core-compaction")
				.map((e) => JSON.stringify((e as { data?: unknown }).data));
			expect(audit.join(" ")).toContain("native");
		} finally {
			host.cleanup();
		}
	});
});
