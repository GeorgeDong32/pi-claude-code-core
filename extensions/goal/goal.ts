
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { notify as uiNotify } from "../ui/notify.ts";
import { isSubagentChildProcess } from "../modes/permission-forwarding.ts";
import { coreBus } from "../bus.ts";
import { registerCompactionSubscriber } from "../../lib/compaction-seam.ts";

import { footerStatus, truncateText, displayObjectiveTitle, pauseReasonLabel } from "./goal-core.ts";
import { renderGoalAuditEvent, renderGoalEvent, type GoalAuditEventDetails } from "./renderers.ts";
import { registerQuestionnaireTools } from "./goal-questionnaire.ts";
import { CREATE_GOAL_TOOL_NAME, PROPOSE_DRAFT_TOOL_NAME, SISYPHUS_STEP_TOOL_NAME } from "./goal-tool-names.ts";
import { asRecord, cloneGoal, goalFocusDetails, normalizeGoalRecord, normalizeGoalFocusEntry, nowIso, type AssistantMessageLike, type GoalFocusEntry, type GoalFocusReason, type GoalCreationConfig, type GoalEventDetails, type GoalRecord, type GoalUsage } from "./goal-record.ts";
import { createGoalAccounting } from "./goal-accounting.ts";
import { appendGoalEvent, latestAuditorResultForGoal, readGoalLedger } from "./goal-ledger.ts";
import { buildCompactionSummary } from "./goal-compaction.ts";
import { archiveGoalFile, mergeGoalPromptFromDisk, readActiveGoalPool, sanitizeGoalPaths, writeActiveGoalFile } from "./storage/goal-files.ts";
import { openGoalsFromPool, otherOpenGoalCount } from "./goal-pool.ts";
import { auditorRejectionBlock, continuationPrompt, goalPrompt, staleContinuationPrompt, unfocusedOpenGoalsPrompt, untrustedObjectiveBlock, pausedGoalPrompt } from "./prompts/goal-prompts.ts";
import { buildGoalRunningNotification } from "./widgets/goal-notifications.ts";
import { createGoalUi } from "./ui.ts";

import { shouldArmPostCompactReminder, shouldInjectPostCompactReminder } from "./goal-policy.ts";
import { createContinuationLoop } from "./goal-continuation.ts";
import { createGoalLifecycle } from "./goal-lifecycle.ts";
import { createPendingAchievementSlot } from "./goal-audit-flow.ts";
import type { runGoalCompletionAuditor } from "./goal-auditor.ts";
import { FOCUS_ENTRY, GOAL_AUDIT_ENTRY, GOAL_EVENT_ENTRY, STATE_ENTRY, extractGoalIdFromInjectedMessage, goalDetails, goalEventMessageId } from "./goal-entries.ts";
import { assistantTurnCost, assistantTurnTokens, hasAbortedAssistantMessage, isAbortedAssistantMessage, isToolUseAssistantMessage, lastAssistantStopReason, toolExecutionUsage } from "./goal-turn-usage.ts";
import { widgetGoalProjection } from "./goal-summary.ts";
import { createGoalCommands } from "./goal-commands.ts";
import { registerGoalTools } from "./goal-tools.ts";


const CONTINUATION_ERROR_PAUSE_THRESHOLD = 2;
const PROVIDER_ERROR_PAUSE_PREFIX = "provider error: ";
const PROVIDER_ERROR_PAUSE_ACTION = "Check the model provider or quota (rate limit / credits), then run /goal resume to continue.";



let unregisterGoalSeam: (() => void) | undefined;

