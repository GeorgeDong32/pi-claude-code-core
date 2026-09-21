/**
 * Tests for src/report.ts: verdict line, per-reviewer sections, totals.
 */
import { strict as assert } from "node:assert";
import { describe, test } from "node:test";

import { buildReportFromWorkflow, renderReport, WorkflowReturnValue } from "../src/report.js";
import type { GateDisposition, Issue } from "../src/types.js";

const MANIFEST = {
	runId: "test-run",
	targetLabel: "uncommitted changes (agent-fetch)",
	targetKind: "local-git",
	diffSha256: "deadbeefcafebabe0000000000000000",
	workspacePath: "/tmp/ws",
	docsOnly: false,
	rulePaths: ["AGENTS.md"],
	historyAvailable: true,
	changedFiles: ["src/x.ts"],
	baseSha: "abc",
	headSha: "def",
};

const SUCCESS_REVIEWER: WorkflowReturnValue["reviewers"] = [
	{
		key: "bug-detector",
		ok: true,
		structuredOutput: {
			status: "ok",
			issues: [
				{ file: "src/x.ts", line: 10, category: "bug", severity: "major", confidence: 8, evidence: "race" },
				{ file: "src/x.ts", line: 20, category: "convention", severity: "nit", confidence: 3, evidence: "naming" },
			],
			summary: "1 race, 1 nit",
			coverage: { filesChecked: ["src/x.ts"], commandsRun: ["git log -n 5"], limitations: [] },
		},
	},
];

const FAILED_REVIEWER = {
	key: "conventions",
	ok: false,
	error: "timeout after 180000ms",
} as const;

function enforced(issues: Issue[], dispositions: GateDisposition[] = [], verdict: "approve" | "request_changes" | "comment" = "comment") {
	return { verdict, issues, dispositions, reason: "x" };
}

describe("buildReportFromWorkflow", () => {
	test("verdict is 'error' when all reviewers failed", () => {
		const report = buildReportFromWorkflow({
			startedAt: 0,
			manifest: MANIFEST,
			workflowReturn: { reviewers: [FAILED_REVIEWER], gate: null },
			threshold: 8,
			policy: "strict",
			enforcedVerdict: "comment",
			enforcedIssues: [],
			enforcedDispositions: [],
			enforcedReason: "x",
		});
		assert.equal(report.verdict, "error");
	});

	test("verdict reflects enforced result when gate ok", () => {
		const report = buildReportFromWorkflow({
			startedAt: 0,
			manifest: MANIFEST,
			workflowReturn: {
				reviewers: SUCCESS_REVIEWER,
				gate: { ok: true, structuredOutput: { status: "ok" } },
			},
			threshold: 8,
			policy: "strict",
			enforcedVerdict: "request_changes",
			enforcedIssues: [],
			enforcedDispositions: [],
			enforcedReason: "x",
		});
		assert.equal(report.verdict, "request_changes");
	});

	test("all reviewers skipped → never a clean approve (coverage hole)", () => {
		const skipped = [
			{
				key: "bugbot",
				ok: true,
				output: "## Summary\nSKIPPED: docs-only\n\n## Findings\nNo findings.\n\n## Coverage\n- Limitations: docs-only",
			},
		];
		const report = buildReportFromWorkflow({
			startedAt: 0,
			manifest: MANIFEST,
			workflowReturn: { reviewers: skipped, gate: { ok: true, structuredOutput: { status: "ok" } } },
			threshold: 8,
			policy: "strict",
			enforcedVerdict: "approve",
			enforcedIssues: [],
			enforcedDispositions: [],
			enforcedReason: "no survivors",
		});
		assert.equal(report.verdict, "comment");
	});

	test("one skipped + one ok reviewer keeps the enforced verdict", () => {
		const mixed = [
			{
				key: "bugbot",
				ok: true,
				output: "## Summary\nSKIPPED: docs-only\n\n## Findings\nNo findings.",
			},
			{
				key: "security-review",
				ok: true,
				output: "## Summary\nchecked\n\n## Findings\nNo findings.",
			},
		];
		const report = buildReportFromWorkflow({
			startedAt: 0,
			manifest: MANIFEST,
			workflowReturn: { reviewers: mixed, gate: { ok: true, structuredOutput: { status: "ok" } } },
			threshold: 8,
			policy: "strict",
			enforcedVerdict: "approve",
			enforcedIssues: [],
			enforcedDispositions: [],
			enforcedReason: "ok",
		});
		assert.equal(report.verdict, "approve");
	});

	test("totals use enforced issues", () => {
		const report = buildReportFromWorkflow({
			startedAt: 0,
			manifest: MANIFEST,
			workflowReturn: { reviewers: SUCCESS_REVIEWER, gate: { ok: true, structuredOutput: { status: "ok" } } },
			threshold: 8,
			policy: "strict",
			enforcedVerdict: "approve",
			enforcedIssues: [
				{ file: "a", category: "bug", severity: "blocker", confidence: 9, evidence: "x", fingerprint: "a:-:bug:1" },
				{ file: "b", category: "convention", severity: "minor", confidence: 4, evidence: "y", fingerprint: "b:-:convention:2" },
			],
			enforcedDispositions: [],
			enforcedReason: "ok",
		});
		assert.equal(report.totals.issues, 2);
		assert.equal(report.totals.bySeverity.blocker, 1);
		assert.equal(report.totals.bySeverity.minor, 1);
	});

	test("falls back to reviewer sums when gate absent", () => {
		const report = buildReportFromWorkflow({
			startedAt: 0,
			manifest: MANIFEST,
			workflowReturn: { reviewers: SUCCESS_REVIEWER, gate: null },
			threshold: 8,
			policy: "strict",
			enforcedVerdict: "approve",
			enforcedIssues: [],
			enforcedDispositions: [],
			enforcedReason: "no gate",
		});
		assert.equal(report.totals.issues, 0);
	});
});

