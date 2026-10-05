import { StringEnum, Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import { notify as uiNotify } from "../ui/notify.ts";
import { isSubagentChildProcess } from "../modes/permission-forwarding.ts";
import { coreBus } from "../bus.ts";
import { Text } from "@earendil-works/pi-tui";
import {
	footerStatus,
	formatDuration,
	formatTokenValue,
	formatCostValue,
	statusLabel,
	truncateText,
	displayObjectiveTitle,
	pauseReasonLabel,
	oneLineSummary,
} from "./goal-core.ts";
import { renderGoalAuditEvent, renderGoalEvent, renderGoalResult, type GoalAuditEventDetails } from "./renderers.ts";
import {
	buildDraftConfirmationText,
	goalDraftingPrompt,
	validateGoalDraftProposal,
	type GoalDraftingFocus,
} from "./goal-draft.ts";
import {
	goalAuditorConfigPath,
	loadGoalAuditorFileConfig,
	saveGoalAuditorFileConfig,
	type GoalAuditorConfig,
} from "./goal-auditor.ts";
import {
	proposalDialogFailureMessage,
	registerQuestionnaireTools,
	shouldAutoConfirmProposal,
	showProposalDialog,
} from "./goal-questionnaire.ts";
import {
	ABORT_GOAL_TOOL_NAME,
	ACTIVE_GOAL_TOOL_NAMES,
	CREATE_GOAL_TOOL_NAME,
	POST_STOP_ALLOWED_TOOLS,
	PROPOSE_DRAFT_TOOL_NAME,
	QUESTIONNAIRE_TOOL_NAME,
	QUESTION_TOOL_NAME,
	SISYPHUS_STEP_TOOL_NAME,
	GOAL_PROGRESS_TOOL_NAMES,
	lifecycleToolNamesForGoalStatus,
	TWEAK_APPLY_TOOL_NAME,
} from "./goal-tool-names.ts";
import {
	asRecord,
	cloneGoal,
	createGoal,
	goalFocusDetails,
	normalizeGoalRecord,
	normalizeGoalFocusEntry,
	nowIso,
	type AssistantMessageLike,
	type DraftingFocus,
	type GoalFocusEntry,
	type GoalFocusReason,
	type GoalCreationConfig,
	type GoalEventDetails,
	type GoalEventKind,
	type GoalRecord,
	type GoalResultKind,
	type GoalStateEntry,
	type GoalStatus,
	type StopReason,
} from "./goal-record.ts";
import { createGoalAccounting } from "./goal-accounting.ts";
import {
	appendGoalEvent,
	latestAuditorResultForGoal,
	readGoalLedger,
	type GoalLedgerEvent,
} from "./goal-ledger.ts";
import { buildCompactionSummary } from "./goal-compaction.ts";
import {
	archiveGoalFile,
	mergeGoalPromptFromDisk,
	readActiveGoalPool,
	sanitizeGoalPaths,
	writeActiveGoalFile,
} from "./storage/goal-files.ts";
import {
	buildGoalListText,
	buildUnfocusedOpenGoalsSummary,
	focusedGoalFromPool,
	goalSelectorLabel,
	mergeFocusedGoalWithDisk,
	openGoalsFromPool,
	otherOpenGoalCount,
	resolveSessionFocus,
} from "./goal-pool.ts";
import {
	auditorRejectionBlock,
	continuationPrompt,
	goalPrompt,
	goalTweakDraftingPrompt,
	staleContinuationPrompt,
	unfocusedOpenGoalsPrompt,
	untrustedObjectiveBlock,
} from "./prompts/goal-prompts.ts";
import { buildGoalRunningNotification } from "./widgets/goal-notifications.ts";
import { createGoalUi } from "./ui.ts";

import {
	abortGoalCommandMessage,
	buildAbortedByAgentGoal,
	buildCompletionReport,
	buildGoalCreatedReport,
	buildPausedByAgentGoal,
	clearGoalCommandMessage,
	shouldArmPostCompactReminder,
	shouldInjectPostCompactReminder,
	validateGoalAbort,
	validateGoalCompletion,
	validatePauseGoal,
	validateResumeGoal,
} from "./goal-policy.ts";
import { createContinuationLoop } from "./goal-continuation.ts";
import { createPendingAchievementSlot, runCompletionAudit } from "./goal-audit-flow.ts";

const STATE_ENTRY = "pi-goal-state";
const FOCUS_ENTRY = "pi-goal-focus";
const GOAL_EVENT_ENTRY = "pi-goal-event";
const GOAL_AUDIT_ENTRY = "pi-goal-audit-event";
const COMPLETE_STATUS = "complete";
const CONTINUATION_IDLE_RETRY_MS = 50;
/**
 * Tools that count as "real work" toward the active goal. If a non-tool-use
 * turn ends without any of these having been called, we DO NOT queue the next
 * autoContinue — the agent was just chatting. This stops infinite chat loops.
 */
const GOAL_PROGRESS_TOOL_SET = new Set<string>(GOAL_PROGRESS_TOOL_NAMES);


/**
 * Tools that are NEVER blocked by the post-stop in-turn block. After pause_goal,
 * abort_goal, update_goal=complete, or apply_goal_tweak fires, the agent should
 * yield the turn; we block all subsequent tool calls except these read-only inspections.
 */
const POST_STOP_ALLOWED_TOOL_SET = new Set<string>(POST_STOP_ALLOWED_TOOLS);

/**
 * Thin session-local confirmation intent for /goals and /sisyphus.
 * It protects mode consistency and user confirmation without turning drafting
 * into a separate long-running runtime state machine.
 */
interface GoalConfirmationIntent {
	focus: GoalDraftingFocus;
	originalTopic: string;
	startedAt: number;
}


// ---------- summaries ----------

function usageLines(goal: GoalRecord): string[] {
	return [
		`Time spent: ${formatDuration(goal.usage.activeSeconds)}`,
		`Tokens used: ${formatTokenValue(goal.usage.tokensUsed)}`,
		`Cost: ${formatCostValue(goal.usage.costUsed)}`,
	];
}

function detailedSummary(goal: GoalRecord | null): string {
	if (!goal) return "No goal is set. Use /goals <topic> or /sisyphus <topic> to discuss, or /goals-set <objective> / /sisyphus-set <objective> to start immediately.";
	const lines = [
		`Goal: ${goal.objective}`,
		`Status: ${statusLabel(goal)}`,
		`Auto-continue: ${goal.autoContinue ? "on" : "off"}`,
		...usageLines(goal),
	];
	if (goal.sisyphus) {
		lines.push("Mode: Sisyphus (prompt/criteria variant; shared goal lifecycle)");
	}
	if (goal.activePath) lines.push(`File: ${goal.activePath}`);
	if (goal.archivedPath) lines.push(`Archive: ${goal.archivedPath}`);
	if (goal.stopReason) lines.push(`Stop reason: ${goal.stopReason}`);
	if (goal.pauseReason) {
		const { label, text } = pauseReasonLabel(goal.pauseReason);
		lines.push(`${label}: ${text}`);
	}
	if (goal.pauseSuggestedAction) lines.push(`Agent suggests: ${goal.pauseSuggestedAction}`);
	if (goal.userNote) lines.push(`User note: ${truncateText(goal.userNote, 80)}`);
	return lines.join("\n");
}


// ---------- entry / render helpers ----------

function goalDetails(goal: GoalRecord | null, kind?: GoalResultKind): GoalStateEntry {
	// B3: kind is optional — persisted entries from older versions have none
	// and render via the legacy prefix fallback. Adding a field is additive;
	// version stays 3 (frozen entry shape, invariant 7).
	return { version: 3, ...(kind ? { kind } : {}), goal: goal ? cloneGoal(goal) : null };
}


function extractGoalIdFromInjectedMessage(text: string): string | null {
	// Drafting messages (new goal, sisyphus, or tweak) have no continuation goalId and
	// must never be treated as stale-continuation triggers.
	if (/^\[GOAL (?:DRAFTING|TWEAK DRAFTING)\b/.test(text)) return null;
	// Phase 5 C1: structured outer marker `<pi_goal_continuation goal_id="..." kind="...">`.
	// Borrowed from pi-codex-goal. More robust than bare bracket text because
	// the angle brackets + attributes are nearly impossible for users to type
	// by accident, and the structure is grep-able / parse-able by external tooling.
	const xmlMatch = text.match(/^<pi_goal_continuation\s+goal_id=\"([^\"]+)\"/);
	if (xmlMatch) return xmlMatch[1] ?? null;
	const match = text.match(/^\[(?:GOAL CHECKPOINT|GOAL CONTINUATION|GOAL STALE) goalId=([^\]\s]+)\]/);
	return match?.[1] ?? null;
}

function goalEventMessageId(message: { customType?: string; details?: unknown; content?: unknown }): string | null {
	if (message.customType !== GOAL_EVENT_ENTRY) return null;
	const details = asRecord(message.details);
	// Drafting messages never correspond to a real goal id; they must not be staleness-checked.
	if (details?.kind === "drafting") return null;
	const goalId = details && typeof details.goalId === "string" ? details.goalId : null;
	if (goalId) return goalId;
	return typeof message.content === "string" ? extractGoalIdFromInjectedMessage(message.content) : null;
}

function isAbortedAssistantMessage(message: unknown): boolean {
	const raw = asRecord(message);
	return raw?.role === "assistant" && raw.stopReason === "aborted";
}

function isToolUseAssistantMessage(message: unknown): boolean {
	const raw = asRecord(message);
	return raw?.role === "assistant" && raw.stopReason === "toolUse";
}

function hasAbortedAssistantMessage(messages: unknown[]): boolean {
	return messages.some(isAbortedAssistantMessage);
}

function usageChannelTokens(value: unknown): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return 0;
	return Math.max(0, Math.trunc(value));
}

/**
 * Sum ALL FOUR usage channels of the message's single API request.
 * Cache-inclusive accounting (DEVIATIONS #69, 2026-10-01): with prompt
 * caching the non-cached `input` is a tiny fraction of real processing, so
 * `cacheRead`/`cacheWrite` must count too — otherwise tokensUsed reads as
 * ~10× under the provider-reported total.
 */
function assistantTurnTokens(message: unknown): number {
	const raw = asRecord(message);
	if (!raw || raw.role !== "assistant") return 0;
	const usage = asRecord(raw.usage);
	if (!usage) return 0;
	return (
		usageChannelTokens(usage.input) +
		usageChannelTokens(usage.output) +
		usageChannelTokens(usage.cacheRead) +
		usageChannelTokens(usage.cacheWrite)
	);
}

/** Provider-reported USD cost of a usage object (usage.cost.total).
 * Missing cost objects read as 0 — tokens still count. */
function usageCostTotal(usage: Record<string, unknown>): number {
	const cost = asRecord(usage.cost);
	const total = cost ? cost.total : undefined;
	if (typeof total !== "number" || !Number.isFinite(total)) return 0;
	return Math.max(0, total);
}

/** USD cost of an assistant message's single API request. */
function assistantTurnCost(message: unknown): number {
	const raw = asRecord(message);
	if (!raw || raw.role !== "assistant") return 0;
	const usage = asRecord(raw.usage);
	if (!usage) return 0;
	return usageCostTotal(usage);
}

/** Four-channel token sum + cost of a tool_result event's reported usage
 * ("usage from the tool execution itself": subagent runs, codemode
 * models.classify/generateImages, future LLM-backed tools). Tools that
 * report no usage contribute nothing. */
function toolExecutionUsage(event: unknown): { tokens: number; cost: number } | null {
	const raw = asRecord(event);
	if (!raw) return null;
	const usage = asRecord(raw.usage);
	if (!usage) return null;
	const tokens =
		usageChannelTokens(usage.input) +
		usageChannelTokens(usage.output) +
		usageChannelTokens(usage.cacheRead) +
		usageChannelTokens(usage.cacheWrite);
	const cost = usageCostTotal(usage);
	if (tokens === 0 && cost === 0) return null;
	return { tokens, cost };
}

function isMeaningfulProgressToolCall(toolName: string, args: unknown): boolean {
	if (!GOAL_PROGRESS_TOOL_SET.has(toolName)) return false;
		if (toolName === "read") {
			const path = asRecord(args)?.path;
			if (typeof path === "string" && (path === ".pi/goals" || path.startsWith(".pi/goals/"))) return false;
		}
		if (toolName === "bash") {
			const command = asRecord(args)?.command;
			if (typeof command === "string" && /^\s*echo\b/.test(command)) return false;
		}
	return true;
}

// ---------- extension entry point ----------

export default function goalExtension(pi: ExtensionAPI, deps: { now?: () => number } = {}): void {
	let goalsById = new Map<string, GoalRecord>();
	let focusedGoalId: string | null = null;
	// B3: the three session-local singletons live INSIDE the factory now —
	// the module previously kept them at file scope, which made the real
	// interface of goalExtension() larger than its signature and leaked state
	// across factory invocations (test isolation).
	// When non-null, /goal-tweak drafting is in progress for this goal id and
	// the agent is allowed to call apply_goal_tweak. Cleared after the tweak
	// is applied or when a user-driven turn arrives without a follow-through
	// (schema-level affordance gate against "tweaking" via arbitrary writes).
	let tweakDraftingFor: string | null = null;
	// Approved-audit message held until the finishing turn ends, so "Goal
	// achieved" lands after the model's closing summary (transcript bottom).
	let confirmationIntent: GoalConfirmationIntent | null = null;
	// B7 step 3: the approved-audit hold lives in the audit domain module.
	const pendingAchievement = createPendingAchievementSlot();
	const state = {
		get goal(): GoalRecord | null {
			return focusedGoalFromPool(goalsById, focusedGoalId);
		},
		set goal(next: GoalRecord | null) {
			if (next) {
				goalsById.set(next.id, next);
				focusedGoalId = next.id;
				return;
			}
			if (focusedGoalId) goalsById.delete(focusedGoalId);
			focusedGoalId = null;
		},
	};
	// DC4b part-3: the presentation half lives in ./ui.ts — closed-over
	// business state enters as getters, so the state machine stays fakeable.
	const goalUi = createGoalUi({
		getDisplayGoal: () => goalForDisplay() ?? state.goal,
		getOpenGoalCount: () => openGoals().length,
		getOtherOpenGoalCount: () => otherOpenGoalCount(goalsById, focusedGoalId),
		isGoalActive: () => state.goal?.status === "active",
		shouldPauseOnEscape: () => state.goal?.status === "active" && !!state.goal.autoContinue,
		// INTERRUPT SAFETY (fix): Escape only pauses while the agent is idle;
		// while busy it belongs to the interrupt path and passes through.
		isAgentIdle: (ctx) => {
			try {
				return ctx.isIdle() && !ctx.hasPendingMessages();
			} catch {
				// probe failure = treat as busy: never claim Escape then
				return false;
			}
		},
		pauseActiveGoal,
	});
	let runningGoalId: string | null = null;


	// Per-turn flags reset in turn_start (#4, C9 fix).
	// goalWorkToolCalledThisTurn: tracks whether a real goal-work tool was called.
	//   If false at turn_end, we don't queue another autoContinue (empty chat turn).
	// turnStoppedFor: set by pause_goal / update_goal(complete) / apply_goal_tweak
	//   after their successful execute. Once set, pi.on("tool_call") blocks all
	//   subsequent in-turn tool calls except POST_STOP_ALLOWED_TOOLS. This is the
	//   schema fix for "agent keeps writing files after pause_goal".
	let goalWorkToolCalledThisTurn = false;
	let turnStoppedFor: string | null = null;

	// #5 post-compaction resync: when a compaction just happened, the next agent
	// turn gets an extra reminder block. Set in session_compact, consumed
	// (cleared) in before_agent_start.
	let postCompactReminderPending = false;

	// AR1005-GO-A: the activity clock owns the segment start and per-goal
	// millisecond remainders (sub-second fragments are no longer lost per
	// settle). Injectable clock seam for tests; production is monotonic.
	const clock = createGoalAccounting({ now: deps.now });

	const draftingHiddenWorkTools = [
		"bash",
		"read",
		"write",
		"edit",
		"grep",
		"find",
		"ls",
		SISYPHUS_STEP_TOOL_NAME,
		TWEAK_APPLY_TOOL_NAME,
		CREATE_GOAL_TOOL_NAME,
	] as const;
	const goalExecutionWorkTools = ["read", "bash", "edit", "write"] as const;

	function syncGoalTools(): void {
		try {
			const active = new Set(pi.getActiveTools());
			for (const name of goalExecutionWorkTools) active.add(name);
			active.delete(QUESTION_TOOL_NAME);
			active.delete(QUESTIONNAIRE_TOOL_NAME);
			for (const name of ACTIVE_GOAL_TOOL_NAMES) active.delete(name);
			const phase = confirmationIntent !== null ? "drafting" : tweakDraftingFor !== null ? "tweakDrafting" : "normal";
			const lifecycleTools = lifecycleToolNamesForGoalStatus(state.goal?.status, phase);
			for (const name of lifecycleTools) active.add(name);
			// Sisyphus is now a prompt/criteria style, not a separate step-counter
			// mechanism. Keep step_complete registered for legacy transcripts, but do
			// not expose it as an active work tool.
			active.delete(SISYPHUS_STEP_TOOL_NAME);
			// apply_goal_tweak is only available during a /goal-tweak drafting flow.
			// Note: tweak drafting can run against active OR paused goals.
			if (state.goal && tweakDraftingFor === state.goal.id) {
				active.add(TWEAK_APPLY_TOOL_NAME);
				active.add(QUESTION_TOOL_NAME);
				active.add(QUESTIONNAIRE_TOOL_NAME);
			} else {
				active.delete(TWEAK_APPLY_TOOL_NAME);
			}
			// Keep the commit tool available and let its validator enforce that a
			// drafting flow is active. This avoids fragile hidden-tool drift after
			// question turns, compaction, or active-tool resync.
			active.add(PROPOSE_DRAFT_TOOL_NAME);
			// create_goal stays hidden — hard invariant: user must confirm via propose_goal_draft.
			active.delete(CREATE_GOAL_TOOL_NAME);
			if (confirmationIntent !== null) {
				active.add(QUESTION_TOOL_NAME);
				active.add(QUESTIONNAIRE_TOOL_NAME);
			} else if (state.goal?.status === "active") {
				for (const name of goalExecutionWorkTools) active.add(name);
			}
			pi.setActiveTools(Array.from(active));
		} catch {}
	}

	// goal-notes: one-shot note attached via /goal-resume <text>; rides the
	// FIRST checkpoint after resume, then consumed. In-memory by design —
	// one-shot semantics must never survive a restart as stale guidance.
	let pendingResumeNote: string | null = null;

	// B7 step 1: the continuation loop lives in goal-continuation.ts (no pi
	// events — probe + emit seams injected). The three wrappers below keep
	// every call site in this file unchanged.
	const continuationLoop = createContinuationLoop({
		getGoal: () => state.goal,
		isDrafting: () => confirmationIntent !== null || tweakDraftingFor !== null,
		isSubagentChild: isSubagentChildProcess,
		promptFor: (goal) => continuationPrompt(goal, pendingResumeNote ?? undefined),
		sendFollowUp: (prompt, goal) => {
			pi.sendMessage<GoalEventDetails>(
				{
					customType: GOAL_EVENT_ENTRY,
					content: prompt,
					display: false,
					details: {
						kind: "checkpoint",
						goalId: goal.id,
						status: goal.status,
						objective: goal.objective,
						timestamp: Date.now(),
					},
				},
				{ triggerTurn: true, deliverAs: "followUp" },
			);
			// one-shot consumption: the note rode THIS checkpoint (goal-notes)
			pendingResumeNote = null;
		},
		onDispatch: syncGoalTools,
	});

	function clearContinuationTimer(): void {
		continuationLoop.stopTimer();
	}

	function clearContinuationState(): void {
		continuationLoop.halt();
	}

	function clearActiveAccounting(): void {
		clock.pause(); // segment dropped; per-goal carries are kept for resume
	}

	function clearStoppedRuntimeState(): void {
		clearContinuationState();
		clearActiveAccounting();
	}


	const activeGetGoalTurnsByGoalId = new Map<string, number>();

	function resetGetGoalNudgeState(goalId: string | null | undefined): void {
		if (goalId) {
			activeGetGoalTurnsByGoalId.delete(goalId);
		}
	}

	function openGoals(): GoalRecord[] {
		return openGoalsFromPool(goalsById);
	}

	function reconcileFocusedGoalFromDisk(ctx: ExtensionContext, opts: { preserveMemoryUsage?: boolean } = {}): boolean {
		// GH-02 (continued): children never reconcile from the project's disk
		// pool. loadState covers session_start; this closes the mid-session
		// command/tool paths (goal-list, tweak drafting, …) that would otherwise
		// re-adopt the pool a dispatch task could then focus into state.goal.
		if (isSubagentChildProcess()) return true;
		const current = state.goal;
		const fresh = readActiveGoalPool(ctx);
		if (!focusedGoalId) {
			goalsById = fresh;
			return true;
		}
		const diskGoal = fresh.get(focusedGoalId) ?? null;
		if (!diskGoal) {
			if (current && !current.activePath) {
				goalsById = fresh;
				goalsById.set(current.id, current);
				focusedGoalId = current.id;
				return true;
			}
			goalsById = fresh;
			focusedGoalId = null;
			clearStoppedRuntimeState();
			if (current) resetGetGoalNudgeState(current.id);
			if (tweakDraftingFor !== null) tweakDraftingFor = null;
			syncGoalTools();
			updateUI(ctx);
			return false;
		}
		const reconciled = current && opts.preserveMemoryUsage
			? mergeFocusedGoalWithDisk({ memoryGoal: current, diskGoal })
			: diskGoal;
		goalsById = fresh;
		goalsById.set(reconciled.id, reconciled);
		focusedGoalId = reconciled.id;
		if (reconciled.status !== "active" || !reconciled.autoContinue) clearContinuationState();
		if (reconciled.status !== "active") clearActiveAccounting();
		return true;
	}

	function appendFocusEntry(goalId: string | null, reason: GoalFocusReason): void {
		pi.appendEntry(FOCUS_ENTRY, goalFocusDetails(goalId, reason));
	}

	function setFocusedGoalId(goalId: string | null, ctx: ExtensionContext, reason: GoalFocusReason): void {
		const previousGoalId = focusedGoalId;
		focusedGoalId = goalId && goalsById.has(goalId) ? goalId : null;
		if (previousGoalId !== focusedGoalId) {
			clearContinuationState();
			clearActiveAccounting();
			resetGetGoalNudgeState(previousGoalId);
			resetGetGoalNudgeState(focusedGoalId);
			if (tweakDraftingFor !== null && tweakDraftingFor !== focusedGoalId) tweakDraftingFor = null;
		}
		appendFocusEntry(focusedGoalId, reason);
		// Append ledger event for focus changes
		try {
			if (focusedGoalId) {
				appendGoalEvent(ctx, { type: "goal_focused", goalId: focusedGoalId, reason, at: nowIso() });
			} else if (previousGoalId) {
				appendGoalEvent(ctx, { type: "goal_unfocused", reason, at: nowIso() });
			}
		} catch {
			// Ledger append failure should not crash focus change
		}
		syncGoalTools();
		updateUI(ctx);
	}

	function updateFocusedGoal(next: GoalRecord, ctx: ExtensionContext, shouldPersist = true): void {
		const previousGoalId = focusedGoalId;
		goalsById.set(next.id, next);
		focusedGoalId = next.id;
		if (previousGoalId !== focusedGoalId) {
			resetGetGoalNudgeState(previousGoalId);
			resetGetGoalNudgeState(focusedGoalId);
		}
		if (shouldPersist) persist(ctx);
		else syncGoalTools();
		updateUI(ctx);
	}

	function armFocusedContinuation(ctx: ExtensionContext): void {
		beginAccounting();
		if (state.goal?.status === "active" && state.goal.autoContinue) queueContinuation(ctx, true);
	}

	function removeFocusedGoal(ctx: ExtensionContext, reason: GoalFocusReason): void {
		const previousGoalId = focusedGoalId;
		if (focusedGoalId) goalsById.delete(focusedGoalId);
		focusedGoalId = null;
		clearStoppedRuntimeState();
		resetGetGoalNudgeState(previousGoalId);
		appendFocusEntry(null, reason);
		syncGoalTools();
		updateUI(ctx);
	}

	function beginAccounting(): void {
		if (confirmationIntent !== null || tweakDraftingFor !== null) {
			clearActiveAccounting();
			return;
		}
		if (!state.goal || (state.goal.status !== "active")) {
			clearActiveAccounting();
			return;
		}
		// GO-A: begin starts a NEW segment (resets the segment start) without
		// deleting this goal's accumulated carry.
		clock.begin(state.goal.id);
	}

	function goalForDisplay(): GoalRecord | null {
		if (!state.goal || state.goal.status !== "active") {
			return state.goal;
		}
		// GO-A: read-only preview (segment + carry) — repeated renders never
		// consume or accumulate seconds.
		const liveSeconds = clock.preview(state.goal.id);
		if (liveSeconds === 0) return state.goal;
		const live = cloneGoal(state.goal);
		live.usage.activeSeconds += liveSeconds;
		return live;
	}

	/** Accounted progress: parent assistant requests (turn_end) plus
	 * tool_result-reported execution usage (subagents, codemode model calls).
	 * Accepted residuals, verified 2026-10-03 by transcript forensics: a ~1%
	 * event-timing gap between turn_end accounting and session-recorded usage
	 * (74,482 of 6.55M on the pi-1.0 goal), and any consumption after the
	 * goal archives (auditor runs, post-completion turns). Neither is fixed. */
	function accountProgress(ctx: ExtensionContext, opts: { completedTurnTokens?: number; completedTurnCost?: number } = {}): void {
		if (confirmationIntent !== null || tweakDraftingFor !== null) {
			clearActiveAccounting();
			return;
		}
		if (state.goal?.activePath && !reconcileFocusedGoalFromDisk(ctx, { preserveMemoryUsage: true })) return;
		if (!state.goal || state.goal.status !== "active") {
			beginAccounting();
			return;
		}
		// GO-A: settle closes the segment delta and re-arms it; the sub-second
		// remainder stays as the goal's carry (never reset, even on
		// zero-token/zero-cost events). null = no active segment, begin one.
		const settled = clock.settle(state.goal.id);
		if (settled === null) {
			beginAccounting();
			return;
		}
		const elapsedSeconds = settled;

		const tokens = Math.max(0, Math.trunc(opts.completedTurnTokens ?? 0));
		const cost = Math.max(0, opts.completedTurnCost ?? 0);
		if (tokens === 0 && cost === 0 && elapsedSeconds === 0) return;

		const next = cloneGoal(state.goal);
		next.usage.tokensUsed += tokens;
		next.usage.costUsed += cost;
		next.usage.activeSeconds += elapsedSeconds;
		next.updatedAt = nowIso();
		state.goal = next;
		persist(ctx);
	}

	function syncGoalPromptFromDisk(ctx: ExtensionContext): boolean {
		if (!state.goal || state.goal.status === "complete") return false;
		const previousObjective = state.goal.objective;
		state.goal = mergeGoalPromptFromDisk(ctx, state.goal);
		return state.goal.objective !== previousObjective;
	}

	function persist(ctx?: ExtensionContext): void {
		const current = state.goal;
		if (current) {
			state.goal = { ...current, updatedAt: nowIso() };
			if (ctx) {
				syncGoalPromptFromDisk(ctx);
				const next = state.goal;
				if (next) state.goal = next.status === "complete" ? archiveGoalFile(ctx, next) : writeActiveGoalFile(ctx, next);
			}
		}
		pi.appendEntry(STATE_ENTRY, goalDetails(state.goal));
		syncGoalTools();
		if (ctx) updateUI(ctx);
	}

	function refreshGoalDisplayFromDisk(ctx: ExtensionContext): void {
		if (!state.goal || state.goal.status === "complete") return;
		if (syncGoalPromptFromDisk(ctx)) {
			state.goal = { ...state.goal, updatedAt: nowIso() };
			pi.appendEntry(STATE_ENTRY, goalDetails(state.goal));
		}
		syncGoalTools();
		updateUI(ctx);
	}

	/**
	 * Live above-editor widget for the active goal. Inspired by rpiv-todo's
	 * TodoOverlay: register the widget once with a factory, read live state
	 * via the closure at render time, and call `tui.requestRender()` on every
	 * state change so the overlay refreshes without re-registration.
	 *
	 * Layout (sisyphus, running):
	 *   ◆ Sisyphus  [▰▰▰▱▱] 3/5
	 *   ├─ ⟡ extract validator … wire it … update tests.
	 *   ├─ Status: sisyphus running · auto-continue · 14m 21s · 24.3k tokens
	 *   └─ .pi/goals/active_goal_xxx.md
	 *
	 * Layout (paused with blocker):
	 *   ⊘ Goal paused
	 *   ├─ ⟡ improve benchmark coverage for the parser
	 *   ├─ Status: paused (agent) · 2m 14s · 12.4k tokens
	 *   ├─ Blocker: cannot find the tests directory
	 *   └─ Suggested: ask the user for the test location
	 */
	// DC4b: serializable projection of the fields renderGoalWidgetLines
	// consumes — carrying it on the snapshot makes the widget rebuildable
	// by any consumer without closure getters.
	function widgetGoalProjection(goal: NonNullable<ReturnType<typeof goalForDisplay>>): {
		objective: string; status: string; sisyphus: boolean;
		stopReason?: string; pauseReason?: string; pauseSuggestedAction?: string;
		activePath?: string; archivedPath?: string; tokensUsed: number; activeSeconds: number; costUsed: number;
	} {
		return {
			objective: goal.objective,
			status: goal.status,
			sisyphus: goal.sisyphus,
			...(goal.stopReason !== undefined ? { stopReason: goal.stopReason } : {}),
			...(goal.pauseReason !== undefined ? { pauseReason: goal.pauseReason } : {}),
			...(goal.pauseSuggestedAction !== undefined ? { pauseSuggestedAction: goal.pauseSuggestedAction } : {}),
			...(goal.activePath !== undefined ? { activePath: goal.activePath } : {}),
			...(goal.archivedPath !== undefined ? { archivedPath: goal.archivedPath } : {}),
			tokensUsed: goal.usage.tokensUsed,
			activeSeconds: goal.usage.activeSeconds,
			costUsed: goal.usage.costUsed,
		};
	}

	function publishGoalChannel(
		widget?: { focus: "focused" | "unfocused" | "none"; statusLine: string; goal?: ReturnType<typeof widgetGoalProjection>; openGoalCount?: number },
	): void {
		// P2-BUS-01: goal channel on the capability bus (frozen snapshot).
		// DC4/DC4b: the widget field is presentation-complete — focus,
		// status-line text, a serializable goal projection, and the open
		// count, enough to rebuild renderGoalWidgetLines anywhere.
		const goal = state.goal;
		coreBus().publish({
			goal: {
				active: !!goal,
				...(goal ? { paused: goal.status === "paused" } : {}),
				summary: goal ? displayObjectiveTitle(goal.objective) : null,
				...(widget ? { widget } : {}),
			},
		});
	}

	function updateUI(ctx: ExtensionContext): void {
		// bus publish is unconditional per branch (review #10 + DC4): every
		// path below publishes exactly once, now carrying widget state, so
		// headless sessions reach process-external readers the same way.
		if (!ctx.hasUI) {
			// headless: still publish the channel (widget-less, goal facts only)
			publishGoalChannel();
			return;
		}
		const totalOpen = openGoals().length;
		if (!state.goal && totalOpen === 0) {
			publishGoalChannel({ focus: "none", statusLine: "" });
			goalUi.clear(ctx);
			goalUi.stopStatusRefresh();
			return;
		}
		if (!state.goal) {
			publishGoalChannel({ focus: "unfocused", statusLine: `goal: unfocused [${totalOpen} open] - /goal-focus`, openGoalCount: totalOpen });
			ctx.ui.setStatus("goal", `goal: unfocused [${totalOpen} open] - /goal-focus`);
			goalUi.registerWidget(ctx);
			goalUi.stopStatusRefresh();
			return;
		}

		const displayGoal = goalForDisplay() ?? state.goal;
		const otherCount = otherOpenGoalCount(goalsById, focusedGoalId);
		publishGoalChannel({
			focus: "focused",
			statusLine: `${footerStatus(displayGoal)}${otherCount > 0 ? ` (+${otherCount} open)` : ""}`,
			goal: widgetGoalProjection(displayGoal),
			openGoalCount: totalOpen,
		});
		ctx.ui.setStatus("goal", `${footerStatus(displayGoal)}${otherCount > 0 ? ` (+${otherCount} open)` : ""}`);
		goalUi.registerWidget(ctx);

		if (state.goal.status === "complete") {
			goalUi.stopStatusRefresh();
		} else {
			goalUi.syncStatusRefresh(ctx);
		}
	}

	function loadState(ctx: ExtensionContext): void {
		// GH-02 (spec 2026-10-01-goal-hijack-fix): subagent child sessions share
		// the project cwd — and therefore the disk goal pool. Adopting it here
		// arms a continuation timer whose <pi_goal_continuation> message occupies
		// the child's agent loop before the dispatched task prompt can be
		// delivered ("already processing" spawn failures). Children never
		// participate in the goal lifecycle. The session-branch reconciliation
		// below is naturally empty in fresh child sessions and stays as-is.
		const childSession = isSubagentChildProcess();
		goalsById = childSession ? new Map<string, GoalRecord>() : readActiveGoalPool(ctx);
		focusedGoalId = null;
		let focusEntry: GoalFocusEntry | null = null;
		let legacyGoal: GoalRecord | null = null;
		let legacyStateSeen = false;
		const entries = ctx.sessionManager.getBranch();
		for (let i = entries.length - 1; i >= 0; i--) {
			const entry = entries[i] as { type?: string; customType?: string; data?: unknown };
			if (entry.type !== "custom") continue;
			if (!focusEntry && entry.customType === FOCUS_ENTRY) {
				focusEntry = normalizeGoalFocusEntry(entry.data);
			}
			if (!legacyStateSeen && entry.customType === STATE_ENTRY) {
				legacyGoal = normalizeGoalRecord(asRecord(entry.data)?.goal);
				legacyStateSeen = true;
			}
			if (focusEntry && legacyStateSeen) break;
		}
		if (legacyGoal && legacyGoal.status !== "complete") {
			legacyGoal = sanitizeGoalPaths(ctx, mergeGoalPromptFromDisk(ctx, legacyGoal));
		}
		focusedGoalId = resolveSessionFocus({ pool: goalsById, focusEntry, legacyGoal });
		if (!focusEntry && focusedGoalId) {
			try {
				appendFocusEntry(focusedGoalId, legacyGoal?.id === focusedGoalId ? "migrated" : "selected");
			} catch {}
		}
		for (const [id, current] of goalsById) {
			if (current.status === "complete") {
				goalsById.delete(id);
			}
		}
		clearStoppedRuntimeState();
		runningGoalId = null;
		syncGoalTools();
		updateUI(ctx);
	}

	function setGoal(next: GoalRecord | null, ctx: ExtensionContext, shouldPersist = true, focusReason?: GoalFocusReason): void {
		const previousGoalId = state.goal?.id ?? null;
		state.goal = next;
		const focusChanged = previousGoalId !== focusedGoalId;
		if (focusChanged) {
			clearContinuationState();
			clearActiveAccounting();
			resetGetGoalNudgeState(previousGoalId);
			resetGetGoalNudgeState(focusedGoalId);
		}
		if (focusReason && focusChanged) appendFocusEntry(focusedGoalId, focusReason);
		if (!state.goal || (state.goal.status !== "active") || !state.goal.autoContinue) {
			clearContinuationState();
		}
		if (!state.goal || state.goal.status === "paused" || state.goal.status === "complete") {
			clearActiveAccounting();
		}
		// GO-A: a goal that is gone (cleared/aborted) or completed can never
		// consume its sub-second carry again — release it. Paused goals KEEP
		// theirs (resume continues accumulating fragments).
		if (previousGoalId && (!state.goal || state.goal.status === "complete")) {
			clock.forget(previousGoalId);
		}
		if (!state.goal || state.goal.id !== previousGoalId) {
			// Drop any stale tweak-edit-gate that didn't belong to this goal.
			if (tweakDraftingFor !== null && tweakDraftingFor !== state.goal?.id) tweakDraftingFor = null;
		}
		if (shouldPersist) persist(ctx);
		else syncGoalTools();
		updateUI(ctx);
	}

	function archiveCurrentGoal(ctx: ExtensionContext, reason: StopReason | undefined): GoalRecord | null {
		if (!state.goal) return null;
		let archived = mergeGoalPromptFromDisk(ctx, state.goal);
		archived = { ...archived, status: archived.status === "complete" ? "complete" : "paused", stopReason: reason };
		return archiveGoalFile(ctx, archived);
	}

	function stopActiveGoal(status: Exclude<GoalStatus, "active">, reason: StopReason | undefined, ctx: ExtensionContext): void {
		if (!state.goal) return;
		let next = mergeGoalPromptFromDisk(ctx, state.goal);
		next = { ...next, status, stopReason: reason, updatedAt: nowIso() };
		setGoal(next, ctx);
		// Append ledger event for pauses (user or agent initiated)
		if (status === "paused") {
			try {
				appendGoalEvent(ctx, {
					type: "goal_paused",
					goalId: next.id,
					reason: reason ?? "unknown",
					suggestedAction: next.pauseSuggestedAction,
					status,
					at: next.updatedAt,
				});
			} catch {
				// Ledger append failure should not crash pause
			}
		}
	}

	function pauseActiveGoal(ctx: ExtensionContext, note?: string): void {
		if (!state.goal || state.goal.status !== "active") return;
		const pausedGoalId = state.goal.id;
		// User-initiated pause (Esc / aborted turn). Clear any stale AGENT pause
		// reason; a /goal-pause note becomes the user-labeled pause reason
		// (shown to the agent in the paused system prompt, cleared on resume).
		const userNote = note?.trim();
		state.goal = { ...state.goal, autoContinue: false, pauseReason: userNote ? `user: ${userNote}` : undefined, pauseSuggestedAction: undefined };
		stopActiveGoal("paused", "user", ctx);
		resetGetGoalNudgeState(pausedGoalId);
		uiNotify(ctx, userNote ? "Goal paused (note attached)." : "Goal paused.", "info");
	}

	function queueContinuation(ctx: ExtensionContext, force = false): void {
		continuationLoop.queue(ctx, force);
	}

	function replaceGoal(config: GoalCreationConfig, ctx: ExtensionContext, startNow = true): void {
		setGoal(createGoal(config), ctx, true, "created");
		beginAccounting();
		// Reset continuation nudge state — this is a fresh goal.
		resetGetGoalNudgeState(state.goal?.id);
		// A goal was committed — clear pending confirmation intent if any.
		confirmationIntent = null;
		uiNotify(ctx, buildGoalRunningNotification(config), "info");
		if (startNow && state.goal?.autoContinue) queueContinuation(ctx, true);
		// Append ledger event for durable history
		const created = state.goal;
		if (created) {
			try {
				appendGoalEvent(ctx, {
					type: "goal_created",
					goalId: created.id,
					objective: created.objective,
					sisyphus: created.sisyphus,
					autoContinue: created.autoContinue,
					at: created.createdAt,
				});
			} catch {
				// Ledger append failure should not crash creation
			}
		}
	}

	async function startGoalTweakDrafting(hint: string, ctx: ExtensionContext): Promise<void> {
		reconcileFocusedGoalFromDisk(ctx);
		clearContinuationState();
		clearActiveAccounting();
		if (!state.goal) {
			if (openGoals().length > 0) {
				const selected = await chooseOpenGoal(ctx, "Tweak which open goal?");
				if (!selected) return;
			} else {
				uiNotify(ctx, "No goal is set. Use /goals or /sisyphus to discuss, or /goals-set / /sisyphus-set to start immediately.", "warning");
				return;
			}
		}
		const currentGoal = state.goal;
		if (!currentGoal) return;
		if (currentGoal.status === "complete") {
			uiNotify(ctx, "Goal is complete. Use /goals to discuss a new one or /goals-set to start immediately.", "warning");
			return;
		}
		syncGoalPromptFromDisk(ctx);
		persist(ctx);
		const trimmed = hint.trim();
		const focused = state.goal;
		if (!focused) return;
		const sisyphusOn = focused.sisyphus;
		const label = sisyphusOn ? "Sisyphus tweak drafting" : "Goal tweak drafting";
		// Activate the tweak edit-gate so apply_goal_tweak is callable.
		tweakDraftingFor = focused.id;
		syncGoalTools();
		uiNotify(ctx, 
			`${label} started${trimmed ? `: ${truncateText(trimmed, 60)}` : ""}. The agent will interview you and then call apply_goal_tweak.`,
			"info",
		);
		const draftId = `tweak-${focused.id}-${Date.now().toString(36)}`;
		try {
			pi.sendMessage<GoalEventDetails>(
				{
					customType: GOAL_EVENT_ENTRY,
					content: goalTweakDraftingPrompt(focused, trimmed),
					display: false,
					details: {
						kind: "drafting",
						goalId: draftId,
						objective: trimmed,
						focus: sisyphusOn ? "sisyphus" : "goal",
						timestamp: Date.now(),
					},
				},
				{ triggerTurn: true, deliverAs: ctx.isIdle() ? "followUp" : "steer" },
			);
		} catch (err) {
			tweakDraftingFor = null;
			syncGoalTools();
			uiNotify(ctx, `Could not start goal tweak: ${(err as Error).message}`, "error");
		}
	}

	function startGoalDrafting(topic: string, focus: DraftingFocus, ctx: ExtensionContext): void {
		clearContinuationState();
		clearActiveAccounting();
		const trimmed = topic.trim();
		const label = focus === "sisyphus" ? "Sisyphus intent discussion" : "Goal intent discussion";
		const hint = focus === "sisyphus"
			? "The agent will research or grill the ordered plan as needed, then propose a draft for you to Confirm. No skipping, no rushing."
			: "The agent will clarify, research, or grill assumptions as needed, then propose a draft for you to Confirm.";
		uiNotify(ctx, 
			`${label} started${trimmed ? `: ${truncateText(trimmed, 60)}` : ""}. ${hint}`,
			"info",
		);

		confirmationIntent = {
			focus,
			originalTopic: trimmed,
			startedAt: Date.now(),
		};
		syncGoalTools();
		try {
			// Custom message keeps the full drafting prompt as LLM-visible user
			// content while the TUI renders a compact "Goal <topic>" line.
			pi.sendMessage<GoalEventDetails>(
				{
					customType: GOAL_EVENT_ENTRY,
					content: goalDraftingPrompt(trimmed, focus),
					display: true,
					details: {
						kind: "drafting",
						goalId: `draft-${Date.now().toString(36)}`,
						objective: trimmed || undefined,
						focus,
						timestamp: Date.now(),
					},
				},
				{ triggerTurn: true, deliverAs: ctx.isIdle() ? "followUp" : "steer" },
			);
		} catch (err) {
			uiNotify(ctx, `Could not start ${label.toLowerCase()}: ${(err as Error).message}`, "error");
		}
	}

	async function chooseOpenGoal(ctx: ExtensionContext, title: string): Promise<GoalRecord | null> {
		reconcileFocusedGoalFromDisk(ctx);
		if (state.goal && state.goal.status !== "complete") return state.goal;
		const open = openGoals();
		if (open.length === 0) return null;
		if (open.length === 1) {
			const only = open[0];
			if (!only) return null;
			setFocusedGoalId(only.id, ctx, "selected");
			return state.goal;
		}
		if (!ctx.hasUI) {
			uiNotify(ctx, buildUnfocusedOpenGoalsSummary(open.length), "warning");
			return null;
		}
		const labels = open.map((item) => goalSelectorLabel(item, focusedGoalId));
		const byLabel = new Map(labels.map((label, index) => [label, open[index]?.id]));
		const selected = await ctx.ui.select(title, labels);
		const selectedId = selected ? byLabel.get(selected) : undefined;
		if (!selectedId) {
			uiNotify(ctx, "Goal focus unchanged.", "info");
			return null;
		}
		setFocusedGoalId(selectedId, ctx, "selected");
		return state.goal;
	}

	async function focusGoalCommand(ctx: ExtensionContext): Promise<void> {
		const open = openGoals();
		if (open.length === 0) {
			uiNotify(ctx, "No open goals. Use /goals or /sisyphus to discuss, or /goals-set / /sisyphus-set to start immediately.", "warning");
			return;
		}
		if (open.length === 1) {
			const only = open[0];
			if (!only) return;
			setFocusedGoalId(only.id, ctx, "selected");
			armFocusedContinuation(ctx);
			uiNotify(ctx, `Focused goal: ${oneLineSummary(only)}`, "info");
			return;
		}
		if (!ctx.hasUI) {
			uiNotify(ctx, buildGoalListText(goalsById, focusedGoalId), "info");
			return;
		}
		const labels = open.map((item) => goalSelectorLabel(item, focusedGoalId));
		const byLabel = new Map(labels.map((label, index) => [label, open[index]?.id]));
		const selected = await ctx.ui.select("Focus open goal", labels);
		const selectedId = selected ? byLabel.get(selected) : undefined;
		if (!selectedId) {
			uiNotify(ctx, "Goal focus unchanged.", "info");
			return;
		}
		setFocusedGoalId(selectedId, ctx, "selected");
		armFocusedContinuation(ctx);
		uiNotify(ctx, `Focused goal: ${oneLineSummary(state.goal)}`, "info");
	}

	async function handleGoalCommandTopic(rawTopic: string, ctx: ExtensionContext, focus: DraftingFocus, opts: { replace: boolean }): Promise<void> {
		const topic = rawTopic.trim();
		if (opts.replace) {
			const replacementTarget = await chooseOpenGoal(ctx, "Replace which open goal?");
			if (openGoals().length > 0 && !replacementTarget) return;
			archiveCurrentGoal(ctx, "user");
			setGoal(null, ctx, true, "cleared");
		}
		startGoalDrafting(topic, focus, ctx);
	}

	function handleDirectGoalSet(rawObjective: string, ctx: ExtensionContext, focus: DraftingFocus): void {
		const objective = rawObjective.trim();
		if (!objective) {
			const command = focus === "sisyphus" ? "/sisyphus-set" : "/goals-set";
			uiNotify(ctx, `No objective provided. Use ${command} <objective>.`, "warning");
			return;
		}
		clearContinuationState();
		clearActiveAccounting();
		confirmationIntent = null;
		syncGoalTools();
		replaceGoal({ objective, autoContinue: true, sisyphus: focus === "sisyphus" }, ctx, true);
	}

	async function showGoalStatus(ctx: ExtensionContext): Promise<void> {
		reconcileFocusedGoalFromDisk(ctx);
		if (state.goal) syncGoalPromptFromDisk(ctx);
		const view = goalForDisplay() ?? state.goal;
		const otherCount = otherOpenGoalCount(goalsById, focusedGoalId);
		const extra = view && otherCount > 0 ? `\nOther open goals: ${otherCount} (run /goal-list or /goal-focus)` : "";
		const text = view ? `${detailedSummary(view)}${extra}` : openGoals().length > 0 ? buildUnfocusedOpenGoalsSummary(openGoals().length) : detailedSummary(null);
		uiNotify(ctx, text, "info");
		updateUI(ctx);
	}

	async function handleGoalPause(ctx: ExtensionContext, rawNote?: string): Promise<void> {
		reconcileFocusedGoalFromDisk(ctx);
		if (!state.goal) {
			if (openGoals().length > 0) {
				const selected = await chooseOpenGoal(ctx, "Pause which open goal?");
				if (!selected) return;
			} else {
				uiNotify(ctx, "No goal is set.", "warning");
				return;
			}
		}
		const currentGoal = state.goal;
		if (!currentGoal) return;
		if (currentGoal.status === "complete") {
			uiNotify(ctx, "Goal is complete.", "warning");
			return;
		}
		if (currentGoal.status === "paused") {
			uiNotify(ctx, "Goal is already paused. Use /goal-resume to continue.", "info");
			return;
		}
		pauseActiveGoal(ctx, rawNote);
	}

	async function handleGoalResume(ctx: ExtensionContext, rawNote?: string): Promise<void> {
		reconcileFocusedGoalFromDisk(ctx);
		if (!state.goal && openGoals().length > 0) {
			const selected = await chooseOpenGoal(ctx, "Resume or focus open goal");
			if (!selected) return;
			if (selected.status === "active") {
				armFocusedContinuation(ctx);
				uiNotify(ctx, `Goal focused: ${oneLineSummary(selected)}`, "info");
				return;
			}
		}
		const resumeGate = validateResumeGoal(state.goal);
		if (!resumeGate.ok) {
			const level = resumeGate.message.includes("already running") ? "info" : "warning";
			uiNotify(ctx, resumeGate.message, level);
			return;
		}
		if (!state.goal) throw new Error("Goal disappeared during resume validation.");
		setGoal(
			{
				...mergeGoalPromptFromDisk(ctx, state.goal),
				status: "active",
				autoContinue: true,
				stopReason: undefined,
				pauseReason: undefined,
				pauseSuggestedAction: undefined,
			},
			ctx,
		);
		beginAccounting();
		resetGetGoalNudgeState(state.goal.id);
		const note = rawNote?.trim() || null;
		pendingResumeNote = note;
		uiNotify(ctx, note ? "Goal resumed (note attached to the next checkpoint)." : "Goal resumed.", "info");
		queueContinuation(ctx, true);
		// Append ledger event for resumption
		try {
			appendGoalEvent(ctx, {
				type: "goal_resumed",
				goalId: state.goal.id,
				reason: "user",
				at: nowIso(),
			});
		} catch {
			// Ledger append failure should not crash resume
		}
	}

	function auditorConfigValue(config: GoalAuditorConfig, key: keyof GoalAuditorConfig): string {
		const value = config[key];
		return value === undefined ? "(default)" : String(value);
	}

	function auditorSettingsLines(config: GoalAuditorConfig): string[] {
		return [
			`provider: ${auditorConfigValue(config, "provider")}`,
			`model: ${auditorConfigValue(config, "model")}`,
			`thinking_level: ${auditorConfigValue(config, "thinkingLevel")}`,
			`audit_timeout_ms: ${auditorConfigValue(config, "auditTimeoutMs")}`,
		];
	}

	async function handleGoalAuditorSettings(ctx: ExtensionContext): Promise<void> {
		if (!ctx.hasUI) {
			uiNotify(ctx, `Goal auditor settings file: ${goalAuditorConfigPath(ctx.cwd)}`, "info");
			return;
		}
		const fieldLabels = ["provider", "model", "thinking_level"] as const;
		while (true) {
			const config = loadGoalAuditorFileConfig(ctx.cwd);
			const options = [
				`provider: ${auditorConfigValue(config, "provider")}`,
				`model: ${auditorConfigValue(config, "model")}`,
				`thinking_level: ${auditorConfigValue(config, "thinkingLevel")}`,
			];
			const selected = await ctx.ui.select("Goal auditor settings", options);
			if (!selected) return;
			const index = options.indexOf(selected);
			const field = fieldLabels[index];
			if (!field) return;
			const key = field === "thinking_level" ? "thinkingLevel" : field;
			const currentValue = auditorConfigValue(config, key);
			const input = await ctx.ui.input(`Set auditor ${field}`, currentValue === "(default)" ? "Leave empty for default" : currentValue);
			if (input === undefined) continue;
			const next: GoalAuditorConfig = { ...config };
			const trimmed = input.trim();
			if (!trimmed) {
				delete next[key];
			} else if (key === "thinkingLevel") {
				if (!["off", "minimal", "low", "medium", "high", "xhigh"].includes(trimmed)) {
					uiNotify(ctx, "thinking_level must be one of: off, minimal, low, medium, high, xhigh", "warning");
					continue;
				}
				next.thinkingLevel = trimmed as GoalAuditorConfig["thinkingLevel"];
			} else {
				next[key] = trimmed;
			}
			saveGoalAuditorFileConfig(ctx.cwd, next);
			uiNotify(ctx, `Goal auditor settings saved:\n${auditorSettingsLines(loadGoalAuditorFileConfig(ctx.cwd)).join("\n")}`, "info");
		}
	}

	async function handleGoalSettings(ctx: ExtensionContext): Promise<void> {
		if (!ctx.hasUI) {
			uiNotify(ctx, `Goal settings require UI. Auditor config file: ${goalAuditorConfigPath(ctx.cwd)}`, "warning");
			return;
		}
		const selected = await ctx.ui.select("Goal settings", ["auditor"]);
		if (selected === "auditor") await handleGoalAuditorSettings(ctx);
	}

	async function handleGoalClear(ctx: ExtensionContext, rawNote?: string): Promise<void> {
		if (confirmationIntent !== null || tweakDraftingFor !== null) {
			confirmationIntent = null;
			tweakDraftingFor = null;
			syncGoalTools();
			updateUI(ctx);
			uiNotify(ctx, clearGoalCommandMessage({ archived: false, wasDrafting: true }), "info");
			return;
		}
		reconcileFocusedGoalFromDisk(ctx);
		if (!state.goal && openGoals().length > 0) {
			const selected = await chooseOpenGoal(ctx, "Clear which open goal?");
			if (!selected) return;
		}
		const archived = archiveCurrentGoal(ctx, "user");
		const didArchive = !!archived;
		appendUserTerminationEvent(ctx, "cleared", archived, rawNote);
		resetGetGoalNudgeState(state.goal?.id);
		setGoal(null, ctx, true, "cleared");
		// Phase 5 D: also abort any in-flight drafting so the agent's next turn
		// doesn't try to propose into a cleared slot.
		const wasDrafting = confirmationIntent !== null;
		confirmationIntent = null;
		syncGoalTools();
		const msg = clearGoalCommandMessage({ archived: didArchive, wasDrafting });
		uiNotify(ctx, msg, didArchive || wasDrafting ? "info" : "warning");
	}

	async function handleGoalAbort(ctx: ExtensionContext, rawNote?: string): Promise<void> {
		if (confirmationIntent !== null || tweakDraftingFor !== null) {
			confirmationIntent = null;
			tweakDraftingFor = null;
			syncGoalTools();
			updateUI(ctx);
			uiNotify(ctx, abortGoalCommandMessage({ archived: false, wasDrafting: true }), "info");
			return;
		}
		reconcileFocusedGoalFromDisk(ctx);
		if (!state.goal && openGoals().length > 0) {
			const selected = await chooseOpenGoal(ctx, "Abort which open goal?");
			if (!selected) return;
		}
		const archived = archiveCurrentGoal(ctx, "user");
		const didArchive = !!archived;
		appendUserTerminationEvent(ctx, "aborted", archived, rawNote);
		resetGetGoalNudgeState(state.goal?.id);
		setGoal(null, ctx, true, "aborted");
		const wasDrafting = confirmationIntent !== null;
		confirmationIntent = null;
		syncGoalTools();
		const msg = abortGoalCommandMessage({ archived: didArchive, wasDrafting });
		uiNotify(ctx, msg, didArchive || wasDrafting ? "info" : "warning");
	}

	pi.registerMessageRenderer<GoalEventDetails>(GOAL_EVENT_ENTRY, renderGoalEvent);
	pi.registerMessageRenderer<GoalAuditEventDetails>(GOAL_AUDIT_ENTRY, renderGoalAuditEvent);

	// /goal and /goal-status: read-only status display.
	const statusCommand = {
		description: "Show the current goal: objective, status, sisyphus mode, usage.",
		handler: async (_rawArgs: string, ctx: ExtensionContext) => {
			await showGoalStatus(ctx);
		},
	};
	// /goal — Codex-style single entry: bare = status, reserved words manage,
	// any other text starts the drafting discussion (same as /goals).
	pi.registerCommand("goal", {
		description: "Discuss a new goal: /goal <topic> (same as /goals). Bare /goal shows focused goal status; /goal pause|resume|clear manage it. Direct-start with /goals-set; more via /goal-list, /goal-focus, /goal-settings, /goal-tweak, /goal-abort.",
		handler: async (rawArgs, ctx) => {
			const trimmed = rawArgs.trim();
			const keyword = trimmed.toLowerCase();
			if (!trimmed) {
				await showGoalStatus(ctx);
				return;
			}
			if (keyword === "pause") {
				await handleGoalPause(ctx);
				return;
			}
			if (keyword === "resume") {
				await handleGoalResume(ctx);
				return;
			}
			if (keyword === "clear") {
				await handleGoalClear(ctx);
				return;
			}
			await handleGoalCommandTopic(trimmed, ctx, "goal", { replace: false });
		},
	});
	pi.registerCommand("goal-status", statusCommand);
	pi.registerCommand("goal-list", {
		description: "List all open pi goals and show which one this session is focused on.",
		handler: async (_rawArgs, ctx) => {
			reconcileFocusedGoalFromDisk(ctx);
			uiNotify(ctx, buildGoalListText(goalsById, focusedGoalId), "info");
			updateUI(ctx);
		},
	});
	pi.registerCommand("goal-focus", {
		description: "Choose which open goal this session should focus on.",
		handler: async (_rawArgs, ctx) => {
			await focusGoalCommand(ctx);
		},
	});
	pi.registerCommand("goal-settings", {
		description: "Open pi-goal settings, including auditor provider/model/thinking_level.",
		handler: async (_rawArgs, ctx) => {
			await handleGoalSettings(ctx);
		},
	});

	// /goals <topic>: discussion/research/grilling -> confirmed normal goal draft.
	pi.registerCommand("goals", {
		description: "Discuss a new goal. The agent clarifies, researches, or grills assumptions, then proposes a draft for confirmation.",
		handler: async (rawArgs, ctx) => {
			await handleGoalCommandTopic(rawArgs, ctx, "goal", { replace: false });
		},
	});

	// /sisyphus <topic>: discussion/grilling -> confirmed Sisyphus goal draft.
	pi.registerCommand("sisyphus", {
		description: "Discuss a Sisyphus goal. The agent grills ordered steps, done criteria, blockers, and boundaries before proposing a draft.",
		handler: async (rawArgs: string, ctx: ExtensionContext) => {
			await handleGoalCommandTopic(rawArgs, ctx, "sisyphus", { replace: false });
		},
	});

	// /goals-set <objective> and /sisyphus-set <objective>: direct creation, no drafting discussion.
	pi.registerCommand("goals-set", {
		description: "Immediately create and start a normal goal from the supplied objective. No draft discussion.",
		handler: async (rawArgs, ctx) => {
			handleDirectGoalSet(rawArgs, ctx, "goal");
		},
	});
	pi.registerCommand("sisyphus-set", {
		description: "Immediately create and start a Sisyphus goal from the supplied objective. No draft discussion.",
		handler: async (rawArgs, ctx) => {
			handleDirectGoalSet(rawArgs, ctx, "sisyphus");
		},
	});

	// /goal-tweak [hint]: drafting on top of the current goal -> edits the active goal file.
	pi.registerCommand("goal-tweak", {
		description: "Refine the current goal via a drafting interview. The agent asks what to change, then edits the active goal file with the revised objective.",
		handler: async (rawArgs, ctx) => {
			await startGoalTweakDrafting(rawArgs, ctx);
		},
	});

	// /goal-clear: archive the current goal.
	pi.registerCommand("goal-clear", {
		description: "Archive the current goal.",
		handler: async (rawArgs, ctx) => {
			await handleGoalClear(ctx, typeof rawArgs === "string" ? rawArgs : undefined);
		},
	});

	// /goal-abort: abandon and archive the current goal, or cancel drafting.
	pi.registerCommand("goal-abort", {
		description: "Abort the current goal and archive it, or cancel an in-progress drafting flow.",
		handler: async (rawArgs, ctx) => {
			await handleGoalAbort(ctx, typeof rawArgs === "string" ? rawArgs : undefined);
		},
	});

	// /goal-pause: pause the currently running goal.
	pi.registerCommand("goal-pause", {
		description: "Pause the currently running goal. Esc also pauses while a goal is running.",
		handler: async (rawArgs, ctx) => {
			await handleGoalPause(ctx, typeof rawArgs === "string" ? rawArgs : undefined);
		},
	});

	// /goal-resume: resume a paused goal.
	pi.registerCommand("goal-resume", {
		description: "Resume a paused goal.",
		handler: async (rawArgs, ctx) => {
				await handleGoalResume(ctx, typeof rawArgs === "string" ? rawArgs : undefined);
		},
	});

	// goal-notes: audit trail for USER-initiated termination — the agent's
	// abort tool already ledgers; the /goal-abort and /goal-clear paths did
	// not. The trailing note (if any) rides the reason.
	function appendUserTerminationEvent(ctx: ExtensionContext, kind: "aborted" | "cleared", archived: { id: string; archivedPath?: string } | null, note?: string): void {
		try {
			appendGoalEvent(ctx, {
				type: "goal_aborted",
				goalId: archived?.id ?? state.goal?.id ?? "unknown",
				reason: note?.trim() ? `user ${kind}: ${note.trim()}` : `user ${kind}`,
				archivePath: archived?.archivedPath,
				at: nowIso(),
			});
		} catch {
			// Ledger append failure should not crash termination
		}
	}

	// /goal-note: attach or clear a STANDING user note that rides every goal
	// and checkpoint prompt (goal-notes; consumed by prompts, never written
	// by the agent). `/goal-note clear` (or empty on an existing note) clears.
	pi.registerCommand("goal-note", {
		description: "Attach a standing user note to the active goal (/goal-note <text>) or clear it (/goal-note clear).",
		handler: async (rawArgs, ctx) => {
			reconcileFocusedGoalFromDisk(ctx);
			if (!state.goal || state.goal.status === "complete") {
				uiNotify(ctx, "No active goal to attach a note to.", "warning");
				return;
			}
			const arg = (typeof rawArgs === "string" ? rawArgs : "").trim();
			if (!arg || arg === "clear" || arg === "off") {
				if (!state.goal.userNote) {
					uiNotify(ctx, "No user note set.", "info");
					return;
				}
				setGoal({ ...state.goal, userNote: undefined }, ctx);
				uiNotify(ctx, "User note cleared.", "info");
				return;
			}
			setGoal({ ...state.goal, userNote: arg }, ctx);
			uiNotify(ctx, `User note set: ${truncateText(arg, 80)}`, "info");
		},
	});


	registerQuestionnaireTools(pi);

	pi.registerTool(defineTool({
		name: "get_goal",
		label: "Get Goal",
		description: "Get the current pi goal for this session: objective, status, auto-continue, usage, and local file paths.",
		promptSnippet: "Read the active pi goal state for the current session.",
		promptGuidelines: [
			"Use get_goal when you need the current goal before deciding whether to continue or mark it complete.",
			"Before marking a goal complete, compare every explicit requirement with concrete evidence from the workspace/session.",
			"If the returned goal has sisyphus mode on, you must execute strictly step-by-step in the order written in the objective; do not skip, combine, or rush steps, and stop to ask the user when blocked or unclear.",
		],
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			reconcileFocusedGoalFromDisk(ctx);
			if (state.goal) syncGoalPromptFromDisk(ctx);
			syncGoalTools();
			const view = goalForDisplay() ?? state.goal;
			const otherCount = otherOpenGoalCount(goalsById, focusedGoalId);
			let nudge = "";
			if (view && view.status === "active" && view.id) {
				const prior = activeGetGoalTurnsByGoalId.get(view.id) ?? 0;
				if (prior >= 2) {
					nudge = "\n\n[NUDGE] You have called get_goal multiple times this turn. Prefer concrete work tools (write/read/bash/edit) to advance the goal.";
				}
			}
			const lifecycleHint = view && (view.status === "active" || view.status === "paused")
				? "\nLifecycle tools: if evidence proves the objective is satisfied, call update_goal({status: \"complete\"}); if blocked, call pause_goal({reason, suggestedAction?}); if abandoned/obsolete/unsafe, call abort_goal({reason}). For file or shell work, use the normal work tools directly (write/read/bash/edit); do not call get_goal repeatedly just to look for tools."
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
				details: goalDetails(state.goal),
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

	// Agent's goal-confirmation entry point. Shows the user a full plain-text
	// draft report with two choices: [Confirm] (creates the goal) or
	// [Continue Chatting] (returns control to the agent for more clarification).
	// Schema gates enforce focus-vs-sisyphus consistency; draftId is ignored for
	// one-release compatibility with older prompt residue.
	// In headless mode (no UI), auto-confirms — harness-friendly.
	pi.registerTool(defineTool({
		name: PROPOSE_DRAFT_TOOL_NAME,
		label: "Propose Goal Draft",
		description: "During /goals or /sisyphus intent discussion, propose the goal draft to the user. The user sees a full plain-text confirmation report and chooses Confirm (creates the goal) or Continue Chatting (returns control to you to refine). REPLACES create_goal during discussion-based creation.",
		promptSnippet: "Propose the drafted goal to the user with a full plain-text Confirm / Continue Chatting dialog.",
		promptGuidelines: [
			"Call propose_goal_draft when a /goals or /sisyphus intent discussion has enough information to write a concrete goal. Ask a focused question only when the request is still ambiguous.",
			"If an answer exposes ambiguity, keep interviewing the user — do not propose prematurely.",
			"The user will see a full plain-text draft report plus a [Confirm] / [Continue Chatting] choice. Confirm creates the goal; Continue Chatting returns control to you to ask follow-up questions.",
			"If the tool returns 'continue chatting', ask the user what they want changed. Do NOT propose again immediately with the same content; iterate based on their feedback first.",
			"The sisyphus field must match the user's confirmation focus: /sisyphus -> sisyphus=true, /goals -> sisyphus=false. The schema enforces this; mismatched proposals are REJECTED.",
			"For sisyphus goals, preserve the user's requested ordered style and completion standard. Do not add reconnaissance/preflight steps, merge steps, reorder steps, or change the mode without explicit user confirmation.",
			"create_goal is rejected; propose_goal_draft is the confirmation path. This is intentional — the user wants explicit say in goal creation.",
		],
		parameters: Type.Object({
			objective: Type.String({ description: "Full goal text. For Sisyphus goals this MUST include the user's numbered steps + per-step done criteria, taken faithfully from the user's input." }),
			autoContinue: Type.Optional(Type.Boolean({ description: "Whether pi should keep sending continuation prompts until complete. Default true." })),
			sisyphus: Type.Optional(Type.Boolean({ description: "Must equal true for /sisyphus discussion, false for /goals discussion. Schema-enforced via B1 gate." })),
			draftId: Type.Optional(Type.String({ description: "Deprecated compatibility field. It is accepted but ignored; current goal confirmation no longer depends on hidden draft ids." })),
		}),
		executionMode: "sequential",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const validation = validateGoalDraftProposal({
				intent: confirmationIntent,
				hasUnfinishedGoal: !!state.goal && state.goal.status !== "complete",
				objective: params.objective,
				sisyphus: params.sisyphus,
				draftId: params.draftId,
			});
			if (!validation.ok) {
				if (validation.clearDrafting) {
					confirmationIntent = null;
					syncGoalTools();
				}
				return {
					content: [{ type: "text", text: validation.message }],
					details: goalDetails(state.goal),
				};
			}
			const activeIntent = confirmationIntent;
			if (!activeIntent) throw new Error("Goal confirmation intent disappeared during proposal validation.");

			// All schema gates passed. Decide how to confirm.
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
				// Headless: auto-confirm (tests and non-TUI sessions).
				decision = "confirm";
			} else {
				// TUI: show overlay dialog.
				try {
					decision = await showProposalDialog(ctx, draftSummary, activeIntent.focus);
				} catch (err) {
					const message = proposalDialogFailureMessage(err);
					uiNotify(ctx, message, "error");
					return {
						content: [{ type: "text", text: message }],
						details: goalDetails(state.goal),
					};
				}
			}

			if (decision === "confirm") {
				const config: GoalCreationConfig = {
					objective,
					autoContinue: autoContinueFlag,
					sisyphus: sisyphusFlag,
				};
				confirmationIntent = null;
				replaceGoal(config, ctx, false);
				syncGoalTools();
				return {
					content: [{ type: "text", text: buildGoalCreatedReport({ objective, detailedSummary: detailedSummary(state.goal), autoContinue: state.goal?.autoContinue, sisyphus: state.goal?.sisyphus }) }],
					details: goalDetails(state.goal, "created"),
					terminate: true,
				};
			}
			// "continue" — user wants to keep chatting. Drafting state stays armed.
			return {
				content: [{
					type: "text",
					text: "User clicked 'Continue Chatting'. The goal was NOT created. Ask the user what they want to change about the draft (objective, scope, criteria, steps), then revise and call propose_goal_draft again. Do not call propose_goal_draft again with the same content — wait for the user's input first.",
				}],
				details: goalDetails(state.goal),
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
		description: "Mark the current active or paused pi goal complete when the objective is actually achieved.",
		promptSnippet: "Mark the active or paused pi goal complete when the objective is achieved.",
		promptGuidelines: [
			"Use update_goal with status=complete only when the pi goal objective has actually been achieved and no required work remains.",
			"Before calling update_goal, summarize the evidence you believe proves completion; the tool will launch an independent pi auditor agent to inspect the workspace and judge the claim.",
			"The auditor is authoritative: completion is archived only if the auditor report ends with <approved/>. If it ends with <disapproved/> or no approval marker, update_goal is rejected and the goal remains open.",
			"Do not call update_goal merely because work is stopping, substantial progress was made, or tests passed without covering every requirement.",
			"Do not use update_goal=complete as an escape hatch when you are blocked. If you are blocked, call pause_goal({reason, suggestedAction?}) instead so the user can intervene.",
			"For sisyphus goals, do not mark complete until every numbered step has been executed and individually verified against its done criterion.",
		],
		parameters: Type.Object({
			status: StringEnum([COMPLETE_STATUS] as const, { description: "Set to complete only when the objective is achieved." }),
			completionSummary: Type.Optional(Type.String({ description: "Concise completion claim and evidence summary passed to the independent auditor agent." })),
		}),
		executionMode: "sequential",
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			reconcileFocusedGoalFromDisk(ctx);
			if (params.status !== COMPLETE_STATUS) throw new Error("update_goal only supports status=complete.");
			const completionGate = validateGoalCompletion({ goal: state.goal, runningGoalId });
			if (!completionGate.ok) {
				return {
					content: [{ type: "text", text: completionGate.message }],
					details: goalDetails(state.goal),
				};
			}
			if (!state.goal) throw new Error("Goal disappeared during completion validation.");
			// Which audit attempt this is (1 = first try) — persisted up front
			// so the count survives a rejected audit and process restarts.
			const auditAttemptNo = (state.goal.auditAttempts ?? 0) + 1;
			const auditTarget = { ...mergeGoalPromptFromDisk(ctx, state.goal), auditAttempts: auditAttemptNo };
			state.goal = { ...state.goal, auditAttempts: auditAttemptNo };
			persist(ctx);
			const outcome = await runCompletionAudit({
				ctx,
				goal: auditTarget,
				completionSummary: params.completionSummary,
				detailedSummaryText: detailedSummary(auditTarget),
				signal,
				// Bounded audit (spec 2026-10-04-goal-audit-hang-fix): update_goal
				// must always return; on expiry the flow returns a rejected outcome
				// and the goal stays active.
				timeoutMs: loadGoalAuditorFileConfig(ctx.cwd).auditTimeoutMs,
				sendAuditEvent: ({ content, phase, goalId, auditor }) => {
					pi.sendMessage<GoalAuditEventDetails>({
						customType: GOAL_AUDIT_ENTRY,
						content,
						display: true,
						details: { phase, goalId, auditor },
					});
				},
			});
			if (outcome.verdict === "rejected") {
				return {
					content: [{ type: "text", text: outcome.rejectionText }],
					details: goalDetails(state.goal, "rejected"),
				};
			}
			// Account for any remaining elapsed time first so the compact
				// "goal achieved" line carries the final usage numbers.
			accountProgress(ctx);
			const finalUsage = state.goal ? { ...state.goal.usage } : null;
			// In-place audit verdict marker was emitted by the flow; the summary
				// line below is deferred to the end of this finishing turn so the
				// model's closing summary renders first and "Goal achieved" last.
			pendingAchievement.hold({
				content: outcome.approvalText,
				details: {
					phase: "approved",
					goalId: outcome.goalId,
					auditor: outcome.auditorModel,
					...(finalUsage
						? { achievedAt: Date.now(), activeSeconds: finalUsage.activeSeconds, tokensUsed: finalUsage.tokensUsed, costUsed: finalUsage.costUsed, auditAttempts: auditAttemptNo }
						: {}),
				},
			});
			state.goal = auditTarget;
			stopActiveGoal("complete", "agent", ctx);
			const completedGoal = state.goal;
			// C9 fix: mark turn-stopped so subsequent in-turn tool calls are blocked.
			turnStoppedFor = completedGoal?.id ?? null;
			if (completedGoal) {
				resetGetGoalNudgeState(completedGoal.id);
				goalsById.delete(completedGoal.id);
				focusedGoalId = null;
				appendFocusEntry(null, "completed");
				syncGoalTools();
				updateUI(ctx);
				// Append ledger: goal completed
				try {
					appendGoalEvent(ctx, {
						type: "goal_completed",
						goalId: completedGoal.id,
						archivePath: completedGoal.archivedPath,
						at: nowIso(),
					});
				} catch {
					// Ledger append failure should not crash completion
				}
			}
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
		description: "Pause the active pi goal and report a blocker to the user. The user must /goal-resume, /goal-tweak, or /goal-clear before work continues.",
		promptSnippet: "Pause the active pi goal and report a concrete blocker so the user can intervene.",
		promptGuidelines: [
			"Use pause_goal when you have hit a real blocker that you cannot resolve with one more reasonable next step: missing credentials, ambiguous or contradictory spec, a file or permission you cannot access, a sisyphus step whose precondition is not in the plan, or any irreversible / dangerous operation that requires explicit user approval.",
			"Do NOT use pause_goal to escape a merely hard problem; first try one concrete next step. Do not use pause_goal as a softer substitute for update_goal=complete \u2014 if the objective is achieved, complete it; if it is not, do not complete it.",
			"Never silently invent a workaround, fake completion, or quietly redefine the objective. Pause and report instead.",
			"Always pass a concrete one-sentence reason. When you know how the user can unblock you, pass suggestedAction (e.g. 'Set FOO_API_KEY env var and /goal-resume', or 'Use /goal-tweak to insert a precondition step before step 3').",
			"After pause_goal returns, stop. Do not call other tools in the same turn.",
			"For sisyphus goals: if any step is unclear, blocked, fails, or seems wrong, pause_goal is the correct action \u2014 do not skip the step or invent a workaround.",
		],
		parameters: Type.Object({
			reason: Type.String({ description: "One-sentence concrete blocker description. Plain language, not an apology." }),
			suggestedAction: Type.Optional(Type.String({ description: "Optional concrete suggestion for how the user can unblock (e.g. command to run, value to provide, /goal-tweak hint)." })),
		}),
		executionMode: "sequential",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			reconcileFocusedGoalFromDisk(ctx);
			const reason = params.reason.trim();
			if (!reason) throw new Error("pause_goal requires a non-empty reason.");
			const pauseGate = validatePauseGoal({ goal: state.goal, runningGoalId, reason });
			if (!pauseGate.ok) {
				return {
					content: [{ type: "text", text: pauseGate.message }],
					details: goalDetails(state.goal),
				};
			}
			if (!state.goal) throw new Error("Goal disappeared during pause validation.");
			const suggested = params.suggestedAction?.trim() || undefined;

			// Account for any remaining elapsed time before stopping the run.
			accountProgress(ctx);
			state.goal = mergeGoalPromptFromDisk(ctx, state.goal);
			const next = buildPausedByAgentGoal(state.goal, { reason, suggestedAction: suggested, updatedAt: nowIso() });
			setGoal(next, ctx);
			resetGetGoalNudgeState(next.id);
			// C9 fix: mark turn-stopped so subsequent in-turn tool calls are blocked.
			// This is the schema-level closure of "agent kept writing files after pause_goal".
			turnStoppedFor = state.goal.id;

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
				details: goalDetails(state.goal, "paused"),
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
		description: "Abort the current active or paused pi goal and archive it without marking it complete.",
		promptSnippet: "Abort the current pi goal only when the user asks to abandon it or the objective is obsolete/impossible.",
		promptGuidelines: [
			"Use abort_goal only when the user explicitly asks to abandon/cancel the current goal, or when the goal is impossible, obsolete, or unsafe to continue and should not be marked complete.",
			"Do not use abort_goal as a substitute for update_goal(status=complete). If the objective is achieved, complete it instead.",
			"Do not use abort_goal for ordinary blockers that the user can resolve; use pause_goal({reason, suggestedAction?}) for that case.",
			"Always pass a concrete one-sentence reason. After abort_goal returns, stop and do not call other tools in the same turn.",
		],
		parameters: Type.Object({
			reason: Type.String({ description: "One-sentence reason for abandoning the current goal. Plain language, not an apology." }),
		}),
		executionMode: "sequential",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			reconcileFocusedGoalFromDisk(ctx);
			const reason = params.reason.trim();
			if (!reason) throw new Error("abort_goal requires a non-empty reason.");
			const abortGate = validateGoalAbort({ goal: state.goal, runningGoalId, reason });
			if (!abortGate.ok) {
				return {
					content: [{ type: "text", text: abortGate.message }],
					details: goalDetails(state.goal),
				};
			}
			if (!state.goal) throw new Error("Goal disappeared during abort validation.");
			const abortedGoalId = state.goal.id;

			// Account for any remaining elapsed time before abandoning the run.
			accountProgress(ctx);
			state.goal = mergeGoalPromptFromDisk(ctx, state.goal);
			state.goal = buildAbortedByAgentGoal(state.goal, { reason, updatedAt: nowIso() });
			const archived = archiveCurrentGoal(ctx, "agent");
			resetGetGoalNudgeState(abortedGoalId);
			setGoal(null, ctx, true, "aborted");
			turnStoppedFor = abortedGoalId;

			const archiveLine = archived?.archivedPath ? `\nArchive: ${archived.archivedPath}` : "";
			uiNotify(ctx, 
				`Goal aborted by agent.\nReason: ${truncateText(reason, 200)}${archiveLine}`,
				"warning",
			);
			// Append ledger event for abort
			try {
				appendGoalEvent(ctx, {
					type: "goal_aborted",
					goalId: abortedGoalId,
					reason,
					archivePath: archived?.archivedPath,
					at: nowIso(),
				});
			} catch {
				// Ledger append failure should not crash abort
			}
			return {
				content: [{
					type: "text",
					text: `Goal aborted. Reason: ${reason}${archiveLine}\nThe goal has been archived and cleared. Stop now; do not start another tool call.`,
				}],
				details: goalDetails(state.goal, "aborted"),
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
				details: goalDetails(state.goal),
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
		description: "Atomically apply a /goal-tweak revision to the active goal. The ONLY way to modify an active goal's objective. Only available during a /goal-tweak drafting flow.",
		promptSnippet: "Apply the revised goal objective produced by a /goal-tweak drafting interview.",
		promptGuidelines: [
			"Only call apply_goal_tweak inside a /goal-tweak drafting flow (the prompt makes that explicit). It is rejected at any other time.",
			"newObjective must be the FULL revised objective text, formatted the same way as the original (=== Goal === or === Sisyphus Goal === block). Do NOT pass a diff or partial patch; pass the whole new objective.",
			"For Sisyphus goals: preserve the Sisyphus style and ordered-plan wording unless the user explicitly asks to remove it.",
			"changeSummary is a one-sentence description of WHAT changed (for the activity log and pause messages).",
			"Do NOT use write/edit/bash to modify the active goal file directly. apply_goal_tweak is the only sanctioned channel.",
			"After apply_goal_tweak returns, stop. Do not begin new task work in the same turn. The system will queue the next continuation.",
		],
		parameters: Type.Object({
			newObjective: Type.String({ description: "The complete revised objective text. For Sisyphus goals, preserve the Sisyphus style unless the user explicitly changes it." }),
			changeSummary: Type.String({ description: "One-sentence description of what was changed (used in UI notification and tweak log)." }),
		}),
		executionMode: "sequential",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			reconcileFocusedGoalFromDisk(ctx);
			if (!state.goal) {
				return {
					content: [{ type: "text", text: "No goal is set; apply_goal_tweak is a no-op." }],
					details: goalDetails(state.goal),
				};
			}
			if (tweakDraftingFor !== state.goal.id) {
				return {
					content: [{
						type: "text",
						text: "apply_goal_tweak REJECTED: no /goal-tweak drafting flow is active for this goal. " +
							"This tool can only be called during a /goal-tweak drafting interview that the user initiated. " +
							"If you want to change the goal, ask the user to run /goal-tweak.",
					}],
					details: goalDetails(state.goal),
				};
			}
			if (state.goal.status !== "active" && state.goal.status !== "paused") {
				return {
					content: [{ type: "text", text: `Goal is ${statusLabel(state.goal)}; cannot apply a tweak.` }],
					details: goalDetails(state.goal),
				};
			}
			const newObjective = params.newObjective.trim();
			if (!newObjective) throw new Error("apply_goal_tweak requires a non-empty newObjective.");
			const changeSummary = params.changeSummary.trim();
			if (!changeSummary) throw new Error("apply_goal_tweak requires a non-empty changeSummary.");
			const next: GoalRecord = {
				...state.goal,
				objective: newObjective,
				updatedAt: nowIso(),
				// Clear any prior agent pause reason — the user has redefined the work.
				pauseReason: undefined,
				pauseSuggestedAction: undefined,
			};
			// IMPORTANT: bypass setGoal() / persist() here. persist() calls
			// syncGoalPromptFromDisk() which would RE-READ the stale objective
			// from the still-old goal file on disk and clobber our new objective
			// before writing. apply_goal_tweak is the authoritative source for
			// objective changes — the disk is downstream, not upstream. Do the
			// minimal state update manually:
			//   1) write the new record to disk authoritatively
			//   2) update in-memory `goal` to the canonical post-write record
			//   3) append the state entry and re-sync tools
			//   4) clear the tweak drafting gate so apply_goal_tweak can't be re-used
			state.goal = writeActiveGoalFile(ctx, next);
			pi.appendEntry(STATE_ENTRY, goalDetails(state.goal));
			tweakDraftingFor = null;
			// Reset autoContinue counter — plan changed, agent gets a fresh chain.
			resetGetGoalNudgeState(state.goal.id);
			// C9 fix: mark turn-stopped so subsequent in-turn tool calls are blocked.
			turnStoppedFor = state.goal.id;
			syncGoalTools();
			updateUI(ctx);
			uiNotify(ctx, `Goal tweaked: ${truncateText(changeSummary, 160)}`, "info");
			// Append ledger event for tweak
			try {
				appendGoalEvent(ctx, {
					type: "goal_tweaked",
					goalId: state.goal.id,
					changeSummary,
					at: state.goal.updatedAt,
				});
			} catch {
				// Ledger append failure should not crash tweak
			}
			return {
				content: [{
					type: "text",
					text: `Goal tweak applied. ${changeSummary}\nStop now; the next continuation will arrive automatically if the goal is active.`,
				}],
				details: goalDetails(state.goal),
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

	syncGoalTools();

	pi.on("context", async (event): Promise<{ messages: typeof event.messages } | undefined> => {
		let changed = false;
		const latestGoalEventIndex = new Map<string, number>();
		event.messages.forEach((message, index) => {
			const queuedGoalId = goalEventMessageId(message as { customType?: string; details?: unknown; content?: unknown });
			if (queuedGoalId) latestGoalEventIndex.set(queuedGoalId, index);
		});

		const messages = event.messages.map((message, index) => {
			const candidate = message as { customType?: string; details?: unknown; content?: unknown };
			const queuedGoalId = goalEventMessageId(candidate);
			if (!queuedGoalId) return message;
			if (
				state.goal?.id === queuedGoalId
				&& (state.goal.status === "active")
				&& state.goal.autoContinue
				&& latestGoalEventIndex.get(queuedGoalId) === index
			) return message;
			changed = true;
			const details = asRecord(candidate.details) ?? {};
			return {
				...message,
				content: staleContinuationPrompt(queuedGoalId, state.goal),
				display: false,
				details: {
					...details,
					kind: "stale",
					goalId: queuedGoalId,
					currentGoalId: state.goal?.id ?? null,
					currentStatus: state.goal?.status ?? null,
				},
			} as typeof message;
		});
		return changed ? { messages } : undefined;
	});

	pi.on("turn_start", async (_event, ctx) => {
		// Per-turn flag resets (#4 + C9 fix).
		goalWorkToolCalledThisTurn = false;
		turnStoppedFor = null;
		beginAccounting();
		updateUI(ctx);
	});

	// #4 + C9 fix + Phase 5 C3: gate in-turn tool calls based on lifecycle state.
	pi.on("tool_call", async (event, ctx) => {
		// Post-stop in-turn block (C9 0ad8 fix): after pause_goal / abort_goal /
		// update_goal=complete / apply_goal_tweak fires in this turn, block all subsequent tool calls except
		// read-only inspection. Forces the agent to yield the turn instead of "fixing"
		// the situation by creating extra files etc.
		if (turnStoppedFor !== null && !POST_STOP_ALLOWED_TOOL_SET.has(event.toolName)) {
			return {
				block: true,
				reason: `The goal was already stopped earlier in this turn (goalId=${turnStoppedFor}). ` +
					`Do not call more tools; end the turn with a brief summary and yield to the user.`,
			};
		}
		// Phase 5 soft gate relaxation: active-goal question block and repeated get_goal
		// block are removed. The agent is trusted to prefer work tools; prompts nudge
		// toward concrete work without hard-stopping the turn.
		if (confirmationIntent === null && tweakDraftingFor === null && state.goal?.status === "active") {
			if (event.toolName === "get_goal") {
				const prior = activeGetGoalTurnsByGoalId.get(state.goal.id) ?? 0;
				activeGetGoalTurnsByGoalId.set(state.goal.id, prior + 1);
				// Nudge only: do not hard-block, but warn in tool response via get_goal execute
			}
		}
		// Track for #4 empty-turn gate.
		if (isMeaningfulProgressToolCall(event.toolName, asRecord(event)?.args)) {
			if (state.goal?.id) activeGetGoalTurnsByGoalId.delete(state.goal.id);
			goalWorkToolCalledThisTurn = true;
		} else if (state.goal?.status === "active" && state.goal.autoContinue && event.toolName !== "get_goal") {
			// A non-progress tool should not create an infinite retry chain.
			turnStoppedFor = state.goal.id;
		}
		return;
	});

	pi.on("tool_execution_end", async (_event, ctx) => {
		accountProgress(ctx);
	});

	// Execution-reported usage (goal-cost spec 2026-10-04): tool_result events
	// carry "usage from the tool execution itself" when the tool spent model
	// budget — subagent runs (pi-subagents reports the child session's totals)
	// and codemode's models.classify/generateImages. Without this hook those
	// costs never reach the goal ledger (verified 2026-10-03: three reviewers,
	// 1.94M tokens / $0.49, silently absent). No toolName filter — any
	// usage-reporting tool counts; tools without usage contribute nothing.
	pi.on("tool_result", async (event, ctx) => {
		const usage = toolExecutionUsage(event);
		if (!usage) return;
		accountProgress(ctx, { completedTurnTokens: usage.tokens, completedTurnCost: usage.cost });
	});

	pi.on("turn_end", async (event, ctx) => {
		const message = event.message as AssistantMessageLike;
		if (confirmationIntent !== null || tweakDraftingFor !== null) return;
		const tokens = assistantTurnTokens(message);
		const cost = assistantTurnCost(message);
		accountProgress(ctx, { completedTurnTokens: tokens, completedTurnCost: cost });

		if (isAbortedAssistantMessage(message)) {
			pauseActiveGoal(ctx);
			return;
		}
		refreshGoalDisplayFromDisk(ctx);
		// If the assistant ended a turn without queuing more tool calls, push a continuation right away.
		// #4: only queue if some real work was done this turn — otherwise the model is
		// just chatting and we should not keep firing turns on noise.
		if (
			!isToolUseAssistantMessage(message)
			&& state.goal?.status === "active"
			&& state.goal.autoContinue
			&& goalWorkToolCalledThisTurn
		) {
			queueContinuation(ctx);
		}
	});

	// Flush the held "Goal achieved" marker after the agent loop has fully
	// settled. Flushing at turn_end appended the custom message while the
	// loop was still streaming; pi then flushed it into agent state, and
	// since custom messages map to user-role LLM content, the loop treated
	// it as an unanswered user message and ran ANOTHER turn (the model then
	// "answered" the marker). One macrotask after agent_settled, isStreaming
	// is false and the append is display-only.
	pi.on("agent_settled", async () => {
		const held = pendingAchievement.flush();
		if (!held) return;
		const t = setTimeout(() => {
			pi.sendMessage<GoalAuditEventDetails>({ customType: GOAL_AUDIT_ENTRY, ...held, display: true });
		}, 0);
		t.unref?.();
	});

	pi.on("message_end", async (event, ctx) => {
		if (isAbortedAssistantMessage(event.message)) pauseActiveGoal(ctx);
		const raw = asRecord(event.message);
		// Drafting injections stay visible (compact "Goal <topic>" line);
		// checkpoint/continuation events remain hidden.
		const kind = asRecord(raw?.details)?.kind;
		if (raw?.role === "custom" && raw.customType === GOAL_EVENT_ENTRY && raw.display !== false && kind !== "drafting") {
			return { message: { ...event.message, display: false } as typeof event.message };
		}
	});

	pi.on("session_start", async (event, ctx) => {
		loadState(ctx);
		// Widget order fix: remount on every session start so the goal block
		// registers ahead of cc-status's microtask re-registration (goal
		// above the spinner row) and survives session-invalidated TUI maps.
		if (ctx.hasUI) goalUi.remountWidget(ctx);
		goalUi.syncTerminalInputPause(ctx);
		if (event.reason === "resume" && !state.goal && openGoals().length > 1 && ctx.hasUI) {
			await focusGoalCommand(ctx);
		}
		// Codex behavior: prompt before reactivating a paused goal on resume.
		if (event.reason === "resume" && state.goal?.status === "paused" && ctx.hasUI) {
			const current = state.goal;
			const shouldResume = await ctx.ui.confirm("Resume paused goal?", `Goal: ${current.objective}`);
			if (shouldResume) {
				setGoal({ ...current, status: "active", autoContinue: true, stopReason: undefined, pauseReason: undefined, pauseSuggestedAction: undefined }, ctx);
			}
		}
		beginAccounting();
		queueContinuation(ctx, true);
	});

	pi.on("session_before_compact", async (_event, ctx) => {
		accountProgress(ctx);
	});

	pi.on("session_compact", async (_event, ctx) => {
		if (confirmationIntent !== null || tweakDraftingFor !== null) return;
		if (state.goal) persist(ctx);
		beginAccounting();
		// Arm a deterministic compaction summary for the next agent turn.
		// This replaces the generic reminder with artifact-backed state.
		if (shouldArmPostCompactReminder(state.goal)) {
			postCompactReminderPending = true;
		}
		queueContinuation(ctx, true);
	});

	pi.on("session_tree", async (_event, ctx) => {
		loadState(ctx);
		goalUi.syncTerminalInputPause(ctx);
		beginAccounting();
		queueContinuation(ctx, true);
	});

	pi.on("before_agent_start", async (event, ctx) => {
		syncGoalTools();
		const currentSystemPrompt = () => ctx.getSystemPrompt?.() || event.systemPrompt;
		const incomingGoalId = extractGoalIdFromInjectedMessage(event.prompt ?? "");

		if (confirmationIntent !== null) {
			clearContinuationState();
			clearActiveAccounting();
			runningGoalId = null;
			return { systemPrompt: currentSystemPrompt() };
		}

		if (tweakDraftingFor !== null) {
			clearContinuationState();
			clearActiveAccounting();
			runningGoalId = null;
			return { systemPrompt: currentSystemPrompt() };
		}

		// If this turn was triggered by a hidden goal checkpoint that no longer
		// matches the active goal, abort the whole turn instead of letting the
		// model act on a stale instruction.
		if (incomingGoalId !== null) {
			clearContinuationState();
			if (!state.goal || state.goal.id !== incomingGoalId || (state.goal.status !== "active") || !state.goal.autoContinue) {
				try {
					ctx.abort?.();
				} catch {}
				updateUI(ctx);
				return {
					systemPrompt: `${currentSystemPrompt()}\n\n${staleContinuationPrompt(incomingGoalId, state.goal)}`,
				};
			}
		} else {
			// A user-driven turn — clear any queued continuation so we don't
			// double-fire after the user's own message returns. Also reset the
			// autoContinue nudge state so the user always gets a fresh chain.
			clearContinuationState();
			resetGetGoalNudgeState(state.goal?.id);
		}

		if (!state.goal) {
			runningGoalId = null;
			const openCount = openGoals().length;
			if (openCount > 0) {
				return { systemPrompt: `${currentSystemPrompt()}\n\n${unfocusedOpenGoalsPrompt(openCount)}` };
			}
			return;
		}
		reconcileFocusedGoalFromDisk(ctx);
		if (!state.goal) {
			runningGoalId = null;
			const openCount = openGoals().length;
			if (openCount > 0) return { systemPrompt: `${currentSystemPrompt()}\n\n${unfocusedOpenGoalsPrompt(openCount)}` };
			return;
		}
		runningGoalId = state.goal.status === "active" ? state.goal.id : null;
		if (state.goal.status === "complete") return;
		if (state.goal.status === "paused") {
			const current = state.goal;
			const pauseExtras: string[] = [];
			if (current.stopReason === "agent") {
				pauseExtras.push("");
				pauseExtras.push(`Pause reason (you set this in a prior turn via pause_goal): ${current.pauseReason ?? "(unknown)"}`);
				if (current.pauseSuggestedAction) pauseExtras.push(`You suggested: ${current.pauseSuggestedAction}`);
			} else if (current.pauseReason) {
				const { label, text } = pauseReasonLabel(current.pauseReason);
				pauseExtras.push("");
				pauseExtras.push(`${label} (the user set this via /goal-pause; honor it when work resumes): ${text}`);
			}
			// Inject durable auditor feedback if available
			let auditorExtra = "";
			try {
				const ledger = readGoalLedger(ctx);
				const auditorResult = latestAuditorResultForGoal(ledger.events, current.id);
				if (auditorResult && auditorResult.verdict === "disapproved") {
					auditorExtra = `\n\n${auditorRejectionBlock(auditorResult.report, current.id)}`;
				}
			} catch {
				// Ledger read failure should not break the prompt
			}
			return {
				systemPrompt: `${currentSystemPrompt()}\n\n[PI GOAL PAUSED goalId=${current.id}]\n${untrustedObjectiveBlock(current)}${pauseExtras.join("\n")}${auditorExtra}\n\nThe goal is paused. Do not autonomously continue substantive work unless the user resumes it with /goal-resume. If the user explicitly asks to finish or abandon the paused goal, or the objective is already satisfied based on available evidence, you may call update_goal(status=complete) or abort_goal without resuming. Do not call pause_goal again.`,
			};
		}
		const activeGoal = state.goal;
		let prompt = goalPrompt(activeGoal);
		// Inject durable auditor feedback if the latest result was a rejection
		try {
			const ledger = readGoalLedger(ctx);
			const auditorResult = latestAuditorResultForGoal(ledger.events, activeGoal.id);
			if (auditorResult && auditorResult.verdict === "disapproved") {
				prompt = `${prompt}\n\n${auditorRejectionBlock(auditorResult.report, activeGoal.id)}`;
			}
		} catch {
			// Ledger read failure should not break the prompt
		}
		if (shouldInjectPostCompactReminder({ pending: postCompactReminderPending, goal: activeGoal })) {
			postCompactReminderPending = false;
			// Use deterministic compaction summary instead of generic reminder
			try {
				const ledger = readGoalLedger(ctx);
				const compaction = buildCompactionSummary({ goalsById, focusedGoalId, ledgerEvents: ledger.events });
				prompt = `${prompt}\n\n[POST-COMPACTION RESYNC goalId=${activeGoal.id}]\n${compaction}`;
			} catch {
				prompt = `${prompt}\n\n[POST-COMPACTION RESYNC goalId=${state.goal.id}]\nThe conversation was just compacted. Re-read the objective and continue from the actual artifacts/state; do not rely on memory of the prior chat.`;
			}
		}
		return { systemPrompt: `${currentSystemPrompt()}\n\n${prompt}` };
	});

	pi.on("agent_end", async (event, ctx) => {
		if (confirmationIntent !== null || tweakDraftingFor !== null) return;
		const endedGoalId = runningGoalId;
		runningGoalId = null;

		// Account for any tokens from aborted in-flight assistant messages so
		// they are not silently lost (but charge them to the original goal).
		const aborted = event.messages
			.filter(isAbortedAssistantMessage)
			.reduce(
				(sum, message) => ({
					tokens: sum.tokens + assistantTurnTokens(message),
					cost: sum.cost + assistantTurnCost(message),
				}),
				{ tokens: 0, cost: 0 },
			);
		if ((aborted.tokens > 0 || aborted.cost > 0) && endedGoalId && state.goal?.id === endedGoalId) {
			accountProgress(ctx, { completedTurnTokens: aborted.tokens, completedTurnCost: aborted.cost });
		}

		continuationLoop.clearQueued();
		if (!state.goal || state.goal.status !== "active" || !state.goal.autoContinue) return;
		if (endedGoalId && state.goal.id !== endedGoalId) return;
		if (!reconcileFocusedGoalFromDisk(ctx)) return;
		if (hasAbortedAssistantMessage(event.messages) || ctx.signal?.aborted) {
			pauseActiveGoal(ctx);
			return;
		}
		persist(ctx);
		updateUI(ctx);
		queueContinuation(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		accountProgress(ctx);
		clearContinuationTimer();
		goalUi.dispose();
		if (state.goal) persist(ctx);
	});
}
