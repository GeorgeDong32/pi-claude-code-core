/**
 * goal.ts — goal module adapter: assembles the lifecycle, UI, continuation,
 * accounting, and persistence halves behind the single `goalExtension(pi, deps)`
 * factory entry (SPEC SR E13a).
 *
 * Spec IDs: P2-2 (lifecycle ownership of pool/focus/drafting state), BH-R1
 * (provider-error continuation pause), BH-E1 (usage-flush baseline), GH-02
 * (subagent isolation), GO-A (activity clock), SC §5.9 W5 (compaction seam),
 * goal-notes, C5 follow-up, #120 encapsulation.
 *
 * Design decisions:
 * - This file owns ALL pi surface registration in a pinned order: two
 *   message renderers → commands (goal-commands.ts) → questionnaire tools →
 *   goal tools (goal-tools.ts) → the factory-time setActiveTools sync; then
 *   the fifteen pi.on handlers. The order is pinned by
 *   extensions/goal/tests/goal-registration-order.test.ts.
 * - Pure helpers live in the split modules: goal-entries.ts (frozen entry
 *   constants + state projection + injected-id parsing), goal-turn-usage.ts
 *   (message classification + four-channel token/cost extraction),
 *   goal-summary.ts (usage summary + widget projection + missing-criteria
 *   notice), goal-settings.ts (/goal-settings dialog).
 * - `unregisterGoalSeam` is a module-level singleton: exactly one live
 *   compaction-seam subscriber per process (factory re-runs replace it).
 * - Hoisting: goalUi/continuationLoop receive pauseActiveGoal/syncGoalTools
 *   as hoisted function references; the createGoalCommands/registerGoalTools
 *   deps objects wrap them as arrows so the data flow stays explicit.
 * - runningGoalId is factory state passed to the tools as a live getter.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { notify as uiNotify } from "../ui/notify.ts";
import { isSubagentChildProcess } from "../modes/permission-forwarding.ts";
import { coreBus } from "../bus.ts";
import { registerCompactionSubscriber } from "../../lib/compaction-seam.ts";

import { footerStatus, truncateText, displayObjectiveTitle, pauseReasonLabel } from "./goal-core.ts";
import { renderGoalAuditEvent, renderGoalEvent, type GoalAuditEventDetails } from "./renderers.ts";
import { registerQuestionnaireTools } from "./goal-questionnaire.ts";
import { ACTIVE_GOAL_TOOL_NAMES, CREATE_GOAL_TOOL_NAME, PROPOSE_DRAFT_TOOL_NAME, QUESTIONNAIRE_TOOL_NAME, QUESTION_TOOL_NAME, SISYPHUS_STEP_TOOL_NAME, lifecycleToolNamesForGoalStatus, TWEAK_APPLY_TOOL_NAME } from "./goal-tool-names.ts";
import { asRecord, cloneGoal, goalFocusDetails, normalizeGoalRecord, normalizeGoalFocusEntry, nowIso, type AssistantMessageLike, type GoalFocusEntry, type GoalFocusReason, type GoalCreationConfig, type GoalEventDetails, type GoalRecord, type GoalUsage } from "./goal-record.ts";
import { createGoalAccounting } from "./goal-accounting.ts";
import { appendGoalEvent, latestAuditorResultForGoal, readGoalLedger } from "./goal-ledger.ts";
import { buildCompactionSummary } from "./goal-compaction.ts";
import { archiveGoalFile, mergeGoalPromptFromDisk, readActiveGoalPool, sanitizeGoalPaths, writeActiveGoalFile } from "./storage/goal-files.ts";
import { openGoalsFromPool, otherOpenGoalCount } from "./goal-pool.ts";
import { auditorRejectionBlock, continuationPrompt, goalPrompt, staleContinuationPrompt, unfocusedOpenGoalsPrompt, untrustedObjectiveBlock } from "./prompts/goal-prompts.ts";
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


/**
 * BH-R1 (spec 2026-11-14-backtest-hardening): provider-error continuation
 * guard. A run whose last assistant message ended stopReason "error" used to
 * re-queue the sisyphus loop unconditionally (backtest: 2,241 errors / 13h /
 * 111M tokens on one session). The per-goal in-memory counter below pauses the
 * goal through the lifecycle pause verb after this many CONSECUTIVE error
 * terminations; any non-error termination resets it.
 */
