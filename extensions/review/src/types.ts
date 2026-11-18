/**
 * Shared type definitions for pi-review (v0.7+).
 *
 * The active path is the foreground workflowScript:
 *   /review → plugin prep (diff + target workspace + manifest)
 *          → main agent runs one subagent({ workflowScript })
 *          → pi_review_report tool renders the deterministic report
 *
 * No legacy spawn-pipeline types remain.
 */

export type Verdict = "approve" | "request_changes" | "comment";

export type IssueSeverity = "blocker" | "major" | "minor" | "nit";

export type IssueCategory =
	| "compliance"
	| "bug"
	| "convention"
	| "history"
	| "security"
	| "performance"
	| "docs"
	| "other";

export interface Issue {
	file: string;
	line?: number;
	relatedChangedLine?: number;
	category: IssueCategory;
	severity: IssueSeverity;
	confidence: number;
	evidence: string;
	fingerprint?: string;
}

export type ReviewerStatus = "ok" | "limited" | "skipped" | "failed";

export interface ReviewerOutput {
	status: ReviewerStatus;
	issues: Issue[];
	summary: string;
	coverage: {
		filesChecked: string[];
		commandsRun: string[];
		limitations: string[];
	};
}

export interface GateDisposition {
	fingerprint: string;
	decision: "kept" | "dropped" | "merged";
	originalConfidence: number;
	finalConfidence: number;
	sourceReviewers: string[];
	reason: string;
}

export interface GateOutput {
	status: ReviewerStatus;
	verdict: Verdict;
	issues: Issue[];
	dispositions: GateDisposition[];
	reason: string;
	coverage: {
		limitations: string[];
	};
}

export interface ReviewerSpec {
	id: string;
	label: string;
	enabled: boolean;
	model: string | "inherit";
	thinking?: string;
	promptPath?: string;
}

export interface ReviewerRunResult {
	id: string;
	label: string;
	model: string;
	ok: boolean;
	output?: ReviewerOutput;
	error?: string;
	exitCode?: number | null;
	durationMs: number;
}

export interface GateVerdict {
	verdict: Verdict;
	issues: Issue[];
	dispositions: GateDisposition[];
	status: ReviewerStatus;
	reason: string;
}

export interface GateRunResult {
	ok: boolean;
	verdict?: GateVerdict;
	error?: string;
	exitCode?: number | null;
	durationMs: number;
	model: string;
}

export type VerdictPolicy = "strict" | "legacy";

export type RoutingMode = "adaptive" | "all";

export interface PiReviewConfig {
	schemaVersion: 1;
	gate: {
		model: string | "inherit";
		thinking?: string;
		enabled: boolean;
		threshold: number;
		verdictPolicy: VerdictPolicy;
	};
	routing: {
		mode: RoutingMode;
	};
	reviewers: Record<string, Omit<ReviewerSpec, "promptPath"> & { promptPath?: string }>;
	budgets?: {
		turnBudget?: { maxTurns?: number; graceTurns?: number };
	};
}

export type ReviewTargetKind = "pr" | "local-git";

export interface ReviewTarget {
	kind: ReviewTargetKind;
	label: string;
	userContext?: string;
	prRef?: string;
	hint?: string;
	probeNote?: string;
}

export interface ReviewReport {
	startedAt: number;
	durationMs: number;
	input: ReviewTarget;
	reviewers: ReviewerRunResult[];
	gate: GateRunResult | null;
	totals: {
		issues: number;
		bySeverity: Record<IssueSeverity, number>;
	};
	verdict: Verdict | "no-gate" | "error" | "partial";
}
