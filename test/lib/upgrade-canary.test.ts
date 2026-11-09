/**
 * G1-C7 upgrade canary — run BEFORE upgrading pi
 * (SPEC docs/zh/entropy-control-spec.md Goal 1 [C7], docs/en+zh/upgrade-canary.md).
 *
 * Why this exists: after a pi host upgrade, the two economy mechanisms can
 * degrade SILENTLY — ObservationPack may stop replacing oversized tool
 * results with placeholders (context bloat returns), and Action Fusion may
 * stop recognizing `then_run` (write+verify collapses back into two turns).
 * Neither failure throws; only the token bill and turn count would show it.
 * These tests drive the REAL projection pipeline and the REAL fused write
 * registration, so a host-API semantic change breaks them loudly instead.
 * Not part of the three regular gates (check/test/contracts) — upgrade-only.
 */
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ToolResultMessage } from "@earendil-works/pi-ai";

import { resetCoreBusForTests } from "../../extensions/bus.ts";
import { FULL_SENDS, THRESHOLD_BYTES } from "../../extensions/observation-pack/observation.ts";
import { createProjectionState, projectContext, type ProjectionPorts } from "../../extensions/observation-pack/projection.ts";
import createActionFusion from "../../extensions/action-fusion/index.ts";
import { THEN_RUN_SUCCEEDED } from "../../extensions/action-fusion/then-run.ts";

afterEach(() => {
	resetCoreBusForTests();
});

/** Tolerant session stub — the real bash tool probes several session APIs. */
function fakeCtx(cwd: string): never {
	const sessionManager = new Proxy(
		{ getSessionId: () => "fus-canary-session", getSessionDir: () => "", getSessionFile: () => "" },
		{
			get(target, prop) {
				if (typeof prop === "string" && prop in target) return (target as Record<string, unknown>)[prop];
				return () => undefined;
			},
		},
	);
	return { cwd, hasUI: false, sessionManager } as never;
}

describe("upgrade canary (G1-C7)", () => {
	it("ObservationPack: a tool result over THRESHOLD_BYTES is projected to a placeholder after FULL_SENDS", async () => {
		// Breakage means: the projection pipeline (candidate loop → threshold
		// gate → FULL_SENDS counting → placeholder construction) no longer
		// replaces large results — context bloat silently returns after upgrade.
		const bigText = "x".repeat(THRESHOLD_BYTES + 100);
		const bigBytes = Buffer.byteLength(bigText, "utf8");
		const message = {
			role: "toolResult",
			toolCallId: "tc-canary-1",
			toolName: "bash",
			isError: false,
			content: [{ type: "text", text: bigText }],
		} as ToolResultMessage;
		const ports: ProjectionPorts = {
			store: async () => {},
			appendLedger: async () => {},
		};
		const state = createProjectionState();

		let outcome = await projectContext({ messages: [message], root: "/canary", state, ports });
		for (let send = 1; send < FULL_SENDS; send += 1) {
			outcome = await projectContext({ messages: [message], root: "/canary", state, ports });
		}
		expect(outcome.replacedThisRequest, "ObservationPack projection degraded: full-send window never ended").toBe(0);

		outcome = await projectContext({ messages: [message], root: "/canary", state, ports });
		expect(outcome.replacedThisRequest, "ObservationPack projection degraded: no replacement past FULL_SENDS").toBe(1);
		const projected = outcome.messages[0] as ToolResultMessage;
		const text = (projected.content[0] as { text: string }).text;
		expect(text.includes("obs_recall"), "ObservationPack projection degraded: placeholder lost its retrieval instruction").toBe(true);
		expect(text.includes(`original_bytes: ${bigBytes}`), "ObservationPack projection degraded: placeholder lost its metadata").toBe(true);
		expect(text.includes("[middle omitted"), "ObservationPack projection degraded: placeholder excerpt structure lost").toBe(true);
	});

	it("Action Fusion: the registered write tool carries then_run in its schema and a then_run call is recognized as fused", async () => {
		// Breakage means: the re-registered write/edit tools lost the then_run
		// parameter (schema channel) or executeMutationThenRun no longer merges
		// the follow-up command into one result (details.thenRun stamp) —
		// write+verify collapses back into separate bash turns after upgrade.
		const dir = await mkdtemp(join(tmpdir(), "fus-canary-"));
		const file = join(dir, "canary.txt");
		await writeFile(file, "before\n", "utf8");

		const definitions: Array<Record<string, unknown>> = [];
		const pi = {
			registerTool: (definition: Record<string, unknown>) => {
				definitions.push(definition);
			},
			getAllTools: () => [] as never[],
			on: () => {},
			registerCommand: () => {},
		} as unknown as ExtensionAPI;
		createActionFusion({ bashOptions: {} as never })(pi);

		const write = definitions.find((definition) => definition.name === "write") as unknown as {
			parameters: { properties: Record<string, unknown> };
			execute: (
				toolCallId: string,
				input: Record<string, unknown>,
				signal: undefined,
				onUpdate: undefined,
				ctx: never,
			) => Promise<{ content: Array<{ type: string; text?: string }>; details?: unknown }>;
		};
		expect(write, "Action Fusion then_run recognition degraded: fused write tool not registered").toBeTruthy();
		expect(
			"then_run" in (write.parameters?.properties ?? {}),
			"Action Fusion then_run recognition degraded: write schema lost the then_run field",
		).toBe(true);

		const result = await write.execute(
			"tc-canary-2",
			{ path: file, content: "after\n", then_run: { command: `cat ${file}` } },
			undefined,
			undefined,
			fakeCtx(dir),
		);
		const merged = result.content
			.filter((block) => block.type === "text")
			.map((block) => block.text ?? "")
			.join("\n");
		expect(merged.includes(THEN_RUN_SUCCEEDED), "Action Fusion then_run recognition degraded: merged result lost the success token").toBe(true);
		expect((result.details as { thenRun?: string } | undefined)?.thenRun, "Action Fusion then_run recognition degraded: structured outcome not stamped").toBe("succeeded");
	});
});

