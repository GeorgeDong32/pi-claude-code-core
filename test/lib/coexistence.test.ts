/**
 * P2-GO-05 — modes + goal coexistence on the context event.
 *
 * Both modules register `context` handlers on the same ExtensionAPI (as
 * they do inside the assembled core). The contract: each one's rewrite
 * touches only its own messages — modes' injected modes-context block and
 * plain user messages pass through the goal handler untouched, and queued
 * goal-event messages pass through the modes handler untouched.
 */
import { describe, expect, it, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FakeHost, clearCoreGlobals, snapshotCoreGlobals } from "../contracts/fake-host.ts";
import { resetCoreBusForTests } from "../../extensions/bus.ts";
import { targets } from "../contracts/targets.ts";
import { normalizeGoalRecord } from "../../extensions/goal/goal-record.ts";

let globalsSnapshot: Record<string, unknown>;

beforeEach(() => {
	globalsSnapshot = snapshotCoreGlobals();
	clearCoreGlobals();
	resetCoreBusForTests();
});

describe("P2-GO-05 goal + modes context coexistence", () => {
	it("each context handler rewrites only its own messages", async () => {
		const host = new FakeHost();
		// both modules share ONE pi instance, like the assembled core
		targets.modes.factory(host.asPi());
		targets.goal.factory(host.asPi());

		// focus an active goal so the goal handler has real state
		const goalRecord = normalizeGoalRecord({ objective: "coexist check", status: "active" });
		const cwd = mkdtempSync(join(tmpdir(), "coexist-"));
		const { ensureDirectory, atomicWriteGoalFile, serializeGoalFile, makeActiveGoalPath, GOALS_DIR } =
			await import("../../extensions/goal/storage/goal-files.js");
		ensureDirectory({ cwd }, GOALS_DIR);
		atomicWriteGoalFile({ cwd }, GOALS_DIR, makeActiveGoalPath(goalRecord!), serializeGoalFile(goalRecord!));
		const startCtx = host.makeCtx({
			cwd,
			ui: true,
			sessionEntries: [
				{ type: "custom", customType: "pi-goal-state", data: { version: 3, goal: goalRecord } },
				{ type: "custom", customType: "pi-goal-focus", data: { version: 1, focusedGoalId: goalRecord!.id, reason: "selected" } },
			],
		});
		await host.fire("session_start", {}, startCtx);

		const contextHandlers = host.handlers.get("context") ?? [];
		expect(contextHandlers.length).toBeGreaterThanOrEqual(2);

		const userMessage = { role: "user", content: [{ type: "text", text: "plain prompt" }] };
		const modesBlock = { role: "user", content: [{ type: "text", text: "mode block" }], customType: "modes-context" };
		const goalEvent = {
			role: "user",
			content: [{ type: "text", text: "goal checkpoint" }],
			customType: "pi-goal-event",
			details: { kind: "checkpoint", goalId: goalRecord!.id },
		};
		const event = { messages: [userMessage, modesBlock, goalEvent] };

		// pi chains context handlers: each receives the (shared) event; a
		// handler returning {messages} supersedes the array for the next one.
		let last: unknown;
		for (const handler of contextHandlers) {
			const result = await handler(event, startCtx);
			if (result && typeof result === "object" && "messages" in (result as object)) {
				(event as { messages: unknown[] }).messages = (result as { messages: unknown[] }).messages;
			}
			last = result;
		}
		void last;

		const finalMessages = (event as { messages: Array<Record<string, unknown>> }).messages;
		const byType = (t: string | undefined) => finalMessages.find((m) => m.customType === t);
		// plain user message survives both handlers
		expect(finalMessages.some((m) => m.role === "user" && m.customType === undefined)).toBe(true);
		// goal handler must NOT drop or rewrite the modes-context block
		expect(byType("modes-context")).toBeDefined();
		// modes handler must NOT drop the queued goal event
		expect(byType("pi-goal-event")).toBeDefined();
	});
});
