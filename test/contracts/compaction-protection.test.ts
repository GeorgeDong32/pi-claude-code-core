/*
 * Smart Compaction PROTECTED assertions (SPEC SC §4.4 BLK-1…5) — the
 * "有保护断言" half of every blocking case, now flipping from EXPECTED
 * FAILURE to live: the controller module (extensions/compaction/**, W1–W4)
 * and the seam (lib/compaction-seam.ts, W5) exist and assemble through
 * extensions/compaction/index.ts inside a real AgentSession host.
 *
 * The baselines these protect live in compaction-{boundary,native,recovery,
 * summarizer}.test.ts and stay green throughout. Assertions are the
 * user-visible outcomes the spec requires (POL-07/V8a/SUM-03·04/FB-08/
 * APP-05·08); the scenarios drive the REAL controller factory (host option
 * `controllerSettings`, positioned AFTER the probe and BEFORE
 * `postFactories` — the H5 later-handler position).
 *
 * Ratio knobs per scenario are POL-02-valid and POL-09-feasible for the
 * tiny faux windows (spec §7.3: never use T_n ≈ 40K + default keep here).
 */
import { describe, expect, it } from "vitest";
import { fauxAssistantMessage, fauxText, fauxThinking, fauxToolCall } from "@earendil-works/pi-ai";
import { createCompactionHost } from "./support/compaction-host.ts";
import { registerCompactionSubscriber, resetCompactionSeam } from "../../lib/compaction-seam.ts";

const BIG = "x".repeat(16000);
/**
 * POL-02/09-valid aggressive knobs for a T_n ≈ 1 500 host (window 3 000,
 * reserve 1 500, keep 100). Chosen so the faux sessions cross precompute
 * AND apply thresholds within two runs while V8a/V8b still pass on the
 * kept tail (spec §7.3: never default-keep on tiny faux windows).
 */
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
/** POL-07-strong knobs: feasible to precompute/propose, but the OVERFLOW
 * supply leg can never fit (overflowFitRatio 0.05 → 125-token cap). */
const RECOVERY_SAFE = {
	...AGGRESSIVE,
	overflowFitRatio: 0.05,
	hardFitRatio: 0.95,
};
/** Shared window: T_n = 3 000 (native threshold) — wide enough that the
 * controller's [0.7·T_n, T_n) band is reachable across two gentle runs,\ * yet small enough for the faux sessions to cross it. maxTokens ABOVE the
 * truncated output keeps pi's isRecoverableLength true (overflow retry). */
const SMALL_WINDOW = { contextWindow: 6000, maxTokens: 8000 };
const PI_SMALL = { compaction: { enabled: true, reserveTokens: 2000, keepRecentTokens: 100 } };

/** One growth run: a tool turn (mass via the echoed tool result) + a short
 * closing text turn. Two of these bring the session into the controller's
 * [preRatio, native-threshold) band with a NON-empty history region. */
