import { Type } from "typebox";
import { defineTool, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { notify as uiNotify } from "../ui/notify.ts";
import { statusLabel, truncateText } from "./goal-core.ts";
import { goalDetails, GOAL_AUDIT_ENTRY } from "./goal-entries.ts";
import { detailedSummary, missingCriteriaLines, AUDIT_ATTEMPT_NOTICE } from "./goal-summary.ts";
import { renderGoalResult, type GoalAuditEventDetails } from "./renderers.ts";
import { buildDraftConfirmationText, validateGoalDraftProposal } from "./goal-draft.ts";
import { loadGoalAuditorFileConfig } from "./goal-auditor.ts";
import type { runGoalCompletionAuditor } from "./goal-auditor.ts";
import { proposalDialogFailureMessage, shouldAutoConfirmProposal, showProposalDialog } from "./goal-questionnaire.ts";
import {
	ABORT_GOAL_TOOL_NAME,
	CREATE_GOAL_TOOL_NAME,
	PROPOSE_DRAFT_TOOL_NAME,
	SISYPHUS_STEP_TOOL_NAME,
	TWEAK_APPLY_TOOL_NAME,
} from "./goal-tool-names.ts";
import type { GoalCreationConfig, GoalRecord } from "./goal-record.ts";
import { mergeGoalPromptFromDisk } from "./storage/goal-files.ts";
import { appendGoalEvent } from "./goal-ledger.ts";
import { otherOpenGoalCount, buildUnfocusedOpenGoalsSummary } from "./goal-pool.ts";
import {
	buildCompletionReport,
	buildGoalCreatedReport,
	validateGoalAbort,
	validateGoalCompletion,
	validateNoDraftingPhase,
	validatePauseGoal,
} from "./goal-policy.ts";
import type { GoalLifecycle } from "./goal-lifecycle.ts";
import { createPendingAchievementSlot, runCompletionAudit } from "./goal-audit-flow.ts";

function StringEnum<T extends readonly string[]>(values: T, options?: { description?: string; default?: T[number] }) {
	return Type.Unsafe<T[number]>({ type: "string", enum: [...values], ...(options?.description !== undefined ? { description: options.description } : {}), ...(options?.default !== undefined ? { default: options.default } : {}) });
}

export const COMPLETE_STATUS = "complete";

export interface GoalToolsDeps {
	lifecycle: GoalLifecycle;
	reconcileFocusedGoalFromDisk: (ctx: ExtensionContext, opts?: { preserveMemoryUsage?: boolean; captureDiskGoal?: { goal: GoalRecord | null } }) => boolean;
	syncGoalPromptFromDisk: (ctx: ExtensionContext, readCtx?: { goal: GoalRecord | null }) => boolean;
	syncGoalTools: () => void;
	goalForDisplay: () => GoalRecord | null;
	openGoals: () => GoalRecord[];
	getRunningGoalId: () => string | null;
	accountProgress: (ctx: ExtensionContext, opts?: { completedTurnTokens?: number; completedTurnCost?: number }) => void;
	replaceGoal: (config: GoalCreationConfig, ctx: ExtensionContext, startNow?: boolean) => void;
	pendingAchievement: ReturnType<typeof createPendingAchievementSlot>;
	auditor?: typeof runGoalCompletionAuditor;
}

export function registerGoalTools(pi: ExtensionAPI, deps: GoalToolsDeps): void {
	const {
		lifecycle,
		reconcileFocusedGoalFromDisk,
		syncGoalPromptFromDisk,
		syncGoalTools,
		goalForDisplay,
		openGoals,
		getRunningGoalId,
		accountProgress,
		replaceGoal,
		pendingAchievement,
	} = deps;

pi.registerTool(defineTool({
	name: "get_goal",
	label: "Get Goal",
	description: "Get the current pi goal for this session: objective, status, auto-continue, usage, and local file paths.",
	promptSnippet: "Read the active pi goal state for the current session.",
	promptGuidelines: [
		"Call get_goal for the current goal; goal actions run from codemode (tools.update_goal / tools.pause_goal / tools.abort_goal).",
		"Before marking complete, compare every requirement with concrete evidence.",
	],
	parameters: Type.Object({}),
	async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
		reconcileFocusedGoalFromDisk(ctx);
		if (lifecycle.focused()) syncGoalPromptFromDisk(ctx);
		syncGoalTools();
		const view = goalForDisplay() ?? lifecycle.focused();
		const otherCount = otherOpenGoalCount(lifecycle.pool, lifecycle.focusedId);
		let nudge = "";
		if (view && view.status === "active" && view.id) {
			const prior = lifecycle.getGoalNudgeCount(view.id);
			if (prior >= 2) {
				nudge = "\n\n[NUDGE] You have called get_goal multiple times recently. Prefer concrete work tools (write/read/bash/edit) to advance the goal.";
			}
		}
		const pauseClause = view?.status === "active" ? " if blocked, call tools.pause_goal({reason, suggestedAction}) and stop;" : "";
		const lifecycleHint = view && (view.status === "active" || view.status === "paused")
			? `\nGoal actions run from codemode scripts: if evidence proves the objective is satisfied, call tools.update_goal({status: "complete", completionSummary});${pauseClause} if the user abandons it or it is obsolete/unsafe, call tools.abort_goal({reason}) and stop. For file or shell work, use the normal work tools directly (write/read/bash/edit); do not call get_goal repeatedly just to look for tools.`
			: "";
		const text = view
			? `${detailedSummary(view)}${lifecycleHint}${nudge}${otherCount > 0 ? `\nOther open goals: ${otherCount} (human can run /goal-list or /goal-focus)` : ""}`
			: openGoals().length > 0
				? buildUnfocusedOpenGoalsSummary(openGoals().length)
				: detailedSummary(null);
		return {
			content: [{ type: "text", text }],
			details: goalDetails(view),
		};
	},
	renderCall(_args, theme) {
		return new Text(theme.fg("toolTitle", "get_goal"), 0, 0);
	},
	renderResult(result, _options, theme) {
		return renderGoalResult(result, theme);
	},
}));

pi.registerTool(defineTool({
	name: "create_goal",
	label: "Create Goal",
	description: "Create a new active pi goal and focus it. Hidden outside drafting flows; propose_goal_draft is the normal commit path.",
	promptSnippet: "Create a persistent pi goal when the user explicitly asks for one or when a goal-drafting interview has converged.",
	promptGuidelines: [
		"Use create_goal only when the user explicitly asks to start a long-running goal, OR when a /goals or /sisyphus intent discussion has produced a concrete objective.",
		"Creating a new goal focuses it and leaves other open goals untouched. Do not archive or replace existing goals unless the user explicitly asks through a user command.",
		"Pass sisyphus=true only when the goal came out of /sisyphus intent discussion or /sisyphus-set, or when the user explicitly invoked Sisyphus mode.",
	],
	parameters: Type.Object({
		objective: Type.String({ description: "Concrete objective to pursue. For Sisyphus goals this MUST be the full plan including numbered steps and per-step done criteria." }),
		autoContinue: Type.Optional(Type.Boolean({ description: "Whether pi should keep sending continuation prompts until complete. Defaults to true." })),
		sisyphus: Type.Optional(Type.Boolean({ description: "When true, mark this as a Sisyphus goal: the agent must execute strictly step-by-step, no skipping, no rushing, no improvising. Default false." })),
	}),
	executionMode: "sequential",
	async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
		return {
			content: [{ type: "text", text: "create_goal REJECTED: direct agent creation is disabled. Use /goals or /sisyphus with propose_goal_draft for confirmation, or have the user invoke /goals-set or /sisyphus-set for immediate creation." }],
			details: goalDetails(lifecycle.focused()),
		};
	},
	renderCall(args, theme) {
		const prefix = args?.sisyphus ? "create_goal sisyphus " : "create_goal ";
		return new Text(theme.fg("toolTitle", prefix) + theme.fg("muted", args?.objective ?? ""), 0, 0);
	},
	renderResult(result, _options, theme) {
		return renderGoalResult(result, theme);
	},
}));

