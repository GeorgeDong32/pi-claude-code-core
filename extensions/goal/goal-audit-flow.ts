/**
 * goal-audit-flow.ts — the completion-audit orchestration (arch B7 step 2,
 * carved out of the update_goal tool body in the goal.ts monolith).
 *
 * Pure orchestration over direct imports (goal-auditor, goal-ledger,
 * goal-record): auditor config resolution, the started/rejected/passed
 * event trio, and the ledger writes. The emit seam is injected — the
 * adapter owns pi.sendMessage — so no pi dependency and no import cycle.
 *
 * AR1005-AU-01 (2026-10-05): the bounded-wait envelope establishes its
 * internal-cancellation result FIRST, then connects the external tool
 * signal, then checks that signal's CURRENT state — a pre-aborted call
 * never invokes the auditor (no new model work) and returns the existing
 * rejected outcome; timer + both listeners are released on every exit
 * path. The started event means "the audit flow was requested", not "the
 * model ran" (spec 2026-10-05 §5 AU-01.3).
 *
 * State changes (auditAttempts++, persist, pendingGoalAchievement,
 * stopActiveGoal) stay in the adapter; this module only reports the
 * outcome with ready-to-render text.
 */
import { DEFAULT_AUDIT_TIMEOUT_MS, loadGoalAuditorFileConfig, runGoalCompletionAuditor, type GoalAuditorResult } from "./goal-auditor.ts";
import { appendGoalEvent } from "./goal-ledger.ts";
import { nowIso, type GoalRecord } from "./goal-record.ts";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

// Re-exported for consumers that read the budget off the flow (single source lives in goal-auditor.ts).
export { DEFAULT_AUDIT_TIMEOUT_MS };

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
	/** Total audit budget in ms (spec 2026-10-04-goal-audit-hang-fix §3.2).
	 *  On expiry the flow returns a rejected outcome (goal stays active) instead
	 *  of hanging forever; defaults to DEFAULT_AUDIT_TIMEOUT_MS. */
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

/**
 * The approved-audit message held until the finishing turn settles, so
 * "Goal achieved" lands after the model's closing summary (the adapter's
 * agent_settled handler flushes it). B7 step 3: this state belongs to the
 * audit domain — it lived as a bare factory-closure variable before.
 */
export interface PendingAchievement {
	content: string;
	details: {
		phase: "approved";
		goalId: string;
		auditor?: string;
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

	// Bounded-wait envelope (spec 2026-10-04-goal-audit-hang-fix §3.2; AR1005-AU-01
	// 2026-10-05): the auditor must finish within timeoutMs or the flow returns
	// a rejected outcome so update_goal always returns. Tool abort (Esc) rides
	// the same envelope. The internal controller's signal is what the auditor
	// session receives; both timeout and user abort land on it.
	//
	// AR1005-AU-01 ordering: (1) establish the internal-cancellation result and
	// its cleanup FIRST, (2) then connect the external signal, (3) then check
	// the external signal's CURRENT state — a pre-aborted tool call must not
	// invoke the auditor at all (no new model work) and returns the existing
	// rejected outcome. Establishing the internal listener before any abort can
	// fire also guarantees the never-resolving-race branch can never occur.
	const timeoutMs = args.timeoutMs ?? DEFAULT_AUDIT_TIMEOUT_MS;
	const internal = new AbortController();
	// (1) internal cancellation result + its cleanup, FIRST.
	let rejectNever: ((reason: unknown) => void) | null = null;
	const neverAborted = new Promise<never>((_, reject) => {
		rejectNever = reject;
	});
	// Neither race participant may become an unhandled rejection: the loser of
	// the race keeps running/settles later (auditor) or rejects late (aborted).
	neverAborted.catch(() => {});
	const onInternalAbort = () => rejectNever?.(internal.signal.reason ?? new Error("audit aborted"));
	internal.signal.addEventListener("abort", onInternalAbort, { once: true });
	// (2) connect the external signal …
	const onToolAbort = () => internal.abort(new Error("audit aborted by user"));
	args.signal?.addEventListener("abort", onToolAbort, { once: true });
	const timer = setTimeout(() => internal.abort(new Error(`audit timed out after ${Math.round(timeoutMs / 1000)}s`)), timeoutMs);
	let timedOut = false;
	let userAborted = false;
	let auditorResult: GoalAuditorResult | undefined;
	try {
		if (args.signal?.aborted) {
			// AU-01.2: pre-aborted on entry — no auditor invocation, no model work;
			// the started event above still fired ("requested", not "model ran").
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
			// Real auditor failure (not timeout/abort): rethrow after cleanup —
			// pi surfaces it as a normal tool error; goal stays active.
			throw error;
		}
	} finally {
		// AU-01.5: timer, external listener and internal listener released on
		// EVERY exit path.
		clearTimeout(timer);
		args.signal?.removeEventListener("abort", onToolAbort);
		internal.signal.removeEventListener("abort", onInternalAbort);
		rejectNever = null;
	}
	if (timedOut || userAborted) {
		const head = timedOut
			? `Goal audit timed out after ${Math.round(timeoutMs / 1000)}s. The goal remains active.`
			: "Goal audit aborted by user. The goal remains active.";
		const rejectionText = [head, "", "No completion verdict was reached. You may call update_goal again to re-run the audit."].join("\n");
		try {
			appendGoalEvent(args.ctx, {
				type: "audit_result",
				goalId: args.goal.id,
				verdict: "error",
				report: head,
				at: nowIso(),
			});
		} catch {
			// Ledger append failure should not block the rejection path
		}
		args.sendAuditEvent({ content: rejectionText, phase: "rejected", goalId: args.goal.id });
		return { verdict: "rejected", goalId: args.goal.id, rejectionText };
	}

	const auditor = auditorResult as GoalAuditorResult; // neverAborted is Promise<never>, so only the auditor can win the race
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