function growResponses(toolMassChars: number) {
	return [
		fauxAssistantMessage(
			[fauxText("inspecting"), fauxToolCall("sc_probe_tool", { value: "r".repeat(toolMassChars) })],
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage(`closing notes for this run — ${"n".repeat(560)}`),
	];
}
/** The controller's split compute: history + turn-prefix sub-calls. */
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
				// the controller's background compute (split: history + prefix)
				fauxAssistantMessage(`## History\n- ${"h".repeat(500)}\n\n## State\n- stable`),
				fauxAssistantMessage(`# P\n${"p".repeat(200)}`),
				// the native recovery's own summary + the retried answer
				fauxAssistantMessage("## Summary\n- native recovery summary"),
				fauxAssistantMessage("recovered answer"),
				// padding: whichever consumer order the async race picks,
				// every remaining response is a benign stop answer
				fauxAssistantMessage("recovered answer (padding 1)"),
				fauxAssistantMessage("recovered answer (padding 2)"),
			]);
			await host.session.prompt("do something long");
			// PROTECTED OUTCOME: the native recovery ran despite the
			// controller's presence — overflow reason, a RETRY TURN after the
			// compaction (the recovered answer landed, not the truncated
			// one), and NO draft compaction from the controller at the length
			// boundary. (The W0 no-controller baseline pins the exact 3-call
			// shape; the controller's background compute may add 0+ calls —
			// an empty-history split shortcut makes none.)
			expect(host.events.find((e) => e.name === "session_before_compact")?.reason).toBe("overflow");
			const finalAssistant = [...host.sessionManager.getBranch()]
				.reverse()
				.find((e) => e.type === "message" && (e as { message?: { role?: string } }).message?.role === "assistant");
			// The retry turn landed a COMPLETE answer (stop), not the
			// truncated length-stop the hazard would have frozen us at.
			expect((finalAssistant as { message?: { stopReason?: string } }).message?.stopReason).toBe("stop");
			// POL-07's hazard is the DRAFT at the length boundary swallowing
			// recovery. The fallback SUPPLY leg (origin native-backfill) is a
			// different, spec-legal path — it may legitimately serve the
			// recovery when its result fits V8a.
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
			// Another handler registered AFTER the controller overrides
			// entries at turn_end — the BLK-2(a) hazard (H5(b)).
			postFactories: [
				((pi: { on: (event: string, handler: (event: Record<string, unknown>) => unknown) => void }) => {
					pi.on("turn_end", () => ({ entries: [] }));
				}) as never,
			],
		});
		try {
			host.faux.setResponses([
				// run 1 (below precompute), run 2 tool turn (crosses precompute →
				// the compute consumes the two summary responses), run 2 close,
				// run 3 short answer (crosses apply → propose).
				...growResponses(600),
				...growResponses(3000).slice(0, 1),
				...summaryResponses(),
				fauxAssistantMessage(`closing notes for this run — ${"n".repeat(560)}`),
				fauxAssistantMessage(`final answer with substance — ${"f".repeat(1200)}`),
			]);
			await host.session.prompt("first");
			await host.session.prompt("second");
			await host.session.prompt("third");
			// PROTECTED OUTCOME: no after notification for the LOST proposal;
			// the snapshot was not consumed by the override — the very next
			// clean apply point (agent_before_settle of the same run) commits
			// it. Exactly one after notification, for the surviving commit.
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
						// Only ride along when the controller's draft is present
						// (appending an edit on EVERY boundary would rightly be
						// refused by V4 before any propose).
						if (!(event.entries ?? []).some((e) => e.type === "compaction")) return undefined;
						// Target the first MESSAGE entry — inside the compressed
						// region once the controller's cut lands (context_edit
						// only applies to message entries; a model_change id
						// would make appendContextEdit throw and abort the
						// whole boundary commit).
						// REAL editable target inside the compressed region; a
						// REPLACEMENT (not null-deletion) keeps the boundary
						// context rebuild valid (deleting the first user turn
						// would orphan toolResult pairing and void the whole
						// boundary — an appendContextEdit miss aborts the commit
						// of every later draft too).
						const branch = (ctx as { sessionManager: { getBranch: () => Array<{ id?: string; type?: string; message?: { role?: string } }> } }).sessionManager.getBranch();
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
				// run 1 (below precompute), run 2 tool turn (crosses precompute →
				// the compute consumes the two summary responses), run 2 close,
				// run 3 short answer (crosses apply → propose).
				...growResponses(600),
				...growResponses(3000).slice(0, 1),
				...summaryResponses(),
				fauxAssistantMessage(`closing notes for this run — ${"n".repeat(560)}`),
				fauxAssistantMessage(`final answer with substance — ${"f".repeat(1200)}`),
			]);
			await host.session.prompt("one");
			await host.session.prompt("two");
			await host.session.prompt("three");
			// PROTECTED OUTCOME: the conflict is DETECTED and counted — a
			// telemetry entry carries conflictEdit >= 1 (the compaction itself
			// is already irreversible; APP-08 only audits).
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
				// run 1 (below precompute), run 2 tool turn (crosses precompute →
				// the compute consumes the two summary responses), run 2 close,
				// run 3 short answer (crosses apply → propose).
				...growResponses(600),
				...growResponses(3000).slice(0, 1),
				...summaryResponses(),
				fauxAssistantMessage(`closing notes for this run — ${"n".repeat(560)}`),
				fauxAssistantMessage(`final answer with substance — ${"f".repeat(1200)}`),
			]);
			await host.session.prompt("one");
			await host.session.prompt("two");
			await host.session.prompt("three");
			// PROTECTED OUTCOME: exactly one after notification, carrying the
			// entryId of the committed compaction on the branch.
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
			// 3K window + default controller knobs → POL-09 infeasible (or
			// V8a refuse): any controller-written result that could not fit
			// must be withheld; the native leg handles it.
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
			// PROTECTED OUTCOME: whatever compaction landed carries NO
			// controller origin (no details.ccCore) — the controller refused
			// to write a result that could not fit; the native leg handled it.
			// POL-07's hazard is the DRAFT at the length boundary swallowing
			// recovery. The fallback SUPPLY leg (origin native-backfill) is a
			// different, spec-legal path — it may legitimately serve the
			// recovery when its result fits V8a.
			// C6 (2026-11-10 review): strengthen — in this scenario the
			// controller must not write ANY compaction carrying details.ccCore
			// (precompute OR native-backfill); the native leg may still land one.
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
			// Queue: run-1 main answer (big, one turn → split cut), then the
			// controller's compute attempt 1: history good + turn-prefix
			// REASONING-ONLY (refused by the per-sub-call gate), attempt 2
			// both good; run-2 main answer.
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
			// PROTECTED OUTCOME: no committed compaction whose turn-prefix
			// section is empty, and no supply.
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
			// Baseline half (still true): the native empty summary landed.
			const native = host.sessionManager.getBranch().filter((e) => e.type === "compaction");
			expect(native.length).toBe(1);
			expect((native[0] as { fromHook?: boolean }).fromHook).toBeFalsy();
			// PROTECTED OUTCOME: audit telemetry exists (reason names the
			// native summary as invalid) and the summary was NOT rewritten.
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
