/**
 * B7 step 2 (arch): the completion-audit flow, driven directly with an
 * injected fake auditor — the event trio (started/rejected/passed) and the
 * outcome texts were previously assertable only through the full update_goal
 * tool body. Flat node:test.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { runCompletionAudit, type AuditEventEmission } from "../goal-audit-flow.ts";
import type { GoalAuditorResult } from "../goal-auditor.ts";
import type { GoalRecord } from "../goal-record.ts";

function fakeCtx(cwd: string): ExtensionContext {
	return { cwd, hasUI: false } as unknown as ExtensionContext;
}

function target(): GoalRecord {
	return { id: "g1", status: "active", autoContinue: true, objective: "ship it", auditAttempts: 1 } as unknown as GoalRecord;
}

function auditor(result: Partial<GoalAuditorResult>): NonNullable<Parameters<typeof runCompletionAudit>[0]["auditor"]> {
	return async () => ({ approved: false, output: "", model: "", thinkingLevel: undefined, error: undefined, ...result }) as GoalAuditorResult;
}

test("rejected audit: started+rejected events, rejection text carries model and output", async () => {
	const dir = await mkdtemp(join(tmpdir(), "audit-flow-"));
	const emissions: AuditEventEmission[] = [];
	const outcome = await runCompletionAudit({
		ctx: fakeCtx(dir),
		goal: target(),
		completionSummary: "all steps verified",
		detailedSummaryText: "summary text",
		signal: undefined,
		sendAuditEvent: (e) => {
			emissions.push(e);
		},
		auditor: auditor({ approved: false, model: "test-model", output: "the objective is not met" }),
	});
	assert.equal(outcome.verdict, "rejected");
	assert.match(outcome.rejectionText, /Goal audit rejected\./);
	assert.match(outcome.rejectionText, /Auditor model: test-model/);
	assert.match(outcome.rejectionText, /the objective is not met/);
	assert.deepEqual(
		emissions.map((e) => e.phase),
		["started", "rejected"],
	);
	assert.match(emissions[0]?.content ?? "", /Auditor: I am starting/);
	assert.match(emissions[0]?.content ?? "", /Completion claim: all steps verified/);
});

test("passed audit: started+passed events, approval text returned for the adapter", async () => {
	const dir = await mkdtemp(join(tmpdir(), "audit-flow-"));
	const emissions: AuditEventEmission[] = [];
	const outcome = await runCompletionAudit({
		ctx: fakeCtx(dir),
		goal: target(),
		completionSummary: undefined,
		detailedSummaryText: "summary text",
		signal: undefined,
		sendAuditEvent: (e) => {
			emissions.push(e);
		},
		auditor: auditor({ approved: true, model: "test-model", output: "<approved/>" }),
	});
	assert.equal(outcome.verdict, "passed");
	assert.match(outcome.approvalText, /I approve this completion claim\./);
	assert.equal(outcome.auditorModel, "test-model");
	assert.deepEqual(
		emissions.map((e) => e.phase),
		["started", "passed"],
	);
});

test("auditor error surfaces in the rejection path (never reported as approved)", async () => {
	const dir = await mkdtemp(join(tmpdir(), "audit-flow-"));
	const outcome = await runCompletionAudit({
		ctx: fakeCtx(dir),
		goal: target(),
		completionSummary: undefined,
		detailedSummaryText: "s",
		signal: undefined,
		sendAuditEvent: () => {},
		auditor: auditor({ approved: false, error: "spawn failed" }),
	});
	assert.equal(outcome.verdict, "rejected");
	assert.match(outcome.rejectionText, /Auditor error: spawn failed/);
});
