/**
 * goal-turn-lock.test.ts — SPEC 2026-10-07 P0-2 acceptance tests.
 *
 * CURRENT BATCH SCOPE (D3 undecided): only CORE-05 / L6 — the drafting
 * send-failure reset. The turn-lock strategy (L1-L5, L7) and the G3
 * args→input field fix are EXPLICITLY DEFERRED to the D3 decision batch;
 * they must land together and the field fix must NOT ship alone (spec §6).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import goalExtension from "../goal.ts";
import { FakeHost } from "../../../test/contracts/fake-host.ts";
import { coreBus, resetCoreBusForTests } from "../../bus.ts";
import { PROPOSE_DRAFT_TOOL_NAME, QUESTION_TOOL_NAME } from "../goal-tool-names.ts";

function setupWithPi(patch?: (pi: Record<string, unknown>) => void) {
	resetCoreBusForTests();
	const cwd = mkdtempSync(path.join(tmpdir(), "pi-goal-lock-"));
	const host = new FakeHost();
	const pi = host.asPi() as Record<string, unknown>;
	patch?.(pi);
	goalExtension(pi as never);
	const ctx = host.makeCtx({ cwd, ui: true });
	return { cwd, host, ctx, cleanup: () => rmSync(cwd, { recursive: true, force: true }) };
}

test("L6 (CORE-05): a throwing sendMessage resets confirmationIntent and restores the non-drafting tool set", async () => {
	const f = setupWithPi((pi) => {
		pi.sendMessage = () => {
			throw new Error("simulated send failure");
		};
	});
	try {
		await f.host.commands.get("goal")!("fix the bug", f.ctx as never);
		// the error is surfaced (direct notify or the bus tail queue), not swallowed
		const busMsgs = (coreBus().snapshot().notifications ?? []).map((n) => n.msg);
		assert.ok(
			[...f.host.notifications, ...busMsgs].some((n) => n.includes("Could not start")),
			"failure notice must be surfaced",
		);
		// the LAST tool-set sync reflects the reset: drafting-only tools are
		// gone, the always-available commit tool remains
		const last = f.host.activeToolsCalls[f.host.activeToolsCalls.length - 1]!;
		assert.ok(!last.includes(QUESTION_TOOL_NAME), `goal_question must not stay active after a failed draft start (got: ${last.join(",")})`);
		assert.ok(last.includes(PROPOSE_DRAFT_TOOL_NAME));
	} finally {
		f.cleanup();
	}
});

test("L6 control: a SUCCESSFUL draft start keeps the drafting tool set", async () => {
	const f = setupWithPi();
	try {
		await f.host.commands.get("goal")!("fix the bug", f.ctx as never);
		const last = f.host.activeToolsCalls[f.host.activeToolsCalls.length - 1]!;
		assert.ok(last.includes(QUESTION_TOOL_NAME), "drafting phase exposes goal_question");
	} finally {
		f.cleanup();
	}
});