export default function goalExtension(pi: ExtensionAPI, deps: { now?: () => number; auditor?: typeof runGoalCompletionAuditor } = {}): void {
	const lifecycle = createGoalLifecycle({
		haltContinuation: () => clearContinuationState(),
		pauseClock: () => clearActiveAccounting(),
		forgetCarry: (goalId: string) => clock.forget(goalId),
		appendFocusEntry: (goalId: string | null, reason: GoalFocusReason) => appendFocusEntry(goalId, reason),
		appendLedger: (ctx, event) => appendGoalEvent(ctx as ExtensionContext, event as Parameters<typeof appendGoalEvent>[1]),
		syncTools: () => syncGoalTools(),
		updateUI: (ctx) => updateUI(ctx as ExtensionContext),
		nowIso,
		mergeGoalPromptFromDisk: (ctx, goal) => mergeGoalPromptFromDisk(ctx as ExtensionContext, goal),
		archiveGoal: (ctx, goal) => archiveGoalFile(ctx as ExtensionContext, goal),
		writeActiveGoalFile: (ctx, goal) => writeActiveGoalFile(ctx as ExtensionContext, goal),
		readActiveGoalPool: (ctx) => readActiveGoalPool(ctx as ExtensionContext),
		appendStateEntry: (goal) => {
			pi.appendEntry(STATE_ENTRY, goalDetails(goal));
			notePersistedUsage(goal);
		},
		beginClock: () => beginAccounting(),
	});

	const pendingAchievement = createPendingAchievementSlot();
	const goalUi = createGoalUi({
		getDisplayGoal: () => goalForDisplay() ?? lifecycle.focused(),
		getOpenGoalCount: () => openGoals().length,
		getOtherOpenGoalCount: () => otherOpenGoalCount(lifecycle.pool, lifecycle.focusedId),
		isGoalActive: () => lifecycle.focused()?.status === "active",
		shouldPauseOnEscape: () => {
			const g = lifecycle.focused();
			return !!g && g.status === "active" && !!g.autoContinue;
		},
		// INTERRUPT SAFETY (fix): Escape only pauses while the agent is idle;
		// while busy it belongs to the interrupt path and passes through.
		isAgentIdle: (ctx) => {
			try {
				return ctx.isIdle() && !ctx.hasPendingMessages();
			} catch {
				return false;
			}
		},
		pauseActiveGoal,
	});
	let runningGoalId: string | null = null;

	let postCompactReminderPending = false;

	let seamCtx: ExtensionContext | undefined;

	const clock = createGoalAccounting({ now: deps.now });

	const goalExecutionWorkTools = ["read", "bash", "edit", "write"] as const;

	/** Declared-set contract (goal tools diet v2): the work tools, get_goal and
	 * propose_goal_draft are always declared; create_goal (user must confirm via
	 * propose_goal_draft) and the legacy step_complete stay hidden; every other
	 * goal tool is codemode-exposed and never declared, so goal state never
	 * moves the tool list. Re-run every turn and idempotent: plan mode restores
	 * its entry snapshot on exit, and a same-set call does not touch the cache. */
	function syncGoalTools(): void {
		try {
			const active = new Set(pi.getActiveTools());
			for (const name of goalExecutionWorkTools) active.add(name);
			active.delete(CREATE_GOAL_TOOL_NAME);
			active.delete(SISYPHUS_STEP_TOOL_NAME);
			active.add("get_goal");
			active.add(PROPOSE_DRAFT_TOOL_NAME);
			pi.setActiveTools(Array.from(active));
		} catch {}
	}

	let pendingResumeNote: string | null = null;

	const continuationLoop = createContinuationLoop({
		getGoal: () => lifecycle.focused(),
		isDrafting: () => lifecycle.isDrafting,
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
		clock.pause();
	}


	function openGoals(): GoalRecord[] {
		return openGoalsFromPool(lifecycle.pool);
	}

	function reconcileFocusedGoalFromDisk(ctx: ExtensionContext, opts: { preserveMemoryUsage?: boolean; captureDiskGoal?: { goal: GoalRecord | null } } = {}): boolean {
		if (isSubagentChildProcess()) return true;
		return lifecycle.reconcileFromDisk(ctx, { ...opts, preserveMemoryUsage: true });
	}


	function appendFocusEntry(goalId: string | null, reason: GoalFocusReason): void {
		pi.appendEntry(FOCUS_ENTRY, goalFocusDetails(goalId, reason));
	}

	function armFocusedContinuation(ctx: ExtensionContext): void {
		beginAccounting();
		const g = lifecycle.focused();
		if (g?.status === "active" && g.autoContinue) queueContinuation(ctx, true);
	}

	function beginAccounting(): void {
		if (lifecycle.isDrafting) {
			clearActiveAccounting();
			return;
		}
		const clockGoal = lifecycle.focused();
		if (!clockGoal || clockGoal.status !== "active") {
			clearActiveAccounting();
			return;
		}
		clock.begin(clockGoal.id);
	}

	function goalForDisplay(): GoalRecord | null {
		const display = lifecycle.focused();
		if (!display || display.status !== "active") {
			return display;
		}
		const liveSeconds = clock.preview(display.id);
		if (liveSeconds === 0) return display;
		const live = cloneGoal(display);
		live.usage.activeSeconds += liveSeconds;
		return live;
	}

	function accountProgress(ctx: ExtensionContext, opts: { completedTurnTokens?: number; completedTurnCost?: number } = {}): void {
		if (lifecycle.isDrafting) {
			clearActiveAccounting();
			return;
		}
		const settleGoal = lifecycle.focused();
		if (!settleGoal || settleGoal.status !== "active") {
			beginAccounting();
			return;
		}
		const settled = clock.settle(settleGoal.id);
		if (settled === null) {
			beginAccounting();
			return;
		}
		const elapsedSeconds = settled;

		const tokens = Math.max(0, Math.trunc(opts.completedTurnTokens ?? 0));
		const cost = Math.max(0, opts.completedTurnCost ?? 0);
		if (tokens === 0 && cost === 0 && elapsedSeconds === 0) return;

		lifecycle.applyUsage({ tokens, cost, seconds: elapsedSeconds });
		updateUI(ctx);
	}

	let lastPersistedUsageGoalId: string | null = null;
	let lastPersistedUsage: GoalUsage | null = null;

	function notePersistedUsage(goal: GoalRecord | null): void {
		if (!goal) {
			lastPersistedUsageGoalId = null;
			lastPersistedUsage = null;
			return;
		}
		lastPersistedUsageGoalId = goal.id;
		lastPersistedUsage = { ...goal.usage };
	}

	function usageUnpersisted(): boolean {
		const goal = lifecycle.focused();
		if (!goal) return false;
		if (lastPersistedUsageGoalId !== goal.id || !lastPersistedUsage) return true;
		return goal.usage.tokensUsed !== lastPersistedUsage.tokensUsed
			|| goal.usage.activeSeconds !== lastPersistedUsage.activeSeconds
			|| goal.usage.costUsed !== lastPersistedUsage.costUsed;
	}

	/** BH-E1 agent_end flush: persist only when the in-memory usage differs
	 * from the last persisted snapshot (usage-only changes are otherwise
	 * memory-only). The readCtx (when provided) is the ALREADY-PARSED focused
	 * disk goal from the same segment's reconcile — GO-B: the persist merge
	 * must not re-parse the focused file. */
	function persistUsageIfChanged(ctx: ExtensionContext, readCtx?: { goal: GoalRecord | null }): void {
		if (!usageUnpersisted()) return;
		persist(ctx, readCtx);
	}

	function syncGoalPromptFromDisk(ctx: ExtensionContext, readCtx?: { goal: GoalRecord | null }): boolean {
		return lifecycle.syncObjectiveFromDisk(ctx, readCtx);
	}

	function persist(ctx?: ExtensionContext, readCtx?: { goal: GoalRecord | null }): void {
		lifecycle.persistRecord(ctx, readCtx);
	}

	function refreshGoalDisplayFromDisk(ctx: ExtensionContext): void {
		lifecycle.refreshDisplayFromDisk(ctx);
	}

	function publishGoalChannel(
		widget?: { focus: "focused" | "unfocused" | "none"; statusLine: string; goal?: ReturnType<typeof widgetGoalProjection>; openGoalCount?: number },
	): void {
		const goal = lifecycle.focused();
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
		if (!ctx.hasUI) {
			publishGoalChannel();
			return;
		}
		const totalOpen = openGoals().length;
		if (!lifecycle.focused() && totalOpen === 0) {
			publishGoalChannel({ focus: "none", statusLine: "" });
			goalUi.clear(ctx);
			goalUi.stopStatusRefresh();
			return;
		}
		if (!lifecycle.focused()) {
			publishGoalChannel({ focus: "unfocused", statusLine: `goal: unfocused [${totalOpen} open] - /goal-focus`, openGoalCount: totalOpen });
			ctx.ui.setStatus("goal", `goal: unfocused [${totalOpen} open] - /goal-focus`);
			goalUi.registerWidget(ctx);
			goalUi.stopStatusRefresh();
			return;
		}

		const displayGoal = goalForDisplay() ?? lifecycle.focused()!;
		const otherCount = otherOpenGoalCount(lifecycle.pool, lifecycle.focusedId);
		publishGoalChannel({
			focus: "focused",
			statusLine: `${footerStatus(displayGoal)}${otherCount > 0 ? ` (+${otherCount} open)` : ""}`,
			goal: widgetGoalProjection(displayGoal),
			openGoalCount: totalOpen,
		});
		ctx.ui.setStatus("goal", `${footerStatus(displayGoal)}${otherCount > 0 ? ` (+${otherCount} open)` : ""}`);
		goalUi.registerWidget(ctx);

		if (displayGoal.status === "complete") {
			goalUi.stopStatusRefresh();
		} else {
			goalUi.syncStatusRefresh(ctx);
		}
	}

	function loadState(ctx: ExtensionContext): void {
		const childSession = isSubagentChildProcess();
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
		lifecycle.restore(ctx, { childSession, focusEntry, legacyGoal });
		notePersistedUsage(lifecycle.focused());
		runningGoalId = null;
	}

	function pauseActiveGoal(ctx: ExtensionContext, note?: string): void {
		const current = lifecycle.focused();
		if (!current || current.status !== "active") return;
		const userNote = note?.trim();
		lifecycle.pause(ctx, { note: userNote });
		uiNotify(ctx, userNote ? "Goal paused (note attached)." : "Goal paused.", "info");
	}

	const consecutiveContinuationErrors = new Map<string, number>();

	/**
	 * BH-R1 continuation-decision guard: read the run's last assistant
	 * stopReason. A non-error termination resets the goal's counter; an error
	 * increments it, and at CONTINUATION_ERROR_PAUSE_THRESHOLD the goal is
	 * paused THROUGH the lifecycle pause verb (systemReason variant — #120
	 * encapsulation, no direct state mutation) with the provider error text as
	 * the pause reason and a /goal-resume suggested action. The aborted branch
	 * keeps its existing user-pause behavior (checked before this guard).
	 * Returns true when the goal was paused (the caller must not re-queue).
	 */
	function maybePauseOnProviderError(ctx: ExtensionContext, messages: unknown[]): boolean {
		const goal = lifecycle.focused();
		if (!goal) return false;
		const { stopReason, errorMessage } = lastAssistantStopReason(messages);
		if (stopReason !== "error") {
			consecutiveContinuationErrors.delete(goal.id);
			return false;
		}
		const count = (consecutiveContinuationErrors.get(goal.id) ?? 0) + 1;
		if (count < CONTINUATION_ERROR_PAUSE_THRESHOLD) {
			consecutiveContinuationErrors.set(goal.id, count);
			return false;
		}
		consecutiveContinuationErrors.delete(goal.id);
		const errorText = (errorMessage?.trim() || "unknown provider error").slice(0, 120);
		const reason = `${PROVIDER_ERROR_PAUSE_PREFIX}${errorText}`;
		lifecycle.pause(ctx, { systemReason: reason, suggestedAction: PROVIDER_ERROR_PAUSE_ACTION });
		uiNotify(ctx, `Goal paused after ${CONTINUATION_ERROR_PAUSE_THRESHOLD} consecutive provider errors: ${truncateText(errorText, 160)}`, "warning");
		return true;
	}

	function queueContinuation(ctx: ExtensionContext, force = false): void {
		continuationLoop.queue(ctx, force);
	}

	function replaceGoal(config: GoalCreationConfig, ctx: ExtensionContext, startNow = true): void {
		lifecycle.create(config, ctx);
		uiNotify(ctx, buildGoalRunningNotification(config), "info");
		if (startNow && lifecycle.focused()?.autoContinue) queueContinuation(ctx, true);
	}


	pi.registerMessageRenderer<GoalEventDetails>(GOAL_EVENT_ENTRY, renderGoalEvent);
	pi.registerMessageRenderer<GoalAuditEventDetails>(GOAL_AUDIT_ENTRY, renderGoalAuditEvent);

	const { focusGoalCommand } = createGoalCommands(pi, {
		lifecycle,
		reconcileFocusedGoalFromDisk: (ctx, opts) => reconcileFocusedGoalFromDisk(ctx, opts),
		syncGoalPromptFromDisk: (ctx, readCtx) => syncGoalPromptFromDisk(ctx, readCtx),
		persist: (ctx, readCtx) => persist(ctx, readCtx),
		syncGoalTools: () => syncGoalTools(),
		updateUI: (ctx) => updateUI(ctx),
		openGoals: () => openGoals(),
		goalForDisplay: () => goalForDisplay(),
		clearContinuationState: () => clearContinuationState(),
		clearActiveAccounting: () => clearActiveAccounting(),
		armFocusedContinuation: (ctx) => armFocusedContinuation(ctx),
		queueContinuation: (ctx, force) => queueContinuation(ctx, force),
		replaceGoal: (config, ctx, startNow) => replaceGoal(config, ctx, startNow),
		pauseActiveGoal: (ctx, note) => pauseActiveGoal(ctx, note),
		setPendingResumeNote: (note) => {
			pendingResumeNote = note;
		},
		resetErrorStreak: (goalId) => {
			consecutiveContinuationErrors.delete(goalId);
		},
	});



	registerQuestionnaireTools(pi, () => lifecycle);

	registerGoalTools(pi, {
		lifecycle,
		reconcileFocusedGoalFromDisk: (ctx, opts) => reconcileFocusedGoalFromDisk(ctx, opts),
		syncGoalPromptFromDisk: (ctx, readCtx) => syncGoalPromptFromDisk(ctx, readCtx),
		syncGoalTools: () => syncGoalTools(),
		goalForDisplay: () => goalForDisplay(),
		openGoals: () => openGoals(),
		getRunningGoalId: () => runningGoalId,
		accountProgress: (ctx, opts) => accountProgress(ctx, opts),
		replaceGoal: (config, ctx, startNow) => replaceGoal(config, ctx, startNow),
		pendingAchievement,
		auditor: deps.auditor,
	});


	syncGoalTools();

	pi.on("context", async (event): Promise<{ messages: typeof event.messages } | undefined> => {
		let changed = false;
		const auditVisible = event.messages.filter((message) => {
			const candidate = message as { customType?: string; details?: unknown };
			if (candidate.customType !== GOAL_AUDIT_ENTRY) return true;
			if ((asRecord(candidate.details) as { viewOnly?: boolean } | null)?.viewOnly !== true) return true;
			changed = true;
			return false;
		});
		const latestGoalEventIndex = new Map<string, number>();
		auditVisible.forEach((message, index) => {
			const queuedGoalId = goalEventMessageId(message as { customType?: string; details?: unknown; content?: unknown });
			if (queuedGoalId) latestGoalEventIndex.set(queuedGoalId, index);
		});

		const messages = auditVisible.map((message, index) => {
			const candidate = message as { customType?: string; details?: unknown; content?: unknown };
			const queuedGoalId = goalEventMessageId(candidate);
			if (!queuedGoalId) return message;
			const ctxGoal = lifecycle.focused();
			if (
				ctxGoal?.id === queuedGoalId
				&& ctxGoal.status === "active"
				&& ctxGoal.autoContinue
				&& latestGoalEventIndex.get(queuedGoalId) === index
			) return message;
			changed = true;
			const details = asRecord(candidate.details) ?? {};
			return {
				...message,
				content: staleContinuationPrompt(queuedGoalId, lifecycle.focused()),
				display: false,
				details: {
					...details,
					kind: "stale",
					goalId: queuedGoalId,
					currentGoalId: lifecycle.focused()?.id ?? null,
					currentStatus: lifecycle.focused()?.status ?? null,
				},
			} as typeof message;
		});
		return changed ? { messages } : undefined;
	});

	pi.on("turn_start", async (_event, ctx) => {
		lifecycle.handle({ tag: "turn-start" });
		beginAccounting();
		updateUI(ctx);
	});

	pi.on("tool_call", async (event) => {
		const verdict = lifecycle.handle({ tag: "tool-call", toolName: event.toolName, input: event.input });
		if (verdict && verdict.blocked) {
			return { block: true, reason: verdict.reason };
		}
		return;
	});

	pi.on("tool_execution_end", async (_event, ctx) => {
		lifecycle.handle({ tag: "usage-accounted" });
		accountProgress(ctx);
	});

	pi.on("tool_result", async (event, ctx) => {
		const usage = toolExecutionUsage(event);
		if (!usage) return;
		lifecycle.handle({ tag: "usage-accounted" });
		accountProgress(ctx, { completedTurnTokens: usage.tokens, completedTurnCost: usage.cost });
	});

	pi.on("turn_end", async (event, ctx) => {
		const message = event.message as AssistantMessageLike;
		if (lifecycle.isDrafting) return;
		lifecycle.handle({ tag: "usage-accounted" });
		const tokens = assistantTurnTokens(message);
		const cost = assistantTurnCost(message);
		accountProgress(ctx, { completedTurnTokens: tokens, completedTurnCost: cost });

		if (isAbortedAssistantMessage(message)) {
			pauseActiveGoal(ctx);
			return;
		}
		refreshGoalDisplayFromDisk(ctx);
		const turnEndGoal = lifecycle.focused();
		if (
			!isToolUseAssistantMessage(message)
			&& turnEndGoal?.status === "active"
			&& turnEndGoal.autoContinue
			&& lifecycle.goalWorkToolCalledThisTurn
		) {
			queueContinuation(ctx);
		}
	});

	pi.on("agent_settled", async () => {
		lifecycle.handle({ tag: "agent-settled" });
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
		const kind = asRecord(raw?.details)?.kind;
		if (raw?.role === "custom" && raw.customType === GOAL_EVENT_ENTRY && raw.display !== false && kind !== "drafting") {
			return { message: { ...event.message, display: false } as typeof event.message };
		}
	});

	pi.on("session_start", async (event, ctx) => {
		seamCtx = ctx;
		loadState(ctx);
		if (ctx.hasUI) goalUi.remountWidget(ctx);
		goalUi.syncTerminalInputPause(ctx);
		if (event.reason === "resume" && !lifecycle.focused() && openGoals().length > 1 && ctx.hasUI) {
			await focusGoalCommand(ctx);
		}
		if (event.reason === "resume" && lifecycle.focused()?.status === "paused" && ctx.hasUI) {
			const current = lifecycle.focused()!;
			const shouldResume = await ctx.ui.confirm("Resume paused goal?", `Goal: ${current.objective}`);
			if (shouldResume) lifecycle.activate(ctx);
		}
		beginAccounting();
		queueContinuation(ctx, true);
	});

	const onCompactionBefore = (ctx: ExtensionContext): void => {
		lifecycle.handle({ tag: "usage-accounted" });
		accountProgress(ctx);
	};

	const onCompactionAfter = (ctx: ExtensionContext, midRun: boolean): void => {
		if (lifecycle.isDrafting) return;
		if (lifecycle.focused()) persist(ctx);
		beginAccounting();
		if (shouldArmPostCompactReminder(lifecycle.focused())) {
			postCompactReminderPending = true;
		}
		if (!midRun) queueContinuation(ctx, true);
	};

	pi.on("session_before_compact", async (_event, ctx) => {
		onCompactionBefore(ctx);
	});

	pi.on("session_compact", async (_event, ctx) => {
		onCompactionAfter(ctx, false);
	});

	unregisterGoalSeam?.();
	unregisterGoalSeam = registerCompactionSubscriber({
		before: () => {
			if (seamCtx) onCompactionBefore(seamCtx);
		},
		after: (info) => {
			if (seamCtx) onCompactionAfter(seamCtx, info.midRun);
		},
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
		const incomingGoalId = extractGoalIdFromInjectedMessage(event.messageType === "user" ? event.prompt : "");

		if (lifecycle.confirmationIntent !== null) {
			clearContinuationState();
			clearActiveAccounting();
			runningGoalId = null;
			return { systemPrompt: currentSystemPrompt() };
		}

		if (lifecycle.tweakDraftingFor !== null) {
			clearContinuationState();
			clearActiveAccounting();
			runningGoalId = null;
			return { systemPrompt: currentSystemPrompt() };
		}

		if (incomingGoalId !== null) {
			clearContinuationState();
			const checkpointGoal = lifecycle.focused();
			if (!checkpointGoal || checkpointGoal.id !== incomingGoalId || checkpointGoal.status !== "active" || !checkpointGoal.autoContinue) {
				try {
					ctx.abort?.();
				} catch {}
				updateUI(ctx);
				return {
					systemPrompt: `${currentSystemPrompt()}\n\n${staleContinuationPrompt(incomingGoalId, lifecycle.focused())}`,
				};
			}
		} else {
			clearContinuationState();
			lifecycle.handle({ tag: "nudge-reset", goalId: lifecycle.focused()?.id });
		}

		if (!lifecycle.focused()) {
			runningGoalId = null;
			const openCount = openGoals().length;
			if (openCount > 0) {
				return { systemPrompt: `${currentSystemPrompt()}\n\n${unfocusedOpenGoalsPrompt(openCount)}` };
			}
			return;
		}
		reconcileFocusedGoalFromDisk(ctx);
		if (!lifecycle.focused()) {
			runningGoalId = null;
			const openCount = openGoals().length;
			if (openCount > 0) return { systemPrompt: `${currentSystemPrompt()}\n\n${unfocusedOpenGoalsPrompt(openCount)}` };
			return;
		}
		const promptGoal = lifecycle.focused()!;
		runningGoalId = promptGoal.status === "active" ? promptGoal.id : null;
		if (promptGoal.status === "complete") return;
		const pausedGoalNarrowed = promptGoal;
		if (pausedGoalNarrowed?.status === "paused") {
			const current = pausedGoalNarrowed;
			const pauseExtras: string[] = [];
			if (current.stopReason === "agent") {
				pauseExtras.push("");
				pauseExtras.push(`Pause reason (you set this in a prior turn via pause_goal): ${current.pauseReason ?? "(unknown)"}`);
				if (current.pauseSuggestedAction) pauseExtras.push(`You suggested: ${current.pauseSuggestedAction}`);
			} else if (current.pauseReason?.startsWith(PROVIDER_ERROR_PAUSE_PREFIX)) {
				pauseExtras.push("");
				pauseExtras.push(`Pause reason (automatic): the goal was paused after consecutive provider errors: ${current.pauseReason.slice(PROVIDER_ERROR_PAUSE_PREFIX.length)}`);
				if (current.pauseSuggestedAction) pauseExtras.push(`Suggested: ${current.pauseSuggestedAction}`);
			} else if (current.pauseReason) {
				const { label, text } = pauseReasonLabel(current.pauseReason);
				pauseExtras.push("");
				pauseExtras.push(`${label} (the user set this via /goal-pause; honor it when work resumes): ${text}`);
			}
			let auditorExtra = "";
			try {
				const ledger = readGoalLedger(ctx);
				const auditorResult = latestAuditorResultForGoal(ledger.events, current.id);
				if (auditorResult && auditorResult.verdict === "disapproved") {
					auditorExtra = `\n\n${auditorRejectionBlock(auditorResult.report, current.id)}`;
				}
			} catch {
			}
			return {
				systemPrompt: `${currentSystemPrompt()}\n\n${pausedGoalPrompt(current, pauseExtras, auditorExtra)}`,
			};
		}
		const activeGoalNarrowed = lifecycle.focused();
		if (!activeGoalNarrowed || activeGoalNarrowed.status === "complete") return;
		const activeGoal = activeGoalNarrowed;
		let prompt = goalPrompt(activeGoal);
		try {
			const ledger = readGoalLedger(ctx);
			const auditorResult = latestAuditorResultForGoal(ledger.events, activeGoal.id);
			if (auditorResult && auditorResult.verdict === "disapproved") {
				prompt = `${prompt}\n\n${auditorRejectionBlock(auditorResult.report, activeGoal.id)}`;
			}
		} catch {
		}
		if (shouldInjectPostCompactReminder({ pending: postCompactReminderPending, goal: activeGoal })) {
			postCompactReminderPending = false;
			// Use deterministic compaction summary instead of generic reminder
			try {
				const ledger = readGoalLedger(ctx);
				const compaction = buildCompactionSummary({ goalsById: lifecycle.pool, focusedGoalId: lifecycle.focusedId, ledgerEvents: ledger.events });
				prompt = `${prompt}\n\n[POST-COMPACTION RESYNC goalId=${activeGoal.id}]\n${compaction}`;
			} catch {
				prompt = `${prompt}\n\n[POST-COMPACTION RESYNC goalId=${activeGoal.id}]\nThe conversation was just compacted. Re-read the objective and continue from the actual artifacts/state; do not rely on memory of the prior chat.`;
			}
		}
		return { systemPrompt: `${currentSystemPrompt()}\n\n${prompt}` };
	});

	pi.on("agent_end", async (event, ctx) => {
		if (lifecycle.isDrafting) return;
		const endedGoalId = runningGoalId;
		runningGoalId = null;

		const aborted = event.messages
			.filter(isAbortedAssistantMessage)
			.reduce(
				(sum, message) => ({
					tokens: sum.tokens + assistantTurnTokens(message),
					cost: sum.cost + assistantTurnCost(message),
				}),
				{ tokens: 0, cost: 0 },
			);
		if ((aborted.tokens > 0 || aborted.cost > 0) && endedGoalId && lifecycle.focused()?.id === endedGoalId) {
			accountProgress(ctx, { completedTurnTokens: aborted.tokens, completedTurnCost: aborted.cost });
		}

		continuationLoop.clearQueued();
		const readCtx: { goal: GoalRecord | null } = { goal: null };
		const reconciled = reconcileFocusedGoalFromDisk(ctx, { captureDiskGoal: readCtx });
		persistUsageIfChanged(ctx, readCtx);
		const endGoal = lifecycle.focused();
		if (!endGoal || endGoal.status !== "active" || !endGoal.autoContinue) return;
		if (endedGoalId && endGoal.id !== endedGoalId) return;
		if (!reconciled) return;
		if (hasAbortedAssistantMessage(event.messages) || ctx.signal?.aborted) {
			pauseActiveGoal(ctx);
			return;
		}
		if (maybePauseOnProviderError(ctx, event.messages)) return;
		updateUI(ctx);
		queueContinuation(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		accountProgress(ctx);
		clearContinuationTimer();
		consecutiveContinuationErrors.clear();
		goalUi.dispose();
		if (lifecycle.focused()) persist(ctx);
		lifecycle.handle({ tag: "dispose" });
	});
}
