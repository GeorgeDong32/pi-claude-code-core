import { DEFAULT_AUDIT_TIMEOUT_MS, loadGoalAuditorFileConfig, runGoalCompletionAuditor, type GoalAuditorResult } from "./goal-auditor.ts";
import { appendGoalEvent } from "./goal-ledger.ts";
import { nowIso, type GoalRecord } from "./goal-record.ts";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export { DEFAULT_AUDIT_TIMEOUT_MS };

export interface AuditEventEmission {
	readonly content: string;
	readonly phase: "started" | "rejected" | "passed";
	readonly goalId: string;
	readonly auditor?: string;
}

export interface CompletionAuditArgs {
	ctx: ExtensionContext;
	goal: GoalRecord;
	completionSummary: string | undefined;
	detailedSummaryText: string;
	signal: AbortSignal | undefined;
	sendAuditEvent: (emission: AuditEventEmission) => void;
	auditor?: typeof runGoalCompletionAuditor;
	timeoutMs?: number;
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

export interface PendingAchievement {
	content: string;
	details: {
		phase: "approved";
		goalId: string;
		auditor?: string;
		viewOnly?: boolean;
		achievedAt?: number;
		activeSeconds?: number;
		tokensUsed?: number;
		costUsed?: number;
		auditAttempts?: number;
	};
}

export function createPendingAchievementSlot(): { hold(m: PendingAchievement): void; flush(): PendingAchievement | null; peek(): PendingAchievement | null } {
	let held: PendingAchievement | null = null;
	return {
		hold(message) {
			held = message;
		},
		flush() {
			const message = held;
			held = null;
			return message;
		},
		peek() {
			return held;
		},
	};
}

export async function runCompletionAudit(args: CompletionAuditArgs): Promise<CompletionAuditOutcome> {
	try {
		appendGoalEvent(args.ctx, {
			type: "completion_requested",
			goalId: args.goal.id,
			summary: args.completionSummary,
			at: nowIso(),
		});
	} catch {
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
	}

	const timeoutMs = args.timeoutMs ?? DEFAULT_AUDIT_TIMEOUT_MS;
	const internal = new AbortController();
	let rejectNever: ((reason: unknown) => void) | null = null;
	const neverAborted = new Promise<never>((_, reject) => {
		rejectNever = reject;
	});
	neverAborted.catch(() => {});
	const onInternalAbort = () => rejectNever?.(internal.signal.reason ?? new Error("audit aborted"));
	internal.signal.addEventListener("abort", onInternalAbort, { once: true });
	const onToolAbort = () => internal.abort(new Error("audit aborted by user"));
	args.signal?.addEventListener("abort", onToolAbort, { once: true });
	const timer = setTimeout(() => internal.abort(new Error(`audit timed out after ${Math.round(timeoutMs / 1000)}s`)), timeoutMs);
	let timedOut = false;
	let userAborted = false;
	let auditorResult: GoalAuditorResult | undefined;
	try {
		if (args.signal?.aborted) {
			userAborted = true;
		} else {
			const auditorPromise = (args.auditor ?? runGoalCompletionAuditor)({
				ctx: args.ctx,
				goal: args.goal,
				completionSummary: args.completionSummary,
				detailedSummary: args.detailedSummaryText,
				signal: internal.signal,
			});
			auditorPromise.catch(() => {}); // if the abort branch wins the race, the loser must not surface as unhandled
			auditorResult = await Promise.race([auditorPromise, neverAborted]);
		}
	} catch (error) {
		const reason = internal.signal.reason;
		if (reason instanceof Error && /timed out/.test(reason.message)) {
			timedOut = true;
		} else if (args.signal?.aborted) {
			userAborted = true;
		} else {
			throw error;
		}
	} finally {
		clearTimeout(timer);
		args.signal?.removeEventListener("abort", onToolAbort);
		internal.signal.removeEventListener("abort", onInternalAbort);
		rejectNever = null;
	}
	if (timedOut || userAborted) {
		const head = timedOut
			? `Goal audit timed out after ${Math.round(timeoutMs / 1000)}s. The goal remains active.`
			: "Goal audit aborted by user. The goal remains active.";
		const rejectionText = [head, "", "No completion verdict was reached. You may call tools.update_goal again (codemode) to re-run the audit."].join("\n");
		try {
			appendGoalEvent(args.ctx, {
				type: "audit_result",
				goalId: args.goal.id,
				verdict: "error",
				report: head,
				at: nowIso(),
			});
		} catch {
		}
		args.sendAuditEvent({ content: rejectionText, phase: "rejected", goalId: args.goal.id });
		return { verdict: "rejected", goalId: args.goal.id, rejectionText };
	}

	const auditor = auditorResult as GoalAuditorResult;
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
