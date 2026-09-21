/**
 * Deterministic report builder for v0.7. The `pi_review_report` tool feeds
 * the workflow return value + manifest into `buildReportFromWorkflow`; the
 * output is then rendered to markdown and persisted via `pi.appendEntry`.
 */
import type {
	GateDisposition,
	GateRunResult,
	Issue,
	IssueSeverity,
	ReviewReport,
	ReviewerRunResult,
	Verdict,
} from "./types.js";

const EMPTY_SEVERITY: Record<IssueSeverity, number> = {
	blocker: 0,
	major: 0,
	minor: 0,
	nit: 0,
};

export interface ReviewerWorkflowResult {
	key: string;
	ok: boolean;
	error?: string;
	output?: string;
	structuredOutput?: unknown;
}

export interface WorkflowReturnValue {
	reviewers?: ReviewerWorkflowResult[];
	gate?: { ok: boolean; error?: string; output?: string; structuredOutput?: unknown } | null;
}

/** Normalize a reviewer's Markdown-report outcome (v0.8: no structuredOutput). */
export function coerceReviewerOutput(r: ReviewerWorkflowResult): {
	status: "ok" | "limited" | "skipped" | "failed";
	issues: Issue[];
	summary: string;
	coverage: { filesChecked: string[]; commandsRun: string[]; limitations: string[] };
} {
	if (!r.ok) {
		return {
			status: "failed",
			issues: [],
			summary: r.error ?? "reviewer failed",
			coverage: { filesChecked: [], commandsRun: [], limitations: [r.error ?? "reviewer failed"] },
		};
	}
	const md = r.output ?? "";
	// Reviewers signal a non-applicable lane with a SKIPPED summary line.
	const skipped = /^\s*##\s*Summary\s*\n+\s*SKIPPED:/im.test(md) || /^\s*SKIPPED:/m.test(md);
	return {
		status: skipped ? "skipped" : "ok",
		issues: [],
		summary: md,
		coverage: { filesChecked: [], commandsRun: [], limitations: [] },
	};
}

export function coerceGateOutput(gate: WorkflowReturnValue["gate"]): {
	status: "ok" | "limited" | "skipped" | "failed";
	verdict?: Verdict;
	issues: Issue[];
	dispositions: GateDisposition[];
	reason: string;
} {
	if (!gate || !gate.ok) {
		return {
			status: "failed",
			issues: [],
			dispositions: [],
			reason: gate?.error ?? "gate failed",
		};
	}
	const so = gate.structuredOutput;
	if (!so || typeof so !== "object") {
		return {
			status: "limited",
			issues: [],
			dispositions: [],
			reason: "gate did not return structuredOutput",
		};
	}
	const obj = so as {
		status?: string;
		verdict?: Verdict;
		issues?: Issue[];
		dispositions?: GateDisposition[];
		reason?: string;
	};
	return {
		status: obj.status === "ok" || obj.status === "limited" || obj.status === "skipped" ? obj.status : "ok",
		verdict: obj.verdict,
		issues: Array.isArray(obj.issues) ? obj.issues : [],
		dispositions: Array.isArray(obj.dispositions) ? obj.dispositions : [],
		reason: typeof obj.reason === "string" ? obj.reason : "",
	};
}

/** Build a normalized reviewer row for the report, regardless of input shape. */
export function reviewerRow(
	id: string,
	label: string,
	res: ReviewerWorkflowResult,
	durationMs: number,
): ReviewerRunResult {
	const coerced = coerceReviewerOutput(res);
	return {
		id,
		label,
		model: "(see workflow)",
		ok: res.ok,
		output: {
			status: coerced.status,
			issues: coerced.issues,
			summary: coerced.summary,
			coverage: coerced.coverage,
		},
		error: res.error,
		durationMs,
	};
}

/** Compute totals for the verdict line. */
export function computeTotals(issues: Issue[]): {
	issues: number;
	bySeverity: Record<IssueSeverity, number>;
} {
	const bySeverity = { ...EMPTY_SEVERITY };
	for (const i of issues) bySeverity[i.severity]++;
	return { issues: issues.length, bySeverity };
}

/** Decide the report verdict. */
export function reportVerdict(
	reviewers: ReviewerWorkflowResult[],
	gate: { ok: boolean; structuredOutput?: unknown; error?: string } | null | undefined,
	enforcedVerdict?: Verdict,
): Verdict | "no-gate" | "error" | "partial" {
	if (reviewers.length > 0 && reviewers.every((r) => coerceReviewerOutput(r).status === "failed")) return "error";
	if (!gate || !gate.ok) return "no-gate";
	const so = gate.structuredOutput as { status?: string } | null;
	if (so?.status && so.status !== "ok") return "partial";
	// Every reviewer skipped (lane inapplicable across the board) with a
	// clean enforce — still not a full-coverage APPROVE.
	if (reviewers.length > 0 && reviewers.every((r) => coerceReviewerOutput(r).status === "skipped")) {
		return enforcedVerdict === "approve" ? "comment" : enforcedVerdict ?? "comment";
	}
	return enforcedVerdict ?? "comment";
}