pi.registerTool(defineTool({
	name: PROPOSE_DRAFT_TOOL_NAME,
	label: "Propose Goal Draft",
	description: "Propose the goal draft in a /goals or /sisyphus discussion (Confirm creates it; Continue Chatting refines).",
	promptSnippet: "Propose the drafted goal for Confirm / Continue Chatting.",
	promptGuidelines: [
		"sisyphus must match the discussion: /sisyphus -> true, /goals -> false (schema-enforced).",
		"Sisyphus goals: keep the user's ordered steps and done criteria verbatim.",
		"On 'continue chatting', ask what to change before proposing again.",
		"create_goal is rejected on purpose: this is the only confirmation path.",
	],
	parameters: Type.Object({
		objective: Type.String({ description: "Full goal text (sisyphus: numbered steps + done criteria)." }),
		autoContinue: Type.Optional(Type.Boolean({ description: "Keep sending continuation prompts until complete (default true)." })),
		sisyphus: Type.Optional(Type.Boolean({ description: "true for /sisyphus, false for /goals." })),
	}),
	executionMode: "sequential",
	async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
		const validation = validateGoalDraftProposal({
			intent: lifecycle.confirmationIntent,
			hasUnfinishedGoal: (() => { const g = lifecycle.focused(); return !!g && g.status !== "complete"; })(),
			objective: params.objective,
			sisyphus: params.sisyphus,
		});
		if (!validation.ok) {
			if (validation.clearDrafting) {
				lifecycle.handle({ tag: "draft-cancel", kind: "goal" });
				syncGoalTools();
			}
			return {
				content: [{ type: "text", text: validation.message }],
				details: goalDetails(lifecycle.focused()),
			};
		}
		const activeIntent = lifecycle.confirmationIntent;
		if (!activeIntent) throw new Error("Goal confirmation intent disappeared during proposal validation.");

		const objective = validation.objective;
		const autoContinueFlag = params.autoContinue ?? true;
		const sisyphusFlag = validation.expectedSisyphus;
		const draftSummary = buildDraftConfirmationText({
			focus: activeIntent.focus,
			originalTopic: activeIntent.originalTopic,
			objective,
			autoContinue: autoContinueFlag,
		});

		const headless = shouldAutoConfirmProposal({ hasUI: ctx.hasUI, autoConfirmEnv: process.env.PI_GOAL_AUTO_CONFIRM });

		let decision: "confirm" | "continue";
		if (headless) {
			decision = "confirm";
		} else {
			try {
				decision = await showProposalDialog(ctx, draftSummary, activeIntent.focus);
			} catch (err) {
				const message = proposalDialogFailureMessage(err);
				uiNotify(ctx, message, "error");
				return {
					content: [{ type: "text", text: message }],
					details: goalDetails(lifecycle.focused()),
				};
			}
		}

		if (decision === "confirm") {
			const config: GoalCreationConfig = {
				objective,
				autoContinue: autoContinueFlag,
				sisyphus: sisyphusFlag,
			};
			lifecycle.handle({ tag: "draft-applied", kind: "goal" });
			replaceGoal(config, ctx, false);
			syncGoalTools();
			return {
				content: [{ type: "text", text: buildGoalCreatedReport({ objective, detailedSummary: detailedSummary(lifecycle.focused()), autoContinue: lifecycle.focused()?.autoContinue, sisyphus: lifecycle.focused()?.sisyphus }) }],
				details: goalDetails(lifecycle.focused(), "created"),
				terminate: true,
			};
		}
		return {
			content: [{
				type: "text",
				text: "User clicked 'Continue Chatting'. The goal was NOT created. Ask the user what they want to change about the draft (objective, scope, criteria, steps), then revise and call propose_goal_draft again. Do not call propose_goal_draft again with the same content — wait for the user's input first.",
			}],
			details: goalDetails(lifecycle.focused()),
		};
	},
	renderCall(args, theme) {
		const prefix = args?.sisyphus ? "propose_goal_draft sisyphus " : "propose_goal_draft ";
		return new Text(theme.fg("toolTitle", prefix) + theme.fg("muted", truncateText(args?.objective ?? "", 80)), 0, 0);
	},
	renderResult(result, _options, theme) {
		return renderGoalResult(result, theme);
	},
}));
pi.registerTool(defineTool({
	name: "update_goal",
	label: "Update Goal",
	exposure: "codemode" as const,
	description: "Mark the current active or paused pi goal complete; launches the independent completion auditor.",
	parameters: Type.Object({
		status: StringEnum([COMPLETE_STATUS] as const, { description: "Set to complete only when the objective is achieved." }),
		completionSummary: Type.Optional(Type.String({ description: "Concise completion claim and evidence summary passed to the independent auditor agent." })),
	}),
	executionMode: "sequential",
	async execute(_toolCallId, params, signal, _onUpdate, ctx) {
		reconcileFocusedGoalFromDisk(ctx);
		if (params.status !== COMPLETE_STATUS) throw new Error("update_goal only supports status=complete.");
		const draftingGate = validateNoDraftingPhase(lifecycle, "update_goal");
		if (!draftingGate.ok) return { content: [{ type: "text", text: draftingGate.message }], details: goalDetails(lifecycle.focused()) };
		const completionGate = validateGoalCompletion({ goal: lifecycle.focused(), runningGoalId: getRunningGoalId() });
		if (!completionGate.ok) {
			return {
				content: [{ type: "text", text: completionGate.message }],
				details: goalDetails(lifecycle.focused()),
			};
		}
		const auditSource = lifecycle.focused();
		if (!auditSource) throw new Error("Goal disappeared during completion validation.");
		const auditAttemptNo = (auditSource.auditAttempts ?? 0) + 1;
		if (auditAttemptNo === AUDIT_ATTEMPT_NOTICE) {
			uiNotify(ctx, `Goal ${auditSource.id}: third completion attempt — the auditor has rejected this goal twice already. Consider whether the objective is actually achievable as written.`, "warning");
		}
		const missingCriteria = missingCriteriaLines(auditSource.objective, params.completionSummary ?? "");
		if (missingCriteria.length > 0) {
			try {
				pi.sendMessage(
					{
						customType: "pi-goal-missing-criteria",
						content: `[goal] The completion summary is missing [Cn] evidence lines for: ${missingCriteria.map((id) => `[${id}]`).join(", ")}. Future completion requests should cover every numbered criterion in the objective (one [Cn]-tagged line each). The current audit proceeds unchanged.`,
						display: false,
					},
					{ deliverAs: "followUp", triggerTurn: false },
				);
			} catch {
			}
		}
		const auditTarget = { ...mergeGoalPromptFromDisk(ctx, auditSource), auditAttempts: auditAttemptNo };
		lifecycle.recordAuditAttempt(ctx, auditAttemptNo);
		const outcome = await runCompletionAudit({
			ctx,
			goal: auditTarget,
			completionSummary: params.completionSummary,
			detailedSummaryText: detailedSummary(auditTarget),
			signal,
			auditor: deps.auditor,
			timeoutMs: loadGoalAuditorFileConfig(ctx.cwd).auditTimeoutMs,
			sendAuditEvent: ({ content, phase, goalId, auditor }) => {
				pi.sendMessage<GoalAuditEventDetails>({
					customType: GOAL_AUDIT_ENTRY,
					content,
					display: true,
					details: { phase, goalId, auditor, viewOnly: true },
				});
			},
		});
		if (outcome.verdict === "rejected") {
			return {
				content: [{ type: "text", text: outcome.rejectionText }],
				details: goalDetails(lifecycle.focused(), "rejected"),
			};
		}
		accountProgress(ctx);
		const finalUsage = lifecycle.focused() ? { ...lifecycle.focused()!.usage } : null;
		pendingAchievement.hold({
			content: outcome.approvalText,
			details: {
				phase: "approved",
				goalId: outcome.goalId,
				auditor: outcome.auditorModel,
				viewOnly: true,
				...(finalUsage
					? { achievedAt: Date.now(), activeSeconds: finalUsage.activeSeconds, tokensUsed: finalUsage.tokensUsed, costUsed: finalUsage.costUsed, auditAttempts: auditAttemptNo }
					: {}),
			},
		});
		const report = lifecycle.complete(auditTarget, ctx);
		const completedGoal = report.record ?? null;
		lifecycle.handle({ tag: "turn-stopped", goalId: completedGoal?.id ?? null });
		return {
			content: [{
				type: "text",
				text: buildCompletionReport({
					detailedSummary: detailedSummary(completedGoal),
					completionSummary: params.completionSummary,
				}),
			}],
			details: goalDetails(completedGoal, "complete"),
			terminate: true,
		};
	},
	renderCall(args, theme) {
		return new Text(theme.fg("toolTitle", "update_goal ") + theme.fg("success", args.status), 0, 0);
	},
	renderResult(result, _options, theme) {
		return renderGoalResult(result, theme);
	},
}));

