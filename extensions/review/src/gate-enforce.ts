/**
 * Deterministic gate post-process (Claude Phase 5 equivalent).
 *
 * Re-scoring + dedupe + threshold + verdict, all in code. The LLM gate is
 * advisory; the parent pipeline always re-enforces.
 */
import type { GateDisposition, GateVerdict, Issue, IssueSeverity, Verdict } from "./types.js";

const SEVERITY_RANK: Record<IssueSeverity, number> = {
	blocker: 4,
	major: 3,
	minor: 2,
	nit: 1,
};

export function severityRank(s: IssueSeverity): number {
	return SEVERITY_RANK[s] ?? 0;
}

function dedupeKey(issue: Issue): string {
	const line = issue.line === undefined ? "-" : String(issue.line);
	return `${issue.file}\0${line}\0${issue.category}`;
}

function hasFingerprint(issue: Issue): boolean {
	return typeof issue.fingerprint === "string" && issue.fingerprint.length > 0;
}

export function dedupeIssues(issues: Issue[]): Issue[] {
	const best = new Map<string, Issue>();
	for (const issue of issues) {
		const key = hasFingerprint(issue) ? `fp:${issue.fingerprint}` : dedupeKey(issue);
		const prev = best.get(key);
		if (!prev) {
			best.set(key, issue);
			continue;
		}
		if (confidenceOf(issue) > confidenceOf(prev)) {
			best.set(key, issue);
			continue;
		}
		if (confidenceOf(issue) < confidenceOf(prev)) continue;
		if (severityRank(issue.severity) > severityRank(prev.severity)) {
			best.set(key, issue);
			continue;
		}
		if (
			severityRank(issue.severity) === severityRank(prev.severity) &&
			issue.evidence.length > prev.evidence.length
		) {
			best.set(key, issue);
		}
	}
	return [...best.values()];
}

export function filterByThreshold(issues: Issue[], threshold: number): Issue[] {
	const floor = Math.max(0, Math.min(10, Math.floor(threshold)));
	return issues.filter((i) => confidenceOf(i) >= floor);
}

export function confidenceOf(issue: Issue): number {
	if (typeof issue.confidence === "number" && Number.isFinite(issue.confidence)) {
		return Math.max(1, Math.min(10, issue.confidence));
	}
	return 5;
}

export type VerdictPolicy = "strict" | "legacy";

export function computeVerdict(issues: Issue[], policy: VerdictPolicy = "strict"): Verdict {
	if (issues.length === 0) return "approve";
	const blockers = issues.filter((i) => i.severity === "blocker").length;
	const majors = issues.filter((i) => i.severity === "major").length;
	if (policy === "legacy") {
		if (blockers > 0 || majors >= 3) return "request_changes";
		if (majors === 0) return "approve";
		return "comment";
	}
	if (blockers > 0 || majors > 0) return "request_changes";
	return "comment";
}

export function defaultApproveReason(issues: Issue[]): string {
	if (issues.length === 0) {
		return "No high-confidence findings after dedupe + threshold.";
	}
	return "No blockers or major issues remain after filtering.";
}

export function enforceGateOutput(
	raw: { issues: Issue[]; reason?: string },
	threshold: number,
	policy: VerdictPolicy = "strict",
): GateVerdict {
	const deduped = dedupeIssues(raw.issues ?? []);
	const issues = filterByThreshold(deduped, threshold);
	const verdict = computeVerdict(issues, policy);
	let reason = (raw.reason ?? "").trim();
	if (!reason) {
		reason =
			verdict === "approve"
				? defaultApproveReason(issues)
				: `Enforced verdict from ${issues.length} issue(s) after threshold ${threshold}.`;
	}
	if (reason.length > 500) reason = reason.slice(0, 500);
	return { verdict, issues, reason, dispositions: [], status: "ok" };
}

export function buildDispositions(
	candidates: Issue[],
	surviving: Issue[],
): GateDisposition[] {
	const survivingKeys = new Set(surviving.map((i) => i.fingerprint ?? dedupeKey(i)));
	return candidates.map((c) => ({
		fingerprint: c.fingerprint ?? dedupeKey(c),
		decision: survivingKeys.has(c.fingerprint ?? dedupeKey(c)) ? "kept" : "dropped",
		originalConfidence: c.confidence,
		finalConfidence: c.confidence,
		sourceReviewers: [],
		reason:
			survivingKeys.has(c.fingerprint ?? dedupeKey(c))
				? "Survived threshold + dedupe."
				: "Below threshold or merged into another candidate.",
	}));
}
