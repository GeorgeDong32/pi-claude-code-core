/**
 * Goal audit view-only contract (2026-11-02) — the GOAL_AUDIT_ENTRY trio
 * (started / passed / approved) is display-only: every emission carries
 * details.viewOnly=true and the goal context handler drops those messages
 * from model requests, so the audit conclusion reaches the model exactly
 * once (through the update_goal tool result). Prevents the auditor report
 * being injected twice and baiting the model into answering it again.
 * Legacy entries without the flag stay visible (backward compatible).
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { FakeHost, clearCoreGlobals, restoreCoreGlobals, snapshotCoreGlobals } from "../../../test/contracts/fake-host.ts";
import { resetCoreBusForTests } from "../../bus.ts";
import goalExtension from "../goal.ts";
import { createGoal } from "../goal-record.ts";
import { writeActiveGoalFile } from "../storage/goal-files.ts";

let prevHome: string | undefined;
let globalsSnapshot: Record<string, unknown>;

test.beforeEach(() => {
	globalsSnapshot = snapshotCoreGlobals();
	clearCoreGlobals();
	resetCoreBusForTests();
	prevHome = process.env.HOME;
});
test.afterEach(() => {
	if (prevHome === undefined) delete process.env.HOME;
	else process.env.HOME = prevHome;
	restoreCoreGlobals(globalsSnapshot);
});

const OBJECTIVE = "Ship it:\n[C1] first criterion";

async function setupGoal() {
	const home = mkdtempSync(join(tmpdir(), "gv-home-"));
	process.env.HOME = home;
	const cwd = mkdtempSync(join(tmpdir(), "gv-proj-"));
	const host = new FakeHost();
	const auditor = async () => ({ approved: true, disapproved: false, output: "<approved/>", model: "fake-auditor" });
	goalExtension(host.asPi(), { auditor: auditor as never } as never);
	const ctx = host.makeCtx({ cwd, ui: true, idle: true });
	const record = createGoal({ objective: OBJECTIVE, autoContinue: false, sisyphus: false }, Date.UTC(2026, 10, 2));
	writeActiveGoalFile({ cwd }, record);
	await host.fire("session_start", { reason: "new" }, ctx);
	await host.fire("turn_start", {}, ctx);
	const cleanup = () => {
		rmSync(home, { recursive: true, force: true });
		rmSync(cwd, { recursive: true, force: true });
	};
	return { host, ctx, cwd, cleanup };
}

test("audit emissions carry details.viewOnly; agent_settled flush too; context drops them", async () => {
	const f = await setupGoal();
	try {
		await f.host.tools.get("update_goal")!.execute(
			"t0",
			{ status: "complete", completionSummary: "done [C1] with evidence" },
			undefined,
			undefined,
			f.ctx as never,
		);
		const audits = f.host.sentMessages
			.map((m) => m.message as { customType?: string; details?: { phase?: string; viewOnly?: boolean } })
			.filter((m) => m.customType === "pi-goal-audit-event");
		const phases = audits.map((m) => m.details?.phase);
		assert.ok(phases.includes("started"), "started event emitted");
		assert.ok(phases.includes("passed"), "passed event emitted");
		for (const m of audits) {
			assert.equal(m.details?.viewOnly, true, `phase ${m.details?.phase} is view-only`);
		}

		// the held approved marker flushes after the finishing turn settles
		await f.host.fire("agent_settled", {}, f.ctx);
		await new Promise((resolve) => setTimeout(resolve, 10));
		const approved = f.host.sentMessages
			.map((m) => m.message as { customType?: string; details?: { phase?: string; viewOnly?: boolean } })
			.find((m) => m.customType === "pi-goal-audit-event" && m.details?.phase === "approved");
		assert.ok(approved, "approved marker flushed after agent_settled");
		assert.equal(approved.details?.viewOnly, true, "approved marker is view-only");

		// context handler: view-only audit events are dropped from model
		// requests; legacy entries (no flag) and other messages stay.
		const messages = [
			{ role: "user", content: "hi", timestamp: 1 },
			{ role: "custom", customType: "pi-goal-audit-event", content: "Auditor: starting", display: true, details: { phase: "started", goalId: "g1", viewOnly: true }, timestamp: 2 },
			{ role: "custom", customType: "pi-goal-audit-event", content: "Auditor: legacy", display: true, details: { phase: "passed", goalId: "g1" }, timestamp: 3 },
			{ role: "assistant", content: [{ type: "text", text: "work" }], timestamp: 4 },
		];
		const handlers = (f.host as unknown as { handlers: Map<string, Array<(e: unknown, c: unknown) => Promise<unknown>>> }).handlers;
		let filtered: unknown;
		for (const h of handlers.get("context") ?? []) {
			const result = (await h({ type: "context", messages }, f.ctx)) as { messages?: unknown } | undefined;
			if (result?.messages) filtered = result.messages;
		}
		const kept = filtered as Array<{ customType?: string; role?: string; content?: unknown }>;
		assert.ok(Array.isArray(kept), "context handler returned a message list");
		const keptAudits = kept.filter((m) => m.customType === "pi-goal-audit-event");
		assert.equal(keptAudits.length, 1, "only the legacy (non-viewOnly) audit entry survives");
		assert.equal((keptAudits[0] as { details?: { viewOnly?: boolean } }).details?.viewOnly, undefined);
		assert.equal(kept.filter((m) => m.role === "user").length, 1, "normal user message survives");
		assert.equal(kept.filter((m) => m.role === "assistant").length, 1, "assistant message survives");
	} finally {
		f.cleanup();
	}
});