const CONTINUATION_ERROR_PAUSE_THRESHOLD = 2;
const PROVIDER_ERROR_PAUSE_PREFIX = "provider error: ";
const PROVIDER_ERROR_PAUSE_ACTION = "Check the model provider or quota (rate limit / credits), then run /goal resume to continue.";


// ---------- extension entry point ----------

// SC §5.9 W5: exactly one live seam registration per process — a factory
// re-run (pi /reload, repeated test instantiation) replaces the previous
// subscriber instead of stacking a stale-closure duplicate.
let unregisterGoalSeam: (() => void) | undefined;

export default function goalExtension(pi: ExtensionAPI, deps: { now?: () => number; auditor?: typeof runGoalCompletionAuditor } = {}): void {
	// P2-2 Steps 1-4: the goal POOL and FOCUS pointer are owned by the
	// lifecycle module (goal-lifecycle.ts) — the writer verbs with their full
	// effect sets live there. Reads go through lifecycle.focused() /
	// lifecycle.pool; the B3 isolation note still applies: all of it lives
	// inside the factory.
	// P2-2 Step 3: the drafting intents, per-turn flags, and get_goal nudge
	// counters also live in the lifecycle — read through its read-only
	// projections, written ONLY through the closed event entry handle().
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
			// BH-E1: every lifecycle persist funnels through this port — it is
			// the single place the usage baseline can be refreshed.
			notePersistedUsage(goal);
		},
		beginClock: () => beginAccounting(),
	});

	// B7 step 3: the approved-audit hold lives in the audit domain module.
	const pendingAchievement = createPendingAchievementSlot();
	// P2-2 Step 4 + C5 follow-up: reads go through lifecycle.focused() /
	// lifecycle.pool (defensive copies), transitions and record refreshes
	// through business verbs and the closed event entry only — the adapter
	// holds no second write authority into the owned state.
	// DC4b part-3: the presentation half lives in ./ui.ts — closed-over
	// business state enters as getters, so the state machine stays fakeable.
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
				// probe failure = treat as busy: never claim Escape then
				return false;
			}
		},
		pauseActiveGoal,
	});
	let runningGoalId: string | null = null;

	// #5 post-compaction resync: when a compaction just happened, the next agent
	// turn gets an extra reminder block. Set in session_compact, consumed
	// (cleared) in before_agent_start.
	let postCompactReminderPending = false;

	// SC §5.9 (W5): ctx for the compaction-seam callbacks (boundary-draft
	// commits fire no pi event, so no event ctx arrives with them). Captured
	// at session_start; see the seam subscription near the compaction hooks.
	let seamCtx: ExtensionContext | undefined;

	// AR1005-GO-A: the activity clock owns the segment start and per-goal
	// millisecond remainders (sub-second fragments are no longer lost per
	// settle). Injectable clock seam for tests; production is monotonic.
	const clock = createGoalAccounting({ now: deps.now });

	// P3-1 S6: draftingHiddenWorkTools deleted (zero references).
	const goalExecutionWorkTools = ["read", "bash", "edit", "write"] as const;

	function syncGoalTools(): void {
		try {
			const active = new Set(pi.getActiveTools());
			for (const name of goalExecutionWorkTools) active.add(name);
			active.delete(QUESTION_TOOL_NAME);
			active.delete(QUESTIONNAIRE_TOOL_NAME);
			for (const name of ACTIVE_GOAL_TOOL_NAMES) active.delete(name);
			const phase = lifecycle.confirmationIntent !== null ? "drafting" : lifecycle.tweakDraftingFor !== null ? "tweakDrafting" : "normal";
			const lifecycleTools = lifecycleToolNamesForGoalStatus(lifecycle.focused()?.status, phase);
			for (const name of lifecycleTools) active.add(name);
			// Sisyphus is now a prompt/criteria style, not a separate step-counter
			// mechanism. Keep step_complete registered for legacy transcripts, but do
			// not expose it as an active work tool.
			active.delete(SISYPHUS_STEP_TOOL_NAME);
			// apply_goal_tweak is only available during a /goal-tweak drafting flow.
			// Note: tweak drafting can run against active OR paused goals.
			const tweakGateGoal = lifecycle.focused();
			if (tweakGateGoal && lifecycle.tweakDraftingFor === tweakGateGoal.id) {
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
			if (lifecycle.confirmationIntent !== null) {
				active.add(QUESTION_TOOL_NAME);
				active.add(QUESTIONNAIRE_TOOL_NAME);
			} else if (lifecycle.focused()?.status === "active") {
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


	function openGoals(): GoalRecord[] {
		return openGoalsFromPool(lifecycle.pool);
	}

	function reconcileFocusedGoalFromDisk(ctx: ExtensionContext, opts: { preserveMemoryUsage?: boolean; captureDiskGoal?: { goal: GoalRecord | null } } = {}): boolean {
		// GH-02 (continued): children never reconcile from the project's disk
		// pool — the env guard stays adapter-side; the pool/focus repair
		// itself is the lifecycle reconcileFromDisk verb (P2-2 Step 4).
		if (isSubagentChildProcess()) return true;
		// BH-E1: usage persists at three points only, so between persists the
		// IN-MEMORY usage is the live authority (it may hold an un-flushed run
		// delta). Every disk re-adoption preserves it via the max-merge — a
		// mid-run tool/command reconcile can no longer clobber the delta.
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
		// GO-A: begin starts a NEW segment (resets the segment start) without
		// deleting this goal's accumulated carry.
		clock.begin(clockGoal.id);
	}

	function goalForDisplay(): GoalRecord | null {
		const display = lifecycle.focused();
		if (!display || display.status !== "active") {
			return display;
		}
		// GO-A: read-only preview (segment + carry) — repeated renders never
		// consume or accumulate seconds.
		const liveSeconds = clock.preview(display.id);
		if (liveSeconds === 0) return display;
		const live = cloneGoal(display);
		live.usage.activeSeconds += liveSeconds;
		return live;
	}

	/** Accounted progress: parent assistant requests (turn_end) plus
	 * tool_result-reported execution usage (subagents, codemode model calls).
	 * Accepted residuals, verified 2026-10-03 by transcript forensics: a ~1%
	 * event-timing gap between turn_end accounting and session-recorded usage
	 * (74,482 of 6.55M on the pi-1.0 goal), and any consumption after the
	 * goal archives (auditor runs, post-completion turns). Neither is fixed.
	 *
	 * BH-E1 (spec 2026-11-14-backtest-hardening): usage events are IN-MEMORY
	 * ONLY — no pi-goal-state entry, no md rewrite, no disk rescan (the old
	 * per-event reconcile+persist appended a full snapshot per event; 98.8%
	 * of persisted entries differed only in usage/updatedAt). Usage reaches
	 * disk at exactly three points: each agent_end flush (only when the
	 * in-memory usage differs from the last persisted snapshot),
	 * session_shutdown, and any real state transition (transitions persist
	 * immediately and carry the latest usage because applyUsage already
	 * updated memory). External disk edits are observed at the next
	 * reconciling event (run boundaries, commands) instead of per usage
	 * event. */
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
		// GO-A: settle closes the segment delta and re-arms it; the sub-second
		// remainder stays as the goal's carry (never reset, even on
		// zero-token/zero-cost events). null = no active segment, begin one.
		const settled = clock.settle(settleGoal.id);
		if (settled === null) {
			beginAccounting();
			return;
		}
		const elapsedSeconds = settled;

		const tokens = Math.max(0, Math.trunc(opts.completedTurnTokens ?? 0));
		const cost = Math.max(0, opts.completedTurnCost ?? 0);
		if (tokens === 0 && cost === 0 && elapsedSeconds === 0) return;

		// C5 follow-up: the accounting result adoption is the applyUsage verb
		// (clone + delta + updatedAt stamp, in-memory only under BH-E1 — the
		// persist legs are the three flush points).
		lifecycle.applyUsage({ tokens, cost, seconds: elapsedSeconds });
		updateUI(ctx);
	}

	// BH-E1: "usage changed since the last persist" baseline. EVERY lifecycle
	// persist funnels through the appendStateEntry port, so updating the
	// baseline there covers transition persists, the agent_end flush,
	// shutdown, and the display-refresh append alike.
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
		// P2-BUS-01: goal channel on the capability bus (frozen snapshot).
		// DC4/DC4b: the widget field is presentation-complete — focus,
		// status-line text, a serializable goal projection, and the open
		// count, enough to rebuild renderGoalWidgetLines anywhere.
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
		// bus publish is unconditional per branch (review #10 + DC4): every
		// path below publishes exactly once, now carrying widget state, so
		// headless sessions reach process-external readers the same way.
		if (!ctx.hasUI) {
			// headless: still publish the channel (widget-less, goal facts only)
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
		// GH-02 (spec 2026-10-01-goal-hijack-fix): subagent child sessions share
		// the project cwd — and therefore the disk goal pool. Adopting it here
		// arms a continuation timer whose <pi_goal_continuation> message occupies
		// the child's agent loop before the dispatched task prompt can be
		// delivered ("already processing" spawn failures). Children never
		// participate in the goal lifecycle (the childSession flag the restore
		// verb consumes).
		const childSession = isSubagentChildProcess();
		// The adapter scans the session entries (external event wiring) and
		// sanitizes the legacy record; pool replacement, focus resolution,
		// complete-record cleanup, and the runtime clears are the restore verb.
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
		// BH-E1: after a restore the disk record IS the persisted truth — seed
		// the usage baseline so the first agent_end only flushes real deltas.
		notePersistedUsage(lifecycle.focused());
		runningGoalId = null;
	}

	function pauseActiveGoal(ctx: ExtensionContext, note?: string): void {
		const current = lifecycle.focused();
		if (!current || current.status !== "active") return;
		// User-initiated pause (Esc / aborted turn). Clear any stale AGENT pause
		// reason; a /goal-pause note becomes the user-labeled pause reason
		// (shown to the agent in the paused system prompt, cleared on resume).
		// C5 follow-up: merge → stamp paused("user") + note → setGoal → pause
		// ledger → nudge reset is the lifecycle pause verb.
		const userNote = note?.trim();
		lifecycle.pause(ctx, { note: userNote });
		uiNotify(ctx, userNote ? "Goal paused (note attached)." : "Goal paused.", "info");
	}

	// BH-R1: per-goal in-memory consecutive-error counter for the continuation
	// decision point (agent_end). Never persisted — it counts a live failure
	// streak; a session restart or a resume intentionally starts fresh.
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
		// toast embeds the RAW error text — the "provider error: " prefix is
		// already in the sentence (pauseReason itself keeps the prefix)
		uiNotify(ctx, `Goal paused after ${CONTINUATION_ERROR_PAUSE_THRESHOLD} consecutive provider errors: ${truncateText(errorText, 160)}`, "warning");
		return true;
	}

	function queueContinuation(ctx: ExtensionContext, force = false): void {
		continuationLoop.queue(ctx, force);
	}

	function replaceGoal(config: GoalCreationConfig, ctx: ExtensionContext, startNow = true): void {
		// P2-2 Step 4: the create verb owns create+focus+clock+nudge+intent
		// clear+ledger; presentation (notify) and continuation (queue) stay.
		lifecycle.create(config, ctx);
		uiNotify(ctx, buildGoalRunningNotification(config), "info");
		if (startNow && lifecycle.focused()?.autoContinue) queueContinuation(ctx, true);
	}


	pi.registerMessageRenderer<GoalEventDetails>(GOAL_EVENT_ENTRY, renderGoalEvent);
	pi.registerMessageRenderer<GoalAuditEventDetails>(GOAL_AUDIT_ENTRY, renderGoalAuditEvent);

	// SPEC SR E13a: the sixteen command registrations + handler helpers moved
	// verbatim into goal-commands.ts (order pinned by the registration-order
	// test). Deps wrap the hoisted factory functions as arrows; the BH-R1
	// error-streak Map and the pending resume note stay owned here.
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



	registerQuestionnaireTools(pi);

	// SPEC SR E13a: the eight goal tool registrations moved verbatim into
	// goal-tools.ts (order pinned by the registration-order test).
	// getRunningGoalId is a live getter — runningGoalId is mutated per run.
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
		// View-only audit events (started/passed/rejected/approved with
		// details.viewOnly) are display-only: their conclusion already reached
		// the model through the update_goal tool result, so drop them from
		// model requests entirely — otherwise the auditor report is injected
		// twice and can bait the model into answering it again.
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
		// Per-turn flag resets (#4 + C9 fix) — Step 3: through the closed
		// event entry (the flags live in the lifecycle).
		lifecycle.handle({ tag: "turn-start" });
		beginAccounting();
		updateUI(ctx);
	});

	// #4 + C9 fix + Phase 5 C3: gate in-turn tool calls based on lifecycle state.
	pi.on("tool_call", async (event) => {
		// P2-2 Step 3: the post-stop block verdict, the get_goal nudge
		// counting, and the meaningful-progress credit all live behind the
		// lifecycle's closed tool-call event (D3=A: non-progress tools are
		// progress-neutral — allowed, no credit, no lock; the G3
		// `event.input` read is the lifecycle's isMeaningfulProgressToolCall).
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
		// If the assistant ended a turn without queuing more tool calls, push a continuation right away.
		// #4: only queue if some real work was done this turn — otherwise the model is
		// just chatting and we should not keep firing turns on noise.
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

	// Flush the held "Goal achieved" marker after the agent loop has fully
	// settled. Flushing at turn_end appended the custom message while the
	// loop was still streaming; pi then flushed it into agent state, and
	// since custom messages map to user-role LLM content, the loop treated
	// it as an unanswered user message and ran ANOTHER turn (the model then
	// "answered" the marker). One macrotask after agent_settled, isStreaming
	// is false and the append is display-only.
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
		// Drafting injections stay visible (compact "Goal <topic>" line);
		// checkpoint/continuation events remain hidden.
		const kind = asRecord(raw?.details)?.kind;
		if (raw?.role === "custom" && raw.customType === GOAL_EVENT_ENTRY && raw.display !== false && kind !== "drafting") {
			return { message: { ...event.message, display: false } as typeof event.message };
		}
	});

	pi.on("session_start", async (event, ctx) => {
		// SC §5.9 (W5): boundary-draft commits never emit session_compact (H3),
		// so the compaction seam callbacks need a live ctx — compaction can only
		// happen inside a session, so this capture always precedes them.
		seamCtx = ctx;
		loadState(ctx);
		// Widget order fix: remount on every session start so the goal block
		// registers ahead of cc-status's microtask re-registration (goal
		// above the spinner row) and survives session-invalidated TUI maps.
		if (ctx.hasUI) goalUi.remountWidget(ctx);
		goalUi.syncTerminalInputPause(ctx);
		if (event.reason === "resume" && !lifecycle.focused() && openGoals().length > 1 && ctx.hasUI) {
			await focusGoalCommand(ctx);
		}
		// Codex behavior: prompt before reactivating a paused goal on resume.
		if (event.reason === "resume" && lifecycle.focused()?.status === "paused" && ctx.hasUI) {
			const current = lifecycle.focused()!;
			const shouldResume = await ctx.ui.confirm("Resume paused goal?", `Goal: ${current.objective}`);
			// C5 follow-up: the session-resume confirmation's inline
			// activation (no merge, no goal_resumed ledger — historical
			// shape) is the activate verb.
			if (shouldResume) lifecycle.activate(ctx);
		}
		beginAccounting();
		queueContinuation(ctx, true);
	});

	// Compaction reactions (SC §5.9, W5): one named pair, driven BOTH by the
	// native pi events and by the boundary-draft seam — native path behavior
	// is byte-identical to the previous inline handlers (SM-05).
	const onCompactionBefore = (ctx: ExtensionContext): void => {
		lifecycle.handle({ tag: "usage-accounted" });
		accountProgress(ctx);
	};

	const onCompactionAfter = (ctx: ExtensionContext, midRun: boolean): void => {
		if (lifecycle.isDrafting) return;
		if (lifecycle.focused()) persist(ctx);
		beginAccounting();
		// Arm a deterministic compaction summary for the next agent turn.
		// This replaces the generic reminder with artifact-backed state.
		if (shouldArmPostCompactReminder(lifecycle.focused())) {
			postCompactReminderPending = true;
		}
		// SM-03 (§5.9a goal row): a mid-run draft commit must NOT queue a
		// continuation — the run is still going, a queued continuation would
		// produce a surplus turn. Native session_compact is always midRun:false.
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
		// pi 1.2.0: before_agent_start is a union on messageType — custom-message
		// runs (sendMessage triggerTurn:true: continuations, directives) carry no
		// `prompt`; only user runs do. Empty text is inert for the marker regexes
		// (no DRAFTING/TWEAK/continuation markers can match), so custom runs fall
		// through to the non-goal branch exactly as a plain user message does.
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

		// If this turn was triggered by a hidden goal checkpoint that no longer
		// matches the active goal, abort the whole turn instead of letting the
		// model act on a stale instruction.
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
			// A user-driven turn — clear any queued continuation so we don't
			// double-fire after the user's own message returns. Also reset the
			// autoContinue nudge state so the user always gets a fresh chain.
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
				// BH-R1: automatic provider-error pause — neither the user nor
				// the agent set this; say so instead of the /goal-pause wording.
				pauseExtras.push("");
				pauseExtras.push(`Pause reason (automatic): the goal was paused after consecutive provider errors: ${current.pauseReason.slice(PROVIDER_ERROR_PAUSE_PREFIX.length)}`);
				if (current.pauseSuggestedAction) pauseExtras.push(`Suggested: ${current.pauseSuggestedAction}`);
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
		const activeGoalNarrowed = lifecycle.focused();
		if (!activeGoalNarrowed || activeGoalNarrowed.status === "complete") return;
		const activeGoal = activeGoalNarrowed;
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
		if ((aborted.tokens > 0 || aborted.cost > 0) && endedGoalId && lifecycle.focused()?.id === endedGoalId) {
			accountProgress(ctx, { completedTurnTokens: aborted.tokens, completedTurnCost: aborted.cost });
		}

		continuationLoop.clearQueued();
		// BH-E1: ONE run-boundary disk sync serves the usage flush AND the
		// continuation gates (replaces the per-usage-event rescan). External
		// edits and deletions are observed here instead of per event; the
		// parsed focused disk goal feeds the flush's prompt merge (GO-B).
		const readCtx: { goal: GoalRecord | null } = { goal: null };
		const reconciled = reconcileFocusedGoalFromDisk(ctx, { captureDiskGoal: readCtx });
		// BH-E1: per-run usage flush — at most ONE usage-related entry per run,
		// and only when the in-memory usage differs from the last persist.
		persistUsageIfChanged(ctx, readCtx);
		const endGoal = lifecycle.focused();
		if (!endGoal || endGoal.status !== "active" || !endGoal.autoContinue) return;
		if (endedGoalId && endGoal.id !== endedGoalId) return;
		if (!reconciled) return;
		if (hasAbortedAssistantMessage(event.messages) || ctx.signal?.aborted) {
			pauseActiveGoal(ctx);
			return;
		}
		// BH-R1: provider-error guard at the continuation decision point — two
		// consecutive error terminations pause the goal instead of re-queueing.
		if (maybePauseOnProviderError(ctx, event.messages)) return;
		// BH-E1: the trailing per-run persist is gone — the flush above already
		// carried the run's usage; persisting again here appended a second
		// entry with identical usage on every run.
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
