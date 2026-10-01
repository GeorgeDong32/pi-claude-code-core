/**
 * goal-audit-flow.ts — the completion-audit orchestration (arch B7 step 2,
 * carved out of the update_goal tool body in the goal.ts monolith).
 *
 * Pure orchestration over direct imports (goal-auditor, goal-ledger,
 * goal-record): auditor config resolution, the started/rejected/passed
 * event trio, and the ledger writes. The emit seam is injected — the
 * adapter owns pi.sendMessage — so no pi dependency and no import cycle.
 *
 * State changes (auditAttempts++, persist, pendingGoalAchievement,
 * stopActiveGoal) stay in the adapter; this module only reports the
 * outcome with ready-to-render text.
 */
import { loadGoalAuditorFileConfig, runGoalCompletionAuditor } from "./goal-auditor.ts";
import { appendGoalEvent } from "./goal-ledger.ts";
import { nowIso, type GoalRecord } from "./goal-record.ts";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/** Structural subset of GoalAuditEventDetails (avoids a goal.ts import cycle). */
export interface AuditEventEmission {
	readonly content: string;
	readonly phase: "started" | "rejected" | "passed";
	readonly goalId: string;
	readonly auditor?: string;
}

export interface CompletionAuditArgs {
	ctx: ExtensionContext;
	/** The audit target with auditAttempts already incremented and persisted. */
	goal: GoalRecord;
	completionSummary: string | undefined;
	detailedSummaryText: string;
	signal: AbortSignal | undefined;
	/** Emit one GOAL_AUDIT_ENTRY message (pi.sendMessage in the adapter). */
	sendAuditEvent: (emission: AuditEventEmission) => void;
	/** Test seam: inject a fake auditor (defaults to the real subagent run). */
	auditor?: typeof runGoalCompletionAuditor;
}

export type CompletionAuditOutcome =
	| { verdict: "rejected"; goalId: string; rejectionText: string; auditorModel?: string }
	| { verdict: "passed"; goalId: string; approvalText: string; auditorModel?: string };

function auditorLabelFor(config: ReturnType<typeof loadGoalAuditorFileConfig>): string {
	return config.provider || config.model || config.thinkingLevel
		? `${config.provider ?? "default"}/${config.model ?? "default"}${config.thinkingLevel ? `:${config.thinkingLevel}` : ""}`
		: "default";
}

function modelLine(model: string | undefined, thinkingLevel: string | undefined): string | undefined {
	return model ? `Auditor model: ${model}${thinkingLevel ? `:${thinkingLevel}` : ""}` : undefined;
}

export async function runCompletionAudit(args: CompletionAuditArgs): Promise<CompletionAuditOutcome> {
	// Append ledger: completion requested
	try {
		appendGoalEvent(args.ctx, {
			type: "completion_requested",
			goalId: args.goal.id,
			summary: args.completionSummary,
			at: nowIso(),
		});
	} catch {
		// Ledger append failure should not block completion
	}

	const auditorConfig = loadGoalAuditorFileConfig(args.ctx.cwd);
	const auditorLabel = auditorLabelFor(auditorConfig);
	args.sendAuditEvent({
		content: [
			"Auditor: I am starting the independent completion audit.",
			`Goal id: ${args.goal.id}`,
			`Auditor model: ${auditorLabel}`,
			args.completionSummary?.trim() ? `Completion claim: ${args.completionSummary.trim()}` : undefined,
		]
			.filter((line): line is string => line !== undefined)
			.join("\n"),
		phase: "started",
		goalId: args.goal.id,
		auditor: auditorLabel,
	});
	// Append ledger: audit started
	try {
		appendGoalEvent(args.ctx, {
			type: "audit_started",
			goalId: args.goal.id,
			provider: auditorConfig.provider,
			model: auditorConfig.model,
			thinkingLevel: auditorConfig.thinkingLevel,
			at: nowIso(),
		});
	} catch {
		// Ledger append failure should not block completion
	}

	const auditor = await (args.auditor ?? runGoalCompletionAuditor)({
		ctx: args.ctx,
		goal: args.goal,
		completionSummary: args.completionSummary,
		detailedSummary: args.detailedSummaryText,
		signal: args.signal,
	});
	// Append ledger: audit result
	const verdict = auditor.approved ? "approved" : auditor.error ? "error" : ("disapproved" as const);
	try {
		appendGoalEvent(args.ctx, {
			type: "audit_result",
			goalId: args.goal.id,
			verdict,
			report: auditor.output || "Auditor produced no output.",
			at: nowIso(),
		});
	} catch {
		// Ledger append failure should not block completion
	}

	if (!auditor.approved) {
		const rejectionText = [
			"Goal audit rejected.",
			"",
			"Goal completion rejected by independent auditor.",
			modelLine(auditor.model, auditor.thinkingLevel),
			auditor.error ? `Auditor error: ${auditor.error}` : undefined,
			"",
			auditor.output || "Auditor produced no approval marker.",
		]
			.filter((line): line is string => line !== undefined)
			.join("\n");
		args.sendAuditEvent({ content: rejectionText, phase: "rejected", goalId: args.goal.id, auditor: auditor.model });
		return { verdict: "rejected", goalId: args.goal.id, rejectionText, auditorModel: auditor.model };
	}

	const approvalText = [
		"Auditor: I approve this completion claim.",
		modelLine(auditor.model, auditor.thinkingLevel),
		"",
		auditor.output || "Auditor approved completion.",
	]
		.filter((line): line is string => line !== undefined)
		.join("\n");
	args.sendAuditEvent({ content: approvalText, phase: "passed", goalId: args.goal.id, auditor: auditor.model });
	return { verdict: "passed", goalId: args.goal.id, approvalText, auditorModel: auditor.model };
}