pi.registerTool(defineTool({
	name: "pause_goal",
	label: "Pause Goal",
	exposure: "codemode" as const,
	description: "Pause the active pi goal with a concrete blocker reason; the user resumes via /goal-resume.",
	parameters: Type.Object({
		reason: Type.String({ description: "One-sentence concrete blocker description. Plain language, not an apology." }),
		suggestedAction: Type.Optional(Type.String({ description: "Optional concrete suggestion for how the user can unblock (e.g. command to run, value to provide, /goal-tweak hint)." })),
	}),
	executionMode: "sequential",
	async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
		reconcileFocusedGoalFromDisk(ctx);
		const reason = params.reason.trim();
		if (!reason) throw new Error("pause_goal requires a non-empty reason.");
		const draftingGate = validateNoDraftingPhase(lifecycle, "pause_goal");
		if (!draftingGate.ok) return { content: [{ type: "text", text: draftingGate.message }], details: goalDetails(lifecycle.focused()) };
		const pauseGate = validatePauseGoal({ goal: lifecycle.focused(), runningGoalId: getRunningGoalId(), reason });
		if (!pauseGate.ok) {
			return {
				content: [{ type: "text", text: pauseGate.message }],
				details: goalDetails(lifecycle.focused()),
			};
		}
		if (!lifecycle.focused()) throw new Error("Goal disappeared during pause validation.");
		const suggested = params.suggestedAction?.trim() || undefined;

		accountProgress(ctx);
		lifecycle.pauseByAgent(ctx, { reason, suggestedAction: suggested });

		const suggestionLine = suggested ? `\nSuggested: ${truncateText(suggested, 160)}` : "";
		uiNotify(ctx, 
			`Goal paused by agent.\nReason: ${truncateText(reason, 200)}${suggestionLine}\n\nUse /goal-resume to continue, /goal-tweak to revise, or /goal-clear to abandon.`,
			"warning",
		);
		return {
			content: [{
				type: "text",
				text: `Goal paused. Reason: ${reason}${suggested ? `\nSuggested: ${suggested}` : ""}\nWaiting for user to /goal-resume, /goal-tweak, or /goal-clear. Stop now; do not start another tool call.`,
			}],
			details: goalDetails(lifecycle.focused(), "paused"),
			terminate: true,
		};
	},
	renderCall(args, theme) {
		return new Text(theme.fg("toolTitle", "pause_goal ") + theme.fg("warning", truncateText(args?.reason ?? "", 80)), 0, 0);
	},
	renderResult(result, _options, theme) {
		return renderGoalResult(result, theme);
	},
}));