export type ReportVerdictKind = Verdict | "no-gate" | "error" | "partial";

export interface ReportInput {
	startedAt: number;
	manifest: {
		runId: string;
		targetLabel: string;
		targetKind: string;
		prRef?: string;
		diffSha256: string;
		workspacePath: string;
		workspaceHeadSha?: string;
		workspaceWarning?: string;
		diffWarning?: string;
		mode?: string;
		docsOnly: boolean;
		rulePaths: string[];
		historyAvailable: boolean;
		changedFiles: string[];
		baseSha?: string;
		headSha?: string;
		skippedReviewers?: Array<{ id: string; reason: string }>;
	};
	workflowReturn: WorkflowReturnValue;
	threshold: number;
	policy: "strict" | "legacy";
	enforcedVerdict: Verdict;
	enforcedIssues: Issue[];
	enforcedDispositions: GateDisposition[];
	enforcedReason: string;
}

export interface BuiltReport extends Omit<ReviewReport, "verdict"> {
	manifest: ReportInput["manifest"];
	dispositions: GateDisposition[];
	reviewerStatus: Array<{ id: string; status: string; limitations: string[] }>;
	gateStatus: "ok" | "limited" | "skipped" | "failed";
	verdict: Verdict | "no-gate" | "error" | "partial";
}

export function buildReportFromWorkflow(input: ReportInput): BuiltReport {
	const durationMs = Date.now() - input.startedAt;
	const reviewerResults = (input.workflowReturn.reviewers ?? []).map((r) =>
		reviewerRow(r.key, r.key, r, 0),
	);
	const reviewerStatus = (input.workflowReturn.reviewers ?? []).map((r) => {
		const c = coerceReviewerOutput(r);
		return { id: r.key, status: c.status, limitations: c.coverage.limitations };
	});
	const gateRaw = input.workflowReturn.gate ?? null;
	const coercedGate = coerceGateOutput(gateRaw);
	const gateResult: GateRunResult = {
		ok: !!gateRaw?.ok,
		verdict: {
			verdict: input.enforcedVerdict,
			issues: input.enforcedIssues,
			dispositions: input.enforcedDispositions,
			status: coercedGate.status,
			reason: input.enforcedReason,
		},
		error: gateRaw?.error,
		durationMs: 0,
		model: "(see workflow)",
	};
	const totals = computeTotals(input.enforcedIssues);
	const verdict = reportVerdict(input.workflowReturn.reviewers ?? [], gateRaw, input.enforcedVerdict);

	return {
		startedAt: input.startedAt,
		durationMs,
		input: {
			kind: input.manifest.targetKind as ReviewReport["input"]["kind"],
			label: input.manifest.targetLabel,
			prRef: input.manifest.prRef,
		},
		reviewers: reviewerResults,
		gate: gateResult,
		totals,
		verdict,
		manifest: input.manifest,
		dispositions: input.enforcedDispositions,
		reviewerStatus,
		gateStatus: coercedGate.status,
	};
}

export function renderReport(report: BuiltReport): string {
	const lines: string[] = [];
	lines.push(`## pi-review — ${report.input.label}`);
	lines.push("");
	lines.push(renderVerdictLine(report));
	lines.push(renderSummaryLine(report));
	lines.push("");
	lines.push(renderRunLine(report));
	if (report.manifest.prRef) {
		lines.push(`- PR: ${report.manifest.prRef}`);
	}
	if (report.manifest.mode) {
		lines.push(`- Diff mode: ${report.manifest.mode}`);
	}
	if (report.manifest.baseSha && report.manifest.headSha) {
		lines.push(`- Base: ${report.manifest.baseSha.slice(0, 12)} · Head: ${report.manifest.headSha.slice(0, 12)}`);
	}
	if (report.manifest.workspaceHeadSha) {
		if (report.manifest.headSha) {
			const matched = report.manifest.workspaceHeadSha === report.manifest.headSha;
			lines.push(
				`- Workspace HEAD: ${report.manifest.workspaceHeadSha.slice(0, 12)}${matched ? " (matches diff head)" : " (MISMATCH vs diff head)"}`,
			);
		} else {
			lines.push(`- Workspace HEAD: ${report.manifest.workspaceHeadSha.slice(0, 12)} (diff head SHA unknown)`);
		}
	}
	if (report.manifest.workspaceWarning) {
		lines.push(`- Workspace note: ${report.manifest.workspaceWarning}`);
	}
	if (report.manifest.diffWarning) {
		lines.push(`- Diff note: ${report.manifest.diffWarning}`);
	}
	lines.push(`- Diff SHA-256: ${report.manifest.diffSha256.slice(0, 16)}…`);
	lines.push(`- Workspace: ${report.manifest.workspacePath}`);
	lines.push(`- History available: ${report.manifest.historyAvailable ? "yes" : "no"}`);
	lines.push(`- Docs-only: ${report.manifest.docsOnly ? "yes" : "no"}`);
	if (report.manifest.rulePaths.length > 0) {
		lines.push(`- Rule paths: ${report.manifest.rulePaths.join(", ")}`);
	} else {
		lines.push(`- Rule paths: (none)`);
	}
	lines.push("");

	if (report.manifest.skippedReviewers && report.manifest.skippedReviewers.length > 0) {
		lines.push("### Skipped by adaptive routing");
		for (const s of report.manifest.skippedReviewers) {
			lines.push(`- ${s.id}: ${s.reason}`);
		}
		lines.push("");
	}

	if (report.reviewerStatus.length > 0) {
		lines.push("### Reviewer coverage");
		for (const s of report.reviewerStatus) {
			const limit = s.limitations.length > 0 ? ` (${s.limitations.join("; ")})` : "";
			lines.push(`- ${s.id}: ${s.status}${limit}`);
		}
		lines.push("");
	}

	if (report.reviewers.length > 0) {
		lines.push("### Reviewer findings");
		for (const r of report.reviewers) {
			lines.push(renderReviewerSection(r));
		}
	}

	if (report.gate) {
		lines.push(renderGateSection(report.gate));
	}

	if (report.dispositions.length > 0) {
		lines.push(renderDispositions(report.dispositions));
	}

	return lines.join("\n");
}

