/**
 * Tests for src/report-tool.ts — the pi_review_report tool logic.
 *
 * Two real regressions found during local E2E (v0.7):
 *  - the tool relied on process.cwd() to find the run manifest; callers must
 *    be able to pass cwd explicitly.
 *  - gate finalConfidence re-scores were ignored, so a reviewer-reported conf
 *    7 major that the gate verified to 8 was still dropped at threshold 8.
 */
import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";

import { runReportTool } from "../src/report-tool.js";
import { ensureRunDir, writeManifest } from "../src/review-report.js";
import type { RunManifest } from "../src/review-report.js";

let sandbox: string;
afterEach(() => {
	if (sandbox) rmSync(sandbox, { recursive: true, force: true });
	sandbox = "";
});

function setupManifest(): { cwd: string; runId: string; manifest: RunManifest } {
	const cwd = mkdtempSync(join(tmpdir(), "pi-review-tool-"));
	sandbox = cwd;
	const runId = "tool-e2e";
	const runDir = ensureRunDir(cwd, runId);
	const manifest: RunManifest = {
		runId,
		targetLabel: "local changes",
		targetKind: "local-git",
		diffPath: join(runDir, "change.diff"),
		diffSha256: "a".repeat(64),
		changedFiles: ["a.ts"],
		docsOnly: false,
		rulePaths: [],
		historyAvailable: true,
		mode: "local-uncommitted",
		workspacePath: cwd,
		runDir,
		createdAt: Date.now(),
	};
	writeManifest(runDir, manifest);
	return { cwd, runId, manifest };
}

const MAJOR_ISSUE = {
	file: "a.ts",
	line: 4,
	relatedChangedLine: 4,
	category: "bug" as const,
	severity: "major" as const,
	confidence: 7,
	evidence: "null deref",
	fingerprint: "a.ts:4:bug:null",
};


const gateMd = (block: Record<string, unknown>, synthesis = "gate synthesis") =>
	`${synthesis}\n\n\`\`\`json\n${JSON.stringify(block, null, 1)}\n\`\`\`\n`;

const okReviewer = (key: string, md = "## Summary\nok\n\n## Findings\nNo findings.") => ({
	key,
	ok: true,
	output: md,
});