pi.registerTool(defineTool({
	name: ABORT_GOAL_TOOL_NAME,
	label: "Abort Goal",
	exposure: "codemode" as const,
	description: "Abort the current active or paused pi goal and archive it without marking it complete.",
	parameters: Type.Object({
		reason: Type.String({ description: "One-sentence reason for abandoning the current goal. Plain language, not an apology." }),
	}),
	executionMode: "sequential",
	async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
		reconcileFocusedGoalFromDisk(ctx);
		const reason = params.reason.trim();
		if (!reason) throw new Error("abort_goal requires a non-empty reason.");
		const draftingGate = validateNoDraftingPhase(lifecycle, "abort_goal");
		if (!draftingGate.ok) return { content: [{ type: "text", text: draftingGate.message }], details: goalDetails(lifecycle.focused()) };
		const abortGate = validateGoalAbort({ goal: lifecycle.focused(), runningGoalId: getRunningGoalId(), reason });
		if (!abortGate.ok) {
			return {
				content: [{ type: "text", text: abortGate.message }],
				details: goalDetails(lifecycle.focused()),
			};
		}
		const abortSource = lifecycle.focused();
		if (!abortSource) throw new Error("Goal disappeared during abort validation.");
		const abortedGoalId = abortSource.id;

		accountProgress(ctx);
		const report = lifecycle.terminate("abort", ctx, { by: "agent", reason });
		const archived = report.record ?? null;
		lifecycle.handle({ tag: "turn-stopped", goalId: abortedGoalId });

		const archiveLine = archived?.archivedPath ? `\nArchive: ${archived.archivedPath}` : "";
		uiNotify(ctx,
			`Goal aborted by agent.\nReason: ${truncateText(reason, 200)}${archiveLine}`,
			"warning",
		);
		return {
			content: [{
				type: "text",
				text: `Goal aborted. Reason: ${reason}${archiveLine}\nThe goal has been archived and cleared. Stop now; do not start another tool call.`,
			}],
			details: goalDetails(lifecycle.focused(), "aborted"),
			terminate: true,
		};
	},
	renderCall(args, theme) {
		return new Text(theme.fg("toolTitle", "abort_goal ") + theme.fg("warning", truncateText(args?.reason ?? "", 80)), 0, 0);
	},
	renderResult(result, _options, theme) {
		return renderGoalResult(result, theme);
	},
}));