function renderVerdictLine(report: BuiltReport): string {
	const v = report.verdict;
	const label =
		v === "no-gate"
			? "NO GATE"
			: v === "error"
				? "ERROR"
				: v === "partial"
					? "PARTIAL"
					: v.toUpperCase();
	const t = report.totals.bySeverity;
	return `**Verdict: ${label}** (${t.blocker} blocker · ${t.major} major · ${t.minor} minor · ${t.nit} nit)`;
}

function renderSummaryLine(report: BuiltReport): string {
	const dur = (report.durationMs / 1000).toFixed(1);
	const reviewerCount = report.reviewers.length;
	const gateCount = report.gate ? 1 : 0;
	return `Reviewed in ${dur}s · ${reviewerCount} reviewer${reviewerCount === 1 ? "" : "s"} · ${gateCount} gate`;
}

function renderRunLine(report: BuiltReport): string {
	return `- Run: ${report.manifest.runId}`;
}

export function renderReviewerSection(r: ReviewerRunResult): string {
	const status = r.ok ? "ok" : "failed";
	const dur = (r.durationMs / 1000).toFixed(1);
	const head = `#### ${r.id} — ${status} · ${dur}s`;
	if (!r.ok) {
		return [head, "", `- ${r.error ?? "unknown error"}`, ""].join("\n");
	}
	// v0.8: reviewers return Markdown reports — render them verbatim under
	// the status header (the gate already arbitrated them; see dispositions).
	const md = r.output?.summary ?? "";
	const body: string[] = [head, ""];
	if (md.trim()) {
		body.push(md.trim());
	} else {
		body.push("- (no output)");
	}
	body.push("");
	return body.join("\n");
}

function renderGateSection(g: GateRunResult): string {
	if (!g.ok) {
		return [`### gate — failed`, "", `- ${g.error ?? "unknown error"}`, ""].join("\n");
	}
	const v = g.verdict;
	if (!v) {
		return [`### gate — ok · no verdict`, ""].join("\n");
	}
	const issues = v.issues;
	return [
		`### gate — ${v.status} · ${(g.durationMs / 1000).toFixed(1)}s`,
		"",
		`- verdict: ${v.verdict}`,
		`- reason: ${v.reason}`,
		`- ${issues.length} issue${issues.length === 1 ? "" : "s"} after dedupe + threshold`,
		"",
	]
		.concat(
			issues.map((issue) => {
				const loc = issue.line !== undefined ? `${issue.file}:${issue.line}` : issue.file;
				return `- [${issue.severity.toUpperCase()} · ${issue.category} · conf ${issue.confidence}] \`${loc}\` — ${issue.evidence}`;
			}),
		)
		.concat([""])
		.join("\n");
}

function renderDispositions(dispositions: GateDisposition[]): string {
	const lines: string[] = ["### High-severity dispositions", ""];
	const sorted = [...dispositions].sort((a, b) => {
		if (a.decision === b.decision) return b.originalConfidence - a.originalConfidence;
		const order = { dropped: 0, merged: 1, kept: 2 } as const;
		return order[a.decision] - order[b.decision];
	});
	for (const d of sorted.slice(0, 25)) {
		lines.push(
			`- ${d.decision.toUpperCase()} \`${d.fingerprint}\` · ${d.originalConfidence}→${d.finalConfidence} · ${d.reason}`,
		);
	}
	if (dispositions.length > 25) {
		lines.push(`- … ${dispositions.length - 25} more disposition entries`);
	}
	lines.push("");
	return lines.join("\n");
}