/**
 * B7 step 2 (arch): the completion-audit flow, driven directly with an
 * injected fake auditor — the event trio (started/rejected/passed) and the
 * outcome texts were previously assertable only through the full update_goal
 * tool body. Flat node:test.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp } from "node:fs/promises";
import * as fs from "node:fs";
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

// ---------- audit timeout + abort (spec 2026-10-04-goal-audit-hang-fix §4.1) ----------

test("audit timeout rejects, keeps goal active, aborts the auditor signal", { timeout: 2000 }, async () => {
	const dir = await mkdtemp(join(tmpdir(), "audit-flow-"));
	const emissions: AuditEventEmission[] = [];
	let auditorSignal: AbortSignal | undefined;
	const ledgerPath = join(dir, ".pi", "goals", "goal_events.jsonl");
	const outcome = await runCompletionAudit({
		ctx: fakeCtx(dir),
		goal: target(),
		completionSummary: "claim",
		detailedSummaryText: "s",
		signal: undefined,
		timeoutMs: 50,
		sendAuditEvent: (e) => {
			emissions.push(e);
		},
		auditor: async (args) => {
			auditorSignal = args.signal;
			// the incident shape: never settles (auditor session hung)
			return new Promise<GoalAuditorResult>(() => {});
		},
	});
	assert.equal(outcome.verdict, "rejected");
	assert.match(outcome.rejectionText, /timed out/);
	assert.match(outcome.rejectionText, /remains active/);
	assert.equal(auditorSignal?.aborted, true, "timeout must propagate abort to the auditor session signal");
	assert.equal(emissions.at(-1)?.phase, "rejected");
	const events = fs.readFileSync(ledgerPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
	assert.equal(events.at(-1)?.type, "audit_result");
	assert.equal(events.at(-1)?.verdict, "error");
});

test("user abort mid-audit rejects with 'aborted' text and propagates to the auditor signal", { timeout: 2000 }, async () => {
	const dir = await mkdtemp(join(tmpdir(), "audit-flow-"));
	const emissions: AuditEventEmission[] = [];
	let auditorSignal: AbortSignal | undefined;
	const toolController = new AbortController();
	const outcome = await runCompletionAudit({
		ctx: fakeCtx(dir),
		goal: target(),
		completionSummary: undefined,
		detailedSummaryText: "s",
		signal: toolController.signal,
		timeoutMs: 10_000,
		sendAuditEvent: (e) => {
			emissions.push(e);
		},
		auditor: async (args) => {
			auditorSignal = args.signal;
			toolController.abort(); // user pressed Esc while the auditor was mid-flight
			return new Promise<GoalAuditorResult>(() => {});
		},
	});
	assert.equal(outcome.verdict, "rejected");
	assert.match(outcome.rejectionText, /aborted/);
	assert.match(outcome.rejectionText, /remains active/);
	assert.equal(auditorSignal?.aborted, true, "tool abort must propagate to the auditor session signal");
	assert.equal(emissions.at(-1)?.phase, "rejected");
});