pi.registerTool(defineTool({
	name: SISYPHUS_STEP_TOOL_NAME,
	label: "Sisyphus Step Complete (Legacy)",
	description: "Legacy compatibility tool. Current Sisyphus mode is a prompt/criteria style and no longer uses schema-tracked step completion.",
	promptSnippet: "Legacy no-op: Sisyphus no longer requires step_complete.",
	promptGuidelines: [
		"Do not call this in normal operation. Sisyphus mode shares the normal goal lifecycle and completion gate.",
		"Complete the goal with update_goal(status=complete) only when the full objective is actually satisfied.",
	],
	parameters: Type.Object({
		stepIndex: Type.Integer({ minimum: 1, description: "Legacy step index. Ignored." }),
		evidence: Type.String({ description: "Legacy evidence text. Ignored by the schema." }),
		verifyCommand: Type.Optional(Type.String({ description: "Legacy field. Not executed." })),
	}),
	executionMode: "sequential",
	async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
		return {
			content: [{ type: "text", text: "step_complete is no longer required. Sisyphus is now a prompt/criteria style that uses the normal goal lifecycle. Continue working from the objective, or call update_goal(status=complete) only when the full objective is satisfied." }],
			details: goalDetails(lifecycle.focused()),
		};
	},
	renderCall(args, theme) {
		return new Text(theme.fg("toolTitle", "step_complete legacy ") + theme.fg("muted", `#${args?.stepIndex ?? "?"}`), 0, 0);
	},
	renderResult(result, _options, theme) {
		return renderGoalResult(result, theme);
	},
}));