describe("renderReport", () => {
	test("includes verdict header", () => {
		const report = buildReportFromWorkflow({
			startedAt: 0,
			manifest: MANIFEST,
			workflowReturn: { reviewers: SUCCESS_REVIEWER, gate: null },
			threshold: 8,
			policy: "strict",
			enforcedVerdict: "approve",
			enforcedIssues: [],
			enforcedDispositions: [],
			enforcedReason: "no gate",
		});
		const md = renderReport(report);
		assert.ok(md.includes("## pi-review — uncommitted changes"));
		assert.ok(md.includes("**Verdict: NO GATE**"));
	});

	test("includes reviewer coverage", () => {
		const report = buildReportFromWorkflow({
			startedAt: 0,
			manifest: MANIFEST,
			workflowReturn: { reviewers: SUCCESS_REVIEWER, gate: null },
			threshold: 8,
			policy: "strict",
			enforcedVerdict: "approve",
			enforcedIssues: [],
			enforcedDispositions: [],
			enforcedReason: "no gate",
		});
		const md = renderReport(report);
		assert.ok(md.includes("bug-detector"));
		assert.ok(md.includes("ok"));
	});

	test("includes dispositions block", () => {
		const report = buildReportFromWorkflow({
			startedAt: 0,
			manifest: MANIFEST,
			workflowReturn: { reviewers: SUCCESS_REVIEWER, gate: { ok: true, structuredOutput: { status: "ok" } } },
			threshold: 8,
			policy: "strict",
			enforcedVerdict: "request_changes",
			enforcedIssues: [
				{ file: "a", category: "bug", severity: "blocker", confidence: 9, evidence: "x", fingerprint: "a:-:bug:1" },
			],
			enforcedDispositions: [
				{ fingerprint: "a:-:bug:1", decision: "kept", originalConfidence: 9, finalConfidence: 9, sourceReviewers: ["bugbot"], reason: "Survived" },
				{ fingerprint: "b:-:bug:2", decision: "dropped", originalConfidence: 7, finalConfidence: 7, sourceReviewers: ["bugbot"], reason: "below threshold" },
			],
			enforcedReason: "blocker present",
		});
		const md = renderReport(report);
		assert.ok(md.includes("### High-severity dispositions"));
		assert.ok(md.includes("DROPPED"));
	});

	test("summary line includes run id", () => {
		const report = buildReportFromWorkflow({
			startedAt: 0,
			manifest: MANIFEST,
			workflowReturn: { reviewers: SUCCESS_REVIEWER, gate: null },
			threshold: 8,
			policy: "strict",
			enforcedVerdict: "approve",
			enforcedIssues: [],
			enforcedDispositions: [],
			enforcedReason: "no gate",
		});
		const md = renderReport(report);
		assert.ok(md.includes("test-run"));
		assert.ok(md.includes("Diff SHA-256"));
	});
});

describe("gate enforcement strict vs legacy", () => {
	// quick smoke: keep these in the same file for proximity to report.ts tests.
	test("strict verdict treats any major as request_changes", async () => {
		const { enforceGateOutput } = await import("../src/gate-enforce.js");
		const out = enforceGateOutput(
			{
				issues: [
					{ file: "a", category: "bug", severity: "major", confidence: 9, evidence: "x" },
				],
				reason: "x",
			},
			8,
			"strict",
		);
		assert.equal(out.verdict, "request_changes");
	});
	test("legacy verdict needs >=3 majors before request_changes", async () => {
		const { enforceGateOutput } = await import("../src/gate-enforce.js");
		const out = enforceGateOutput(
			{
				issues: [
					{ file: "a", category: "bug", severity: "major", confidence: 9, evidence: "x" },
				],
				reason: "x",
			},
			8,
			"legacy",
		);
		assert.equal(out.verdict, "comment");
	});
});

void enforced;