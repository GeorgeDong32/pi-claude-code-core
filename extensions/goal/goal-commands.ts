/**
 * goal-commands.ts — the sixteen /goal* command registrations plus their
 * handler helpers (SPEC SR E13a: split from goal.ts; registration ORDER is
 * pinned by extensions/goal/tests/goal-registration-order.test.ts).
 *
 * Spec IDs: P2-2 (lifecycle verbs only — no direct record writes), C5
 * follow-up, BH-R1 (resume resets the error streak via resetErrorStreak),
 * goal-notes (resume note / standing note), CORE-05 (draft-cancel on failed
 * draft start).
 *
 * Design decisions:
 * - createGoalCommands(pi, deps) receives session state through a narrow
 *   structural deps object (lifecycle typed as GoalLifecycle — #120
 *   encapsulation); handlers stay verbatim, so deps names mirror the old
 *   closure names.
 * - pendingResumeNote writes go through setPendingResumeNote; the BH-R1
 *   error-streak Map delete goes through resetErrorStreak — both stay
 *   owned by goal.ts.
 * - focusGoalCommand is returned because session_start reuses it for the
 *   resume focus prompt.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { notify as uiNotify } from "../ui/notify.ts";
import { oneLineSummary, truncateText } from "./goal-core.ts";
import { buildGoalListText, buildUnfocusedOpenGoalsSummary, goalSelectorLabel, otherOpenGoalCount } from "./goal-pool.ts";
import type { DraftingFocus, GoalCreationConfig, GoalEventDetails, GoalRecord } from "./goal-record.ts";
import {
	abortGoalCommandMessage,
	clearGoalCommandMessage,
	validateResumeGoal,
} from "./goal-policy.ts";
import { goalDraftingPrompt } from "./goal-draft.ts";
import { goalTweakDraftingPrompt } from "./prompts/goal-prompts.ts";
import { GOAL_EVENT_ENTRY } from "./goal-entries.ts";
import { detailedSummary } from "./goal-summary.ts";
import type { GoalLifecycle } from "./goal-lifecycle.ts";
import { handleGoalSettings } from "./goal-settings.ts";

export interface GoalCommandsDeps {
	lifecycle: GoalLifecycle;
	reconcileFocusedGoalFromDisk: (ctx: ExtensionContext, opts?: { preserveMemoryUsage?: boolean; captureDiskGoal?: { goal: GoalRecord | null } }) => boolean;
	syncGoalPromptFromDisk: (ctx: ExtensionContext, readCtx?: { goal: GoalRecord | null }) => boolean;
	persist: (ctx?: ExtensionContext, readCtx?: { goal: GoalRecord | null }) => void;
	syncGoalTools: () => void;
	updateUI: (ctx: ExtensionContext) => void;
	openGoals: () => GoalRecord[];
	goalForDisplay: () => GoalRecord | null;
	clearContinuationState: () => void;
	clearActiveAccounting: () => void;
	armFocusedContinuation: (ctx: ExtensionContext) => void;
	queueContinuation: (ctx: ExtensionContext, force?: boolean) => void;
	replaceGoal: (config: GoalCreationConfig, ctx: ExtensionContext, startNow?: boolean) => void;
	pauseActiveGoal: (ctx: ExtensionContext, note?: string) => void;
	setPendingResumeNote: (note: string | null) => void;
	resetErrorStreak: (goalId: string) => void;
}

export function createGoalCommands(pi: ExtensionAPI, deps: GoalCommandsDeps): { focusGoalCommand: (ctx: ExtensionContext) => Promise<void> } {
	const {
		lifecycle,
		reconcileFocusedGoalFromDisk,
		syncGoalPromptFromDisk,
		persist,
		syncGoalTools,
		updateUI,
		openGoals,
		goalForDisplay,
		clearContinuationState,
		clearActiveAccounting,
		armFocusedContinuation,
		queueContinuation,
		replaceGoal,
		pauseActiveGoal,
		setPendingResumeNote,
		resetErrorStreak,
	} = deps;

async function startGoalTweakDrafting(hint: string, ctx: ExtensionContext): Promise<void> {
	reconcileFocusedGoalFromDisk(ctx);
	clearContinuationState();
	clearActiveAccounting();
	if (!lifecycle.focused()) {
		if (openGoals().length > 0) {
			const selected = await chooseOpenGoal(ctx, "Tweak which open goal?");
			if (!selected) return;
		} else {
			uiNotify(ctx, "No goal is set. Use /goals or /sisyphus to discuss, or /goals-set / /sisyphus-set to start immediately.", "warning");
			return;
		}
	}
	const currentGoal = lifecycle.focused();
	if (!currentGoal) return;
	if (currentGoal.status === "complete") {
		uiNotify(ctx, "Goal is complete. Use /goals to discuss a new one or /goals-set to start immediately.", "warning");
		return;
	}
	syncGoalPromptFromDisk(ctx);
	persist(ctx);
	const trimmed = hint.trim();
	const focused = lifecycle.focused();
	if (!focused) return;
	const sisyphusOn = focused.sisyphus;
	const label = sisyphusOn ? "Sisyphus tweak drafting" : "Goal tweak drafting";
	// Activate the tweak edit-gate so apply_goal_tweak is callable.
	lifecycle.handle({ tag: "draft-start", kind: "tweak", goalId: focused.id });
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
		lifecycle.handle({ tag: "draft-cancel", kind: "tweak" });
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

	lifecycle.handle({ tag: "draft-start", kind: "goal", focus, topic: trimmed, startedAt: Date.now() });
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
		// CORE-05 (spec 2026-10-07 P0-2): a failed draft start must reset
		// the drafting gate — same shape as the tweak path's catch — or the
		// tool set stays in drafting form and accounting/turn handlers
		// keep early-returning for a draft that never started.
		lifecycle.handle({ tag: "draft-cancel", kind: "goal" });
		syncGoalTools();
		uiNotify(ctx, `Could not start ${label.toLowerCase()}: ${(err as Error).message}`, "error");
	}
}

async function chooseOpenGoal(ctx: ExtensionContext, title: string): Promise<GoalRecord | null> {
	reconcileFocusedGoalFromDisk(ctx);
	const chooseCurrent = lifecycle.focused();
	if (chooseCurrent && chooseCurrent.status !== "complete") return chooseCurrent;
	const open = openGoals();
	if (open.length === 0) return null;
	if (open.length === 1) {
		const only = open[0];
		if (!only) return null;
		lifecycle.focus(only.id, ctx, "selected");
		return lifecycle.focused();
	}
	if (!ctx.hasUI) {
		uiNotify(ctx, buildUnfocusedOpenGoalsSummary(open.length), "warning");
		return null;
	}
	const labels = open.map((item) => goalSelectorLabel(item, lifecycle.focusedId));
	const byLabel = new Map(labels.map((label, index) => [label, open[index]?.id]));
	const selected = await ctx.ui.select(title, labels);
	const selectedId = selected ? byLabel.get(selected) : undefined;
	if (!selectedId) {
		uiNotify(ctx, "Goal focus unchanged.", "info");
		return null;
	}
	lifecycle.focus(selectedId, ctx, "selected");
	return lifecycle.focused();
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
		lifecycle.focus(only.id, ctx, "selected");
		armFocusedContinuation(ctx);
		uiNotify(ctx, `Focused goal: ${oneLineSummary(only)}`, "info");
		return;
	}
	if (!ctx.hasUI) {
		uiNotify(ctx, buildGoalListText(lifecycle.pool, lifecycle.focusedId), "info");
		return;
	}
	const labels = open.map((item) => goalSelectorLabel(item, lifecycle.focusedId));
	const byLabel = new Map(labels.map((label, index) => [label, open[index]?.id]));
	const selected = await ctx.ui.select("Focus open goal", labels);
	const selectedId = selected ? byLabel.get(selected) : undefined;
	if (!selectedId) {
		uiNotify(ctx, "Goal focus unchanged.", "info");
		return;
	}
	lifecycle.focus(selectedId, ctx, "selected");
	armFocusedContinuation(ctx);
	uiNotify(ctx, `Focused goal: ${oneLineSummary(lifecycle.focused())}`, "info");
}

async function handleGoalCommandTopic(rawTopic: string, ctx: ExtensionContext, focus: DraftingFocus, opts: { replace: boolean }): Promise<void> {
	const topic = rawTopic.trim();
	if (opts.replace) {
		const replacementTarget = await chooseOpenGoal(ctx, "Replace which open goal?");
		if (openGoals().length > 0 && !replacementTarget) return;
		// C5 follow-up: the archive+clear combo (no goal_aborted ledger —
		// historical boundary #119⑤) is the retireForReplacement verb.
		lifecycle.retireForReplacement(ctx);
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
	lifecycle.handle({ tag: "draft-applied", kind: "goal" });
	syncGoalTools();
	replaceGoal({ objective, autoContinue: true, sisyphus: focus === "sisyphus" }, ctx, true);
}

async function showGoalStatus(ctx: ExtensionContext): Promise<void> {
	reconcileFocusedGoalFromDisk(ctx);
	if (lifecycle.focused()) syncGoalPromptFromDisk(ctx);
	const view = goalForDisplay() ?? lifecycle.focused();
	const otherCount = otherOpenGoalCount(lifecycle.pool, lifecycle.focusedId);
	const extra = view && otherCount > 0 ? `\nOther open goals: ${otherCount} (run /goal-list or /goal-focus)` : "";
	const text = view ? `${detailedSummary(view)}${extra}` : openGoals().length > 0 ? buildUnfocusedOpenGoalsSummary(openGoals().length) : detailedSummary(null);
	uiNotify(ctx, text, "info");
	updateUI(ctx);
}

async function handleGoalPause(ctx: ExtensionContext, rawNote?: string): Promise<void> {
	reconcileFocusedGoalFromDisk(ctx);
	if (!lifecycle.focused()) {
		if (openGoals().length > 0) {
			const selected = await chooseOpenGoal(ctx, "Pause which open goal?");
			if (!selected) return;
		} else {
			uiNotify(ctx, "No goal is set.", "warning");
			return;
		}
	}
	const currentGoal = lifecycle.focused();
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
	if (!lifecycle.focused() && openGoals().length > 0) {
		const selected = await chooseOpenGoal(ctx, "Resume or focus open goal");
		if (!selected) return;
		if (selected.status === "active") {
			armFocusedContinuation(ctx);
			uiNotify(ctx, `Goal focused: ${oneLineSummary(selected)}`, "info");
			return;
		}
	}
	const resumeGate = validateResumeGoal(lifecycle.focused());
	if (!resumeGate.ok) {
		const level = resumeGate.message.includes("already running") ? "info" : "warning";
		uiNotify(ctx, resumeGate.message, level);
		return;
	}
	const resumeTarget = lifecycle.focused();
	if (!resumeTarget) throw new Error("Goal disappeared during resume validation.");
	// BH-R1: a deliberate resume starts a fresh failure streak — the
	// pre-pause error count must not pause the very next erroring run.
	resetErrorStreak(resumeTarget.id);
	// C5 follow-up: stamp active + setGoal + clock + nudge + ledger is the
	// resume verb (reads the owned record internally); the resume note and
	// continuation queue stay here.
	lifecycle.resume(ctx);
	const note = rawNote?.trim() || null;
	setPendingResumeNote(note);
	uiNotify(ctx, note ? "Goal resumed (note attached to the next checkpoint)." : "Goal resumed.", "info");
	queueContinuation(ctx, true);
}
async function handleGoalClear(ctx: ExtensionContext, rawNote?: string): Promise<void> {
	if (lifecycle.isDrafting) {
		lifecycle.handle({ tag: "draft-cancel" });
		syncGoalTools();
		updateUI(ctx);
		uiNotify(ctx, clearGoalCommandMessage({ archived: false, wasDrafting: true }), "info");
		return;
	}
	reconcileFocusedGoalFromDisk(ctx);
	if (!lifecycle.focused() && openGoals().length > 0) {
		const selected = await chooseOpenGoal(ctx, "Clear which open goal?");
		if (!selected) return;
	}
	// P2-2 Step 2: archive + user-termination ledger + nudge reset +
	// unfocus persist as ONE lifecycle verb (the old inline sequence).
	const report = lifecycle.terminate("clear", ctx, { note: rawNote });
	const didArchive = !!report.record;
	// Phase 5 D: also abort any in-flight drafting so the agent's next turn
	// doesn't try to propose into a cleared slot.
	const wasDrafting = lifecycle.confirmationIntent !== null;
	lifecycle.handle({ tag: "draft-applied", kind: "goal" });
	syncGoalTools();
	const msg = clearGoalCommandMessage({ archived: didArchive, wasDrafting });
	uiNotify(ctx, msg, didArchive || wasDrafting ? "info" : "warning");
}

async function handleGoalAbort(ctx: ExtensionContext, rawNote?: string): Promise<void> {
	if (lifecycle.isDrafting) {
		lifecycle.handle({ tag: "draft-cancel" });
		syncGoalTools();
		updateUI(ctx);
		uiNotify(ctx, abortGoalCommandMessage({ archived: false, wasDrafting: true }), "info");
		return;
	}
	reconcileFocusedGoalFromDisk(ctx);
	if (!lifecycle.focused() && openGoals().length > 0) {
		const selected = await chooseOpenGoal(ctx, "Abort which open goal?");
		if (!selected) return;
	}
	const report = lifecycle.terminate("abort", ctx, { note: rawNote });
	const didArchive = !!report.record;
	const wasDrafting = lifecycle.confirmationIntent !== null;
	lifecycle.handle({ tag: "draft-applied", kind: "goal" });
	syncGoalTools();
	const msg = abortGoalCommandMessage({ archived: didArchive, wasDrafting });
	uiNotify(ctx, msg, didArchive || wasDrafting ? "info" : "warning");
}

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
		uiNotify(ctx, buildGoalListText(lifecycle.pool, lifecycle.focusedId), "info");
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

// goal-notes: audit trail for USER-initiated termination lived here; the
// append moved into the lifecycle terminate verb (P2-2 Step 2).

// /goal-note: attach or clear a STANDING user note that rides every goal
// and checkpoint prompt (goal-notes; consumed by prompts, never written
// by the agent). `/goal-note clear` (or empty on an existing note) clears.
pi.registerCommand("goal-note", {
	description: "Attach a standing user note to the active goal (/goal-note <text>) or clear it (/goal-note clear).",
	handler: async (rawArgs, ctx) => {
		reconcileFocusedGoalFromDisk(ctx);
		const noteGoal = lifecycle.focused();
		if (!noteGoal || noteGoal.status === "complete") {
			uiNotify(ctx, "No active goal to attach a note to.", "warning");
			return;
		}
		const arg = (typeof rawArgs === "string" ? rawArgs : "").trim();
		if (!arg || arg === "clear" || arg === "off") {
			if (!noteGoal.userNote) {
				uiNotify(ctx, "No user note set.", "info");
				return;
			}
			lifecycle.setUserNote(ctx, undefined);
			uiNotify(ctx, "User note cleared.", "info");
			return;
		}
		lifecycle.setUserNote(ctx, arg);
		uiNotify(ctx, `User note set: ${truncateText(arg, 80)}`, "info");
	},
});

	return { focusGoalCommand };
}
