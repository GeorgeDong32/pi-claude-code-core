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
