import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runCompletionAudit } from "../goal-audit-flow.ts";
import { runGoalCompletionAuditor, type AuditorSession } from "../goal-auditor.ts";
import type { GoalRecord } from "../goal-record.ts";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

function fakeCtx(cwd: string): ExtensionContext {
	return { cwd, hasUI: false, model: { provider: "test", id: "fake-aud" } } as unknown as ExtensionContext;
}

function target(): GoalRecord {
	return { id: "g1", status: "active", autoContinue: true, objective: "ship it", auditAttempts: 1 } as unknown as GoalRecord;
}

/** A session whose prompt() never settles — NOT even after abort(). pi's
 * AgentSession.abort() only promises that prompt() settles afterwards
 * (abort() itself awaits waitForIdle), so a stream that ignores the abort
 * signal hangs both — this is the violating shape the flow must survive. */
function neverSettlingSession(log: string[]): AuditorSession {
	return {
		subscribe(_listener: (event: unknown) => void) {
			log.push("subscribe");
			return () => log.push("unsubscribe");
		},
		prompt(_prompt: string) {
			log.push("prompt");
			return new Promise<void>(() => {});
		},
		async abort() {
			log.push("abort");
		},
		dispose() {
			log.push("dispose");
		},
	} as unknown as AuditorSession;
}

test("BH-E6: audit timeout with a never-settling prompt still aborts and disposes the session exactly once", { timeout: 5000 }, async () => {
	const dir = mkdtempSync(path.join(tmpdir(), "bh-e6-"));
	const log: string[] = [];
	const session = neverSettlingSession(log);
	try {
		const outcome = await runCompletionAudit({
			ctx: fakeCtx(dir),
			goal: target(),
			completionSummary: "claim",
			detailedSummaryText: "s",
			signal: undefined,
			timeoutMs: 60,
			sendAuditEvent: () => {},
			auditor: (auditorArgs) =>
				runGoalCompletionAuditor({
					ctx: auditorArgs.ctx,
					goal: auditorArgs.goal,
					completionSummary: auditorArgs.completionSummary,
					detailedSummary: auditorArgs.detailedSummary,
					signal: auditorArgs.signal,
					sessionAdapter: async () => ({ session }),
				}),
		});
		assert.equal(outcome.verdict, "rejected");
		assert.match(outcome.rejectionText, /timed out/);
		await new Promise((resolve) => setTimeout(resolve, 50));
		assert.ok(log.includes("abort"), "the timeout must abort the auditor session");
		assert.equal(log.filter((c) => c === "dispose").length, 1, `the session must be disposed exactly once (log: ${log.join(" → ")})`);
		assert.equal(log.filter((c) => c === "unsubscribe").length, 1, "unsubscribe runs with the dispose");
		assert.ok(log.indexOf("dispose") > log.indexOf("abort"), "dispose happens after the abort");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
