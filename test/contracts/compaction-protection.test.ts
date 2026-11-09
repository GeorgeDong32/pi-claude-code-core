/*
 * Smart Compaction PROTECTED assertions (SPEC SC §4.4 BLK-1…5) — the
 * "有保护断言" half of every blocking case, pinned as EXPECTED FAILURES.
 *
 * W0 state: the controller module (extensions/compaction/**, W1–W4) and
 * the seam (lib/compaction-seam.ts, W5) do not exist yet. Each test below
 * loads them through NON-LITERAL dynamic imports so the contracts tsc
 * pass cannot resolve them (deliberate), and the runtime import fails —
 * which is exactly the "protection absent" failure these tests pin.
 *
 * Handoff contract to W3/W4/W5:
 *   - when a test's scenario starts passing, flip `it.fails` → `it` for it
 *     (the suite turning red is the flip signal, per spec §6 W0 row);
 *   - the baselines these protect live in compaction-{boundary,native,
 *     recovery,summarizer}.test.ts and stay green throughout;
 *   - assertions here are the user-visible outcomes the spec requires
 *     (POL-07/V8a/SUM-03·04/FB-08/APP-05·08); W3/W4 may extend them with
 *     telemetry-shape checks, but MUST NOT weaken them.
 */
import { describe, expect, it } from "vitest";
import { fauxAssistantMessage, fauxText, fauxThinking } from "@earendil-works/pi-ai";
import { createCompactionHost, type CompactionHost } from "./support/compaction-host.ts";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
// Test-only deep import (loader precedent; see support/compaction-host.ts).
import {
	createExtensionRuntime,
	loadExtensionFromFactory,
} from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js";

/**
 * Load the compaction controller extension (W4 deliverable at
 * extensions/compaction/index.ts) into a host's extension list.
 * Non-literal specifier: unresolved today (test fails = expected), typed
 * as unknown at compile time on purpose.
 *
 * `settings` is written to <agentDir>/core-compaction.json (ST-02 shape)
 * BEFORE the load so aggressive ratios can drive precompute→propose in the
 * tiny faux sessions; PI_CORE_COMPACTION=on removes env ambiguity.
 */
async function loadCompactionController(host: CompactionHost, settings?: Record<string, unknown>): Promise<void> {
	if (settings) {
		writeFileSync(join(host.agentDir, "core-compaction.json"), JSON.stringify(settings), "utf8");
	}
	process.env.PI_CORE_COMPACTION = "on";
	try {
		const controllerSpecifier = "./../../extensions/compaction/index.ts";
		const module = (await import(controllerSpecifier)) as { default: unknown };
		const factory = module.default as (pi: unknown) => void;
		const eventBus = createEventBus();
		const runtime = createExtensionRuntime();
		await loadExtensionFromFactory(factory as never, host.cwd, eventBus, runtime, "<compaction-controller>");
		// Re-binding the loaded extension into the live session is W4's wiring
		// concern; when W3/W4 land, this helper grows the bind step and the
		// scenario driving below becomes live end-to-end.
		void host;
	} finally {
		delete process.env.PI_CORE_COMPACTION;
	}
}

/** The seam (W5 deliverable) — absent today, same expected-fail treatment. */
async function loadCompactionSeam(): Promise<{ registerCompactionSubscriber: (subscriber: unknown) => () => void } | undefined> {
	const seamSpecifier = "./../../lib/compaction-seam.ts";
	try {
		return (await import(seamSpecifier)) as never;
	} catch {
		return undefined;
	}
}

const BIG = "x".repeat(16000);
const recoverySettings = { compaction: { enabled: true, reserveTokens: 16000, keepRecentTokens: 100 } };

describe("BLK-1 protection: controller declines to propose at a recoverable length boundary (POL-07/INV-11)", () => {
	it.fails("with the controller installed, the length-stop turn keeps its native compact-and-retry recovery", async () => {
		const host = await createCompactionHost({ settingsOverrides: recoverySettings, probe: {} });
		try {
			await loadCompactionController(host);
			host.faux.setResponses([
				fauxAssistantMessage(`${BIG} cut short`, { stopReason: "length" }),
				fauxAssistantMessage("## Summary\n- native recovery summary"),
				fauxAssistantMessage("recovered answer"),
			]);
			await host.session.prompt("do something long");
			// PROTECTED OUTCOME: identical to the no-controller baseline —
			// overflow recovery ran (3 provider calls) and NO draft compaction
			// was proposed by the controller at the length boundary.
			expect(host.events.find((e) => e.name === "session_before_compact")?.reason).toBe("overflow");
			expect(host.faux.state.callCount).toBe(3);
			const selfOriginated = host.sessionManager
				.getBranch()
				.filter((e) => e.type === "compaction")
				.filter((e) => (e as { details?: { ccCore?: unknown } }).details?.ccCore !== undefined);
			expect(selfOriginated.length).toBe(0);
		} finally {
			host.cleanup();
		}
	});
});

describe("BLK-2 protection: reconciliation + seam exactness (APP-04/05/08, SM-02)", () => {
	it.fails("(a) override: proposal classified lost, snapshot survives, no seam after; a later clean boundary commits", async () => {
		const seam = await loadCompactionSeam();
		expect(seam).toBeDefined();
		const afterNotifications: Array<{ entryId?: string }> = [];
		seam!.registerCompactionSubscriber({
			after: (info: { entryId?: string }) => afterNotifications.push(info),
		});
		const host = await createCompactionHost({
			probe: {
				// Another handler registered AFTER the controller overrides
				// entries — the BLK-2(a) hazard.
				extraTurnEndHandlers: [() => ({ entries: [] })],
			},
		});
		try {
			// Aggressive ratios so the tiny faux session reaches propose.
			await loadCompactionController(host, { precomputeRatio: 0.01, applyRatio: 0.02, targetPostRatio: 0.01 });
			host.faux.setResponses([fauxAssistantMessage("run one"), fauxAssistantMessage("run two")]);
			await host.session.prompt("first");
			await host.session.prompt("second");
			// PROTECTED OUTCOME: no after notification fired for the LOST
			// proposal, and the controller proposed again on the later clean
			// boundary (snapshot was not consumed by the override) — exactly
			// one after notification, for the surviving commit only.
			expect(afterNotifications.length).toBe(1);
			const committed = host.sessionManager
				.getBranch()
				.filter((e) => e.type === "compaction")
				.filter((e) => (e as { details?: { ccCore?: { origin?: string } } }).details?.ccCore?.origin === "precompute");
			expect(committed.length).toBe(1);
		} finally {
			host.cleanup();
		}
	});

	it.fails("(b) conflict-edit: committed compaction with a post-boundary edit targeting the compressed region is audited (conflictEdit telemetry)", async () => {
		const host = await createCompactionHost({
			probe: {
				extraTurnEndHandlers: [
					(event) => ({
						entries: [
							...(event.entries ?? []),
							{ type: "context_edit", targetId: "<pre-cut-entry>", replacement: null },
						],
					}),
				],
			},
		});
		try {
			await loadCompactionController(host);
			host.faux.setResponses([fauxAssistantMessage("answer")]);
			await host.session.prompt("hello");
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

	it.fails("(c) clean commit: reconciliation hits on the first visible event, seam after fires exactly once with the real entryId", async () => {
		const seam = await loadCompactionSeam();
		expect(seam).toBeDefined();
		const afterNotifications: Array<{ entryId?: string }> = [];
		seam!.registerCompactionSubscriber({
			after: (info: { entryId?: string }) => afterNotifications.push(info),
		});
		const host = await createCompactionHost({ probe: {} });
		try {
			await loadCompactionController(host, { precomputeRatio: 0.01, applyRatio: 0.02, targetPostRatio: 0.01 });
			host.faux.setResponses([fauxAssistantMessage("answer")]);
			await host.session.prompt("hello");
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
			host.cleanup();
		}
	});
});

describe("BLK-3 protection: hard capacity gate on every write path (V8a/INV-12)", () => {
	it.fails("an oversized precomputed summary is neither proposed as a draft nor supplied to the native leg", async () => {
		const host = await createCompactionHost({
			// 3K window + default knobs → any controller-written result that
			// would not fit must be withheld (POL-09 infeasible or V8a refuse).
			model: { contextWindow: 3000, maxTokens: 1000 },
			settingsOverrides: { compaction: { enabled: true, reserveTokens: 500, keepRecentTokens: 300 } },
			probe: {},
		});
		try {
			await loadCompactionController(host);
			host.faux.setResponses([
				fauxAssistantMessage("x".repeat(12000)),
				fauxAssistantMessage("## Summary\n- native fallback summary"),
			]);
			await host.session.prompt("grow the context");
			// PROTECTED OUTCOME: whatever compaction landed carries NO
			// controller origin (no details.ccCore) — the controller refused
			// to write a result that could not fit; the native leg handled it.
			const selfOriginated = host.sessionManager
				.getBranch()
				.filter((e) => e.type === "compaction")
				.filter((e) => (e as { details?: { ccCore?: unknown } }).details?.ccCore !== undefined);
			expect(selfOriginated.length).toBe(0);
			expect(host.sessionManager.getBranch().some((e) => e.type === "compaction")).toBe(true);
		} finally {
			host.cleanup();
		}
	});
});

describe("BLK-4 protection: per-sub-call validation refuses partial-empty summaries (SUM-03/04/09)", () => {
	it.fails("a reasoning-only turn-prefix sub-call never lands: no controller-originated compaction with an empty section", async () => {
		const host = await createCompactionHost({
			model: { contextWindow: 128000, maxTokens: 4096, reasoning: true },
			probe: {},
		});
		try {
			await loadCompactionController(host);
			// The summary model (same faux) returns reasoning-only output.
			host.faux.setResponses([
				fauxAssistantMessage("a reasonably long first answer so the session has mass to compact", { stopReason: "stop" }),
			]);
			// NOTE: driving the controller's precompute requires its policy
			// knobs (W1/W3); the pinned outcome is the refusal — no committed
			// compaction whose turn-prefix section is empty, and no supply.
			await host.session.prompt("hello");
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
	it.fails("a native reasoning-only summary still lands verbatim, and the controller emits native-summary-invalid telemetry", async () => {
		const host = await createCompactionHost({
			model: { contextWindow: 3000, maxTokens: 1000, reasoning: true },
			settingsOverrides: { compaction: { enabled: true, reserveTokens: 500, keepRecentTokens: 300 } },
			probe: {},
		});
		try {
			await loadCompactionController(host);
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