pi.registerTool(defineTool({
	name: TWEAK_APPLY_TOOL_NAME,
	label: "Apply Goal Tweak",
	exposure: "codemode" as const,
	description: "Atomically apply a /goal-tweak revision to the active goal (only during a /goal-tweak interview).",
	parameters: Type.Object({
		newObjective: Type.String({ description: "The complete revised objective text. For Sisyphus goals, preserve the Sisyphus style unless the user explicitly changes it." }),
		changeSummary: Type.String({ description: "One-sentence description of what was changed (used in UI notification and tweak log)." }),
	}),
	executionMode: "sequential",
	async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
		reconcileFocusedGoalFromDisk(ctx);
		const tweakGoal = lifecycle.focused();
		if (!tweakGoal) {
			return {
				content: [{ type: "text", text: "No goal is set; apply_goal_tweak is a no-op." }],
				details: goalDetails(null),
			};
		}
		if (lifecycle.tweakDraftingFor !== tweakGoal.id) {
			return {
				content: [{
					type: "text",
					text: "apply_goal_tweak REJECTED: no /goal-tweak drafting flow is active for this goal. " +
						"This tool can only be called during a /goal-tweak drafting interview that the user initiated. " +
						"If you want to change the goal, ask the user to run /goal-tweak.",
				}],
				details: goalDetails(lifecycle.focused()),
			};
		}
		if (tweakGoal.status !== "active" && tweakGoal.status !== "paused") {
			return {
				content: [{ type: "text", text: `Goal is ${statusLabel(tweakGoal)}; cannot apply a tweak.` }],
				details: goalDetails(tweakGoal),
			};
		}
		const newObjective = params.newObjective.trim();
		if (!newObjective) throw new Error("apply_goal_tweak requires a non-empty newObjective.");
		const changeSummary = params.changeSummary.trim();
		if (!changeSummary) throw new Error("apply_goal_tweak requires a non-empty changeSummary.");
		lifecycle.applyTweak(ctx, newObjective);
		const tweakedGoal = lifecycle.focused();
		uiNotify(ctx, `Goal tweaked: ${truncateText(changeSummary, 160)}`, "info");
		try {
			appendGoalEvent(ctx, {
				type: "goal_tweaked",
				goalId: tweakedGoal!.id,
				changeSummary,
				at: tweakedGoal!.updatedAt,
			});
		} catch {
		}
		return {
			content: [{
				type: "text",
				text: `Goal tweak applied. ${changeSummary}\nStop now; the next continuation will arrive automatically if the goal is active.`,
			}],
			details: goalDetails(lifecycle.focused()),
			terminate: true,
		};
	},
	renderCall(args, theme) {
		const summary = typeof args?.changeSummary === "string" ? truncateText(args.changeSummary, 80) : "";
		return new Text(theme.fg("toolTitle", "apply_goal_tweak ") + theme.fg("muted", summary), 0, 0);
	},
	renderResult(result, _options, theme) {
		return renderGoalResult(result, theme);
	},
}));

}