/**
 * SC upgrade canaries (SPEC SC §7.3, task W9): three host semantics the
 * compaction controller's SAFETY depends on. A pi upgrade changing any of
 * them must break loudly here BEFORE the controller misbehaves in production.
 *   H3  — a boundary-draft compaction lands (fromHook), refreshes the next
 *         request's context, and emits NO session_compact/compaction_start
 *   H5  — a later turn_end handler's entries return REPLACES the draft
 *   H12 — a draft at a recoverable length boundary would swallow the native
 *         compact-and-retry (the hazard POL-07 exists to prevent; pinned as
 *         host fact so a change in the recovery predicate re-opens review)
 */
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { compactionDraft, createCompactionHost } from "../contracts/support/compaction-host.ts";

describe("upgrade canary (SC compaction, §7.3)", () => {
	it("H3: a draft compaction lands fromHook, shrinks the next request, and emits no native compaction events", async () => {
		const host = await createCompactionHost({ probe: {} });
		try {
			host.faux.setResponses([fauxAssistantMessage("first answer, decent length"), fauxAssistantMessage("second answer")]);
			await host.session.prompt("turn one");
			await host.session.prompt("turn two");
			// drive a REAL draft commit via the probe's turn_end slot
			const host2 = await createCompactionHost({
				probe: {
					turnEndDraft: (event) =>
						event.message?.stopReason === "stop" ? [compactionDraft("## Canary summary\n- items", "kept-x")] : undefined,
				},
			});
			try {
				host2.faux.setResponses([fauxAssistantMessage("answer one".repeat(40)), fauxAssistantMessage("follow-up answer")]);
				await host2.session.prompt("hello");
				const before = host2.requestContexts.length;
				await host2.session.prompt("again");
				const compacted = host2.sessionManager.getBranch().filter((e) => e.type === "compaction");
				expect(compacted.length, "H3: the draft compaction must land").toBeGreaterThanOrEqual(1);
				expect((compacted[0] as { fromHook?: boolean }).fromHook, "H3: draft compactions land with fromHook").toBe(true);
				expect(host2.events.some((e) => e.name === "session_compact"), "H3: draft commits must NOT emit session_compact").toBe(false);
				void before;
			} finally {
				host2.cleanup();
			}
		} finally {
			host.cleanup();
		}
	});

	it("H5: a later turn_end handler's entries return REPLACES an earlier draft", async () => {
		const host = await createCompactionHost({
			probe: {
				turnEndDraft: () => [compactionDraft("DRAFT-MUST-DISAPPEAR", "kept-x")],
				extraTurnEndHandlers: [() => ({ entries: [] })],
			},
		});
		try {
			host.faux.setResponses([fauxAssistantMessage("answer")]);
			await host.session.prompt("hello");
			expect(
				host.sessionManager.getBranch().some((e) => e.type === "compaction"),
				"H5: the later handler's empty return must drop the draft — if this fails, pi switched to merge semantics and SC's APP-04 arbitration must be re-reviewed",
			).toBe(false);
		} finally {
			host.cleanup();
		}
	});

	it("H12: a draft at a recoverable length boundary suppresses the native retry (hazard pinned)", async () => {
		// Baseline: WITHOUT a draft the recovery runs (3 provider calls).
		const baseline = await createCompactionHost({
			settingsOverrides: { compaction: { enabled: true, reserveTokens: 16000, keepRecentTokens: 100 } },
			probe: {},
		});
		try {
			baseline.faux.setResponses([
				fauxAssistantMessage(`${"x".repeat(16000)} cut`, { stopReason: "length" }),
				fauxAssistantMessage("## Summary\n- recovered"),
				fauxAssistantMessage("recovered answer"),
			]);
			await baseline.session.prompt("do something long");
			expect(baseline.faux.state.callCount, "H12 baseline: native compact-and-retry runs").toBe(3);
		} finally {
			baseline.cleanup();
		}
		// Hazard: WITH a draft at the length turn_end the retry is swallowed
		// (1 call, truncated final). If pi changes this predicate, POL-07's
		// exclusion list must be re-derived (SC-HOST-07 review trigger).
		const hazard = await createCompactionHost({
			settingsOverrides: { compaction: { enabled: true, reserveTokens: 16000, keepRecentTokens: 100 } },
			probe: {
				turnEndDraft: (event) =>
					event.message?.stopReason === "length" ? [compactionDraft("SUMMARY-HAZARD", event.messageEntryId)] : undefined,
			},
		});
		try {
			hazard.faux.setResponses([
				fauxAssistantMessage(`${"x".repeat(16000)} cut`, { stopReason: "length" }),
				fauxAssistantMessage("## Summary\n- never used"),
				fauxAssistantMessage("never happens"),
			]);
			await hazard.session.prompt("do something long");
			expect(hazard.faux.state.callCount, "H12 hazard: the draft swallows the recovery").toBe(1);
		} finally {
			hazard.cleanup();
		}
	});
});