describe("runReportTool", () => {
	test("JSON-STRING workflowReturn is accepted (2026-09-03 field failure: full correct payload rejected as string)", () => {
		const { cwd, runId } = setupManifest();
		const payload = JSON.stringify({
			reviewers: [okReviewer("bugbot", "## Summary\n1 finding\n\n## Findings\n- [MAJOR|bug|9] `a.ts:4` — ev")],
			gate: {
				ok: true,
				output: gateMd({
					status: "ok",
					verdict: "request_changes",
					reason: "major",
					issues: [{ ...MAJOR_ISSUE, confidence: 9 }],
					dispositions: [],
				}),
			},
			reviewersShaped: [],
		});
		const res = runReportTool({
			runId,
			cwd,
			threshold: 8,
			workflowReturn: payload as unknown as object,
		});
		assert.equal(res.ok, true);
		if (!res.ok) return;
		assert.equal(res.verdict, "request_changes");
	});

	test("empty-string workflowReturn fails with an actionable message", () => {
		const { cwd, runId } = setupManifest();
		const res = runReportTool({ runId, cwd, workflowReturn: "" });
		assert.equal(res.ok, false);
		if (res.ok) return;
		assert.match(res.error, /or a JSON string of it/);
	});

	test("finds the manifest via explicit cwd (not process.cwd)", () => {
		const { cwd, runId } = setupManifest();
		const res = runReportTool({
			runId,
			cwd,
			workflowReturn: { reviewers: [], gate: null },
		});
		assert.equal(res.ok, true);
	});

	test("v0.8: verdict comes from the gate's fenced JSON block; reviewer MD renders verbatim", () => {
		const { cwd, runId } = setupManifest();
		const res = runReportTool({
			runId,
			cwd,
			threshold: 8,
			workflowReturn: {
				reviewers: [okReviewer("bugbot", "## Summary\nChecked the diff.\n\n## Findings\nNo findings.")],
				gate: {
					ok: true,
					output: gateMd({
						status: "ok",
						verdict: "approve",
						reason: "clean",
						issues: [],
						dispositions: [],
					}),
				},
			},
		});
		assert.equal(res.ok, true);
		if (!res.ok) return;
		assert.equal(res.verdict, "approve");
		assert.match(res.markdown, /Checked the diff\./);
	});

	test("gate Markdown WITHOUT a fenced JSON block reports no-gate", () => {
		const { cwd, runId } = setupManifest();
		const res = runReportTool({
			runId,
			cwd,
			threshold: 8,
			workflowReturn: {
				reviewers: [okReviewer("bugbot")],
				gate: { ok: true, output: "## Synthesis\nI forgot the JSON block." },
			},
		});
		assert.equal(res.ok, true);
		if (!res.ok) return;
		assert.equal(res.verdict, "no-gate");
	});

	test("non-roster reviewer keys are dropped and surfaced (stale-artifact guard)", () => {
		const { cwd, runId, manifest } = setupManifest();
		writeManifest(join(cwd, ".pi", "pi-review", "runs", runId), {
			...manifest,
			reviewerIds: ["bugbot"],
		});
		const res = runReportTool({
			runId,
			cwd,
			threshold: 8,
			workflowReturn: {
				reviewers: [okReviewer("bugbot"), okReviewer("history-context", "## Summary\nfrom an old run\n\n## Findings\n- [MAJOR|history|9] `a.ts:4` — stale")],
				gate: {
					ok: true,
					output: gateMd({
						status: "ok",
						verdict: "comment",
						reason: "ok",
						issues: [],
						dispositions: [],
					}),
				},
			},
		});
		assert.equal(res.ok, true);
		if (!res.ok) return;
		assert.match(res.markdown, /non-roster reviewer keys: history-context/);
		assert.doesNotMatch(res.markdown, /#### history-context — ok/, "stale reviewer MD must not render");
	});

	test("workflowReturn with ONLY non-roster keys is rejected outright (no fabricated approve)", () => {
		const { cwd, runId, manifest } = setupManifest();
		writeManifest(join(cwd, ".pi", "pi-review", "runs", runId), {
			...manifest,
			reviewerIds: ["bugbot"],
		});
		const res = runReportTool({
			runId,
			cwd,
			workflowReturn: {
				reviewers: [okReviewer("history-context")],
				gate: null,
			},
		});
		assert.equal(res.ok, false);
		if (res.ok) return;
		assert.match(res.error, /no reviewer from this run's roster/);
	});

	test("a successful report reclaims its cloned tmp workspace (end-of-run cleanup)", () => {
		const { cwd, runId, manifest } = setupManifest();
		const scratchRoot = mkdtempSync(join(tmpdir(), "pi-review-ws-"));
		const cloneDir = join(scratchRoot, "some-repo-42");
		mkdirSync(cloneDir, { recursive: true });
		writeFileSync(join(cloneDir, "README.md"), "# scratch clone\n");
		writeManifest(join(cwd, ".pi", "pi-review", "runs", runId), {
			...manifest,
			workspacePath: cloneDir,
			workspaceCloned: true,
		});
		const res = runReportTool({
			runId,
			cwd,
			threshold: 8,
			workflowReturn: {
				reviewers: [okReviewer("bugbot")],
				gate: { ok: true, output: gateMd({ status: "ok", verdict: "approve", reason: "clean", issues: [], dispositions: [] }) },
			},
		});
		assert.equal(res.ok, true);
		assert.equal(existsSync(scratchRoot), false, "cloned workspace reclaimed after report");
	});

	test("a non-cloned workspace (user cwd) is never touched by reclamation", () => {
		const { cwd, runId, manifest } = setupManifest();
		writeManifest(join(cwd, ".pi", "pi-review", "runs", runId), {
			...manifest,
			workspaceCloned: false,
		});
		const res = runReportTool({
			runId,
			cwd,
			workflowReturn: {
				reviewers: [okReviewer("bugbot")],
				gate: { ok: true, output: gateMd({ status: "ok", verdict: "approve", reason: "", issues: [], dispositions: [] }) },
			},
		});
		assert.equal(res.ok, true);
		assert.equal(existsSync(cwd), true, "user cwd must survive report reclamation");
	});

	test("gate finalConfidence re-score is applied (7 -> 8 survives threshold 8)", () => {
		const { cwd, runId } = setupManifest();
		const res = runReportTool({
			runId,
			cwd,
			threshold: 8,
			workflowReturn: {
				reviewers: [okReviewer("bugbot", "## Summary\n1 major\n\n## Findings\n- [MAJOR|bug|7] `a.ts:4` — null deref")],
				gate: {
					ok: true,
					output: gateMd({
						status: "ok",
						verdict: "comment",
						reason: "verified",
						issues: [{ ...MAJOR_ISSUE, confidence: 8 }],
						dispositions: [
							{
								fingerprint: "a.ts:4:bug:null",
								decision: "kept",
								originalConfidence: 7,
								finalConfidence: 8,
								sourceReviewers: ["bugbot"],
								reason: "verified against diff",
							},
							],
						}),
				},
			},
		});
		assert.equal(res.ok, true);
		if (!res.ok) return;
		assert.equal(res.verdict, "request_changes");
		assert.ok(res.markdown.includes("Verdict: REQUEST_CHANGES"));
	});

	test("unverified blocker/major dispositions are exempt from the threshold floor", () => {
		// Field regression (2026-08-20/21): the gate could not verify real
		// majors and its "keep at original confidence" instruction still lost
		// them to the code-side threshold filter. The exemption floors the
		// confidence at the threshold and flags the evidence.
		const { cwd, runId } = setupManifest();
		const res = runReportTool({
			runId,
			cwd,
			threshold: 8,
			workflowReturn: {
				reviewers: [okReviewer("history-context", "## Summary\n1 major (unverified)\n\n## Findings\n- [MAJOR|history|7] `a.ts:4` — area reworked twice")],
				gate: {
					ok: true,
					output: gateMd({
						status: "ok",
						verdict: "comment",
						reason: "kept unverified",
						issues: [{ ...MAJOR_ISSUE, confidence: 7 }],
						dispositions: [
							{
								fingerprint: "a.ts:4:bug:null",
								decision: "kept",
								originalConfidence: 7,
								finalConfidence: 7,
								sourceReviewers: ["history-context"],
								reason: "unverified: diff truncated before the registration hunk; kept for human review",
							},
							],
						}),
				},
			},
		});
		assert.equal(res.ok, true);
		if (!res.ok) return;
		assert.equal(res.verdict, "request_changes", "unverified major must drive the verdict");
		assert.match(res.markdown, /\(unverified\)/);
	});

	test("unverified exemption does not apply to minor/nit severities", () => {
		const { cwd, runId } = setupManifest();
		const minor = { ...MAJOR_ISSUE, severity: "minor" as const, fingerprint: "a.ts:4:bug:minor" };
		const res = runReportTool({
			runId,
			cwd,
			threshold: 8,
			workflowReturn: {
				reviewers: [okReviewer("code-comments")],
				gate: {
					ok: true,
					output: gateMd({
						status: "ok",
						verdict: "comment",
						reason: "dropped",
						issues: [{ ...minor, confidence: 4 }],
						dispositions: [
							{
								fingerprint: "a.ts:4:bug:minor",
								decision: "dropped",
								originalConfidence: 4,
								finalConfidence: 4,
								sourceReviewers: ["code-comments"],
								reason: "unverified: stylistic, below bar",
							},
							],
						}),
				},
			},
		});
		assert.equal(res.ok, true);
		if (!res.ok) return;
		assert.equal(res.verdict, "approve");
	});

	test("no gate and no lite verdict block → report says no-gate (not approve)", () => {
		const { cwd, runId } = setupManifest();
		const res = runReportTool({
			runId,
			cwd,
			threshold: 8,
			workflowReturn: {
				reviewers: [okReviewer("bugbot", "## Summary\n1 major\n\n## Findings\n- [MAJOR|bug|7] `a.ts:4` — null deref")],
				gate: null,
			},
		});
		assert.equal(res.ok, true);
		if (!res.ok) return;
		// No verdict source: the tool reports no-gate instead of fabricating approve.
		assert.equal(res.verdict, "no-gate");
	});

	test("legacy verdict policy still applies when configured", () => {
		const { cwd, runId } = setupManifest();
		const two = [1, 2].map((n) => ({
			file: `a${n}.ts`,
			line: 1,
			category: "bug" as const,
			severity: "major" as const,
			confidence: 9,
			evidence: "x",
			fingerprint: `a${n}.ts:1:bug:x${n}`,
		}));
		const res = runReportTool({
			runId,
			cwd,
			threshold: 8,
			verdictPolicy: "legacy",
			workflowReturn: {
				reviewers: [okReviewer("bugbot")],
				gate: {
					ok: true,
					output: gateMd({ status: "ok", verdict: "comment", reason: "two majors", issues: two, dispositions: [] }),
				},
			},
		});
		assert.equal(res.ok, true);
		if (!res.ok) return;
		// legacy: needs >=3 majors before request_changes; 2 majors -> comment
		assert.equal(res.verdict, "comment");
	});

	test("missing manifest returns a clear error", () => {
		const res = runReportTool({
			runId: "nonexistent-run",
			cwd: "/tmp/definitely-no-such-dir",
			workflowReturn: { reviewers: [], gate: null },
		});
		assert.equal(res.ok, false);
		assert.ok((res as { error: string }).error.includes("manifest not found"));
	});
});