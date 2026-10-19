/**
 * Entropy-control G3 integration tests ([C20]/[C21]) — driving the REAL
 * update_goal path (docs/zh/entropy-control-spec.md).
 *
 * [C20] a completion request whose summary lacks objective [Cn] lines gets
 *       exactly ONE followUp (triggerTurn:false) reminder listing the missing
 *       numbers, and the audit STARTS anyway; full coverage sends no reminder;
 *       objectives without numbered criteria never remind.
 * [C21] the third audit attempt (auditAttempts=2 on disk → 3rd try) surfaces
 *       a one-time UI warning; earlier attempts stay silent.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { FakeHost, clearCoreGlobals, restoreCoreGlobals, snapshotCoreGlobals } from "../../../test/contracts/fake-host.ts";
import { resetCoreBusForTests, coreBus } from "../../bus.ts";
import goalExtension from "../goal.ts";
import { createGoal } from "../goal-record.ts";
import { writeActiveGoalFile } from "../storage/goal-files.ts";

// the shared-notify host leg needs a live non-consuming cctui replica
const CCTUI_LIVE = { active: true, notificationsConsumer: false } as const;

let prevHome: string | undefined;
let globalsSnapshot: Record<string, unknown>;

test.beforeEach(() => {
	globalsSnapshot = snapshotCoreGlobals();
	clearCoreGlobals();
	(globalThis as Record<string, unknown>).__piCcTui = CCTUI_LIVE;
	resetCoreBusForTests();
	prevHome = process.env.HOME;
});
test.afterEach(() => {
	delete (globalThis as Record<string, unknown>).__piCcTui;
	if (prevHome === undefined) delete process.env.HOME;
	else process.env.HOME = prevHome;
	restoreCoreGlobals(globalsSnapshot);
});


interface AuditorCall {
	objective: string;
	completionSummary?: string;
}

/** A goal with a custom objective + auditAttempts seed, focused and running. */
async function setupGoal(opts: { objective: string; auditAttempts?: number; auditor?: (call: AuditorCall) => Promise<{ approved: boolean; disapproved: boolean; output: string; model: string }> }) {
	const home = mkdtempSync(join(tmpdir(), "g3i-home-"));
	process.env.HOME = home;
	const cwd = mkdtempSync(join(tmpdir(), "g3i-proj-"));
	const host = new FakeHost();
	const calls: AuditorCall[] = [];
	const auditor =
		opts.auditor ??
		(async (call: AuditorCall) => {
			calls.push(call);
			return { approved: true, disapproved: false, output: "<approved/>", model: "fake-auditor" };
		});
	goalExtension(host.asPi(), { auditor: auditor as never } as never);
	const ctx = host.makeCtx({ cwd, ui: true, idle: true });
	const record = createGoal({ objective: opts.objective, autoContinue: false, sisyphus: false }, Date.UTC(2026, 9, 8));
	if (opts.auditAttempts !== undefined) (record as { auditAttempts?: number }).auditAttempts = opts.auditAttempts;
	writeActiveGoalFile({ cwd }, record);
	await host.fire("session_start", { reason: "new" }, ctx);
	await host.fire("turn_start", {}, ctx);
	const cleanup = () => {
		rmSync(home, { recursive: true, force: true });
		rmSync(cwd, { recursive: true, force: true });
	};
	return { host, ctx, calls, cleanup };
}

const OBJECTIVE = "Ship it:\n[C1] first criterion\n[C2] second criterion\n[C3] third criterion";

test("[C20] missing [Cn] lines → ONE followUp reminder listing them, audit still starts", async () => {
	const f = await setupGoal({ objective: OBJECTIVE });
	try {
		const res = (await f.host.tools.get("update_goal")!.execute("t", { status: "complete", completionSummary: "done [C1] with evidence" }, undefined, undefined, f.ctx as never)) as { terminate?: boolean };
		const reminders = f.host.sentMessages.filter((m) => (m.message as { customType?: string }).customType === "pi-goal-missing-criteria");
		assert.equal(reminders.length, 1, "exactly one reminder");
		const content = (reminders[0]!.message as { content: string }).content;
		assert.ok(content.includes("[C2]") && content.includes("[C3]"), `reminder lists the missing numbers (got: ${content})`);
		assert.ok(!content.includes("[C1]"), "covered criterion not flagged");
		assert.equal((reminders[0]!.opts as { triggerTurn?: boolean } | undefined)?.triggerTurn, false, "non-triggering followUp");
		assert.equal(f.calls.length, 1, "the audit STARTED despite the missing lines");
		assert.equal(res.terminate, true, "approved audit completes as usual");
	} finally {
		f.cleanup();
	}
});

test("[C20] full coverage → no reminder, audit starts", async () => {
	const f = await setupGoal({ objective: OBJECTIVE });
	try {
		await f.host.tools.get("update_goal")!.execute("t", { status: "complete", completionSummary: "[C1] done; [C2] done; [C3] done" }, undefined, undefined, f.ctx as never);
		assert.equal(f.host.sentMessages.filter((m) => (m.message as { customType?: string }).customType === "pi-goal-missing-criteria").length, 0, "no reminder on full coverage");
		assert.equal(f.calls.length, 1);
	} finally {
		f.cleanup();
	}
});

test("[C20] objective without numbered criteria → never reminds", async () => {
	const f = await setupGoal({ objective: "Just ship the decoder." });
	try {
		await f.host.tools.get("update_goal")!.execute("t", { status: "complete", completionSummary: "shipped" }, undefined, undefined, f.ctx as never);
		assert.equal(f.host.sentMessages.filter((m) => (m.message as { customType?: string }).customType === "pi-goal-missing-criteria").length, 0);
		assert.equal(f.calls.length, 1);
	} finally {
		f.cleanup();
	}
});

test("[C21] the third audit attempt surfaces one UI warning; the first does not", async () => {
	const third = await setupGoal({ objective: OBJECTIVE, auditAttempts: 2 });
	try {
		await third.host.tools.get("update_goal")!.execute("t3", { status: "complete", completionSummary: "[C1] [C2] [C3] done" }, undefined, undefined, third.ctx as never);
		const surface = [...third.host.notifications, ...(coreBus().snapshot().notifications ?? []).map((n) => n.msg)];
		assert.ok(surface.some((n) => n.includes("third completion attempt")), `warning surfaced (got: ${JSON.stringify(surface)})`);
	} finally {
		third.cleanup();
	}
	resetCoreBusForTests(); // drop the third-attempt bus notice before the control run
	const first = await setupGoal({ objective: OBJECTIVE });
	try {
		await first.host.tools.get("update_goal")!.execute("t1", { status: "complete", completionSummary: "[C1] [C2] [C3] done" }, undefined, undefined, first.ctx as never);
		const surface = [...first.host.notifications, ...(coreBus().snapshot().notifications ?? []).map((n) => n.msg)];
		assert.ok(!surface.some((n) => n.includes("third completion attempt")), "no warning on the first attempt");
	} finally {
		first.cleanup();
	}
});
