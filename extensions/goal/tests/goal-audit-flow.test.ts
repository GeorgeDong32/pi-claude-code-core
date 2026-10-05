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

// ── AR1005-AU-01 (spec 2026-10-05 §5): pre-aborted entry, registration-near
// cancellation, and late-success-after-timeout — the auditor is not invoked
// on pre-abort, the rejected outcome is the existing one, and a late
// approval can never flip a timed-out flow. Baseline red evidence via stash. ──

test("AU-T01: signal already aborted on entry — auditor NEVER called, existing rejected outcome, started event still fired", { timeout: 2000 }, async () => {
	const dir = await mkdtemp(join(tmpdir(), "au-t01-"));
	const emissions: AuditEventEmission[] = [];
	let auditorCalls = 0;
	const controller = new AbortController();
	controller.abort(); // pre-aborted tool call
	const outcome = await runCompletionAudit({
		ctx: fakeCtx(dir),
		goal: target(),
		completionSummary: undefined,
		detailedSummaryText: "s",
		signal: controller.signal,
		sendAuditEvent: (e) => {
			emissions.push(e);
		},
		auditor: async () => {
			auditorCalls++;
			return { approved: true, output: "<approved/>", model: "m", thinkingLevel: undefined } as GoalAuditorResult;
		},
		timeoutMs: 10_000,
	});
	assert.equal(auditorCalls, 0, "pre-abort must not invoke the auditor / start model work");
	assert.equal(outcome.verdict, "rejected");
	assert.match(outcome.rejectionText, /aborted by user/);
	assert.match(outcome.rejectionText, /goal remains active/i);
	// the started event still fired (requested, not model-ran) and the ledger carries the error audit_result
	assert.deepEqual(emissions.map((e) => e.phase), ["started", "rejected"]);
	const events = fs.readFileSync(join(dir, ".pi", "goals", "goal_events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
	assert.ok(events.some((e) => e.type === "completion_requested"));
	assert.ok(events.some((e) => e.type === "audit_started"));
	assert.ok(events.some((e) => e.type === "audit_result" && e.verdict === "error"));
});

test("AU-T02: abort immediately after registration — rejected, no unhandled rejection, auditor signal aborted", { timeout: 2000 }, async () => {
	const dir = await mkdtemp(join(tmpdir(), "au-t02-"));
	const controller = new AbortController();
	let auditorSignal: AbortSignal | undefined;
	const outcomePromise = runCompletionAudit({
		ctx: fakeCtx(dir),
		goal: target(),
		completionSummary: undefined,
		detailedSummaryText: "s",
		signal: controller.signal,
		sendAuditEvent: () => {},
		auditor: async (args) => {
			auditorSignal = args.signal;
			return await new Promise<GoalAuditorResult>(() => {}); // never settles
		},
		timeoutMs: 10_000,
	});
	await new Promise((r) => setTimeout(r, 5));
	controller.abort(); // fires right after registration
	const outcome = await outcomePromise;
	assert.equal(outcome.verdict, "rejected");
	assert.match(outcome.rejectionText, /aborted by user/);
	assert.ok(auditorSignal?.aborted);
});

test("AU-T05: auditor approves AFTER the timeout — the flow already returned rejected; late success changes nothing", { timeout: 2000 }, async () => {
	const dir = await mkdtemp(join(tmpdir(), "au-t05-"));
	let releaseAuditor: ((r: GoalAuditorResult) => void) | null = null;
	const outcome = await runCompletionAudit({
		ctx: fakeCtx(dir),
		goal: target(),
		completionSummary: undefined,
		detailedSummaryText: "s",
		signal: undefined,
		sendAuditEvent: () => {},
		auditor: () => new Promise<GoalAuditorResult>((resolve) => {
			releaseAuditor = resolve;
		}),
		timeoutMs: 50,
	});
	assert.equal(outcome.verdict, "rejected");
	assert.match(outcome.rejectionText, /timed out/);
	// the late success lands after the flow returned — consumed only by the
	// pre-attached catch; it cannot flip anything.
	(releaseAuditor as ((r: GoalAuditorResult) => void) | null)?.({ approved: true, output: "<approved/>", model: "m", thinkingLevel: undefined } as GoalAuditorResult);
	await new Promise((r) => setTimeout(r, 10));
	assert.equal(outcome.verdict, "rejected");
});
