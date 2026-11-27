import { asRecord, cloneGoal, createGoal, type DraftingFocus, type GoalCreationConfig, type GoalFocusEntry, type GoalRecord } from "./goal-record.ts";
import { buildAbortedByAgentGoal, buildPausedByAgentGoal } from "./goal-policy.ts";
import { mergeFocusedGoalWithDisk, resolveSessionFocus } from "./goal-pool.ts";
import { GOAL_PROGRESS_TOOL_NAMES, POST_STOP_ALLOWED_TOOLS } from "./goal-tool-names.ts";

export interface LifecycleCtx {
	cwd: string;
}

export type GoalFocusReason = import("./goal-record.ts").GoalFocusReason;
export type StopReason = import("./goal-record.ts").StopReason;

export interface GoalConfirmationIntent {
	focus: DraftingFocus;
	originalTopic: string;
	startedAt: number;
}

export type GoalLifecycleEvent =
	| { tag: "turn-start" }
	| { tag: "turn-stopped"; goalId: string | null }
	| { tag: "tool-call"; toolName: string; input: unknown }
	| { tag: "usage-accounted" }
	| { tag: "draft-start"; kind: "goal"; focus: DraftingFocus; topic: string; startedAt: number }
	| { tag: "draft-start"; kind: "tweak"; goalId: string }
	| { tag: "draft-cancel"; kind?: "goal" | "tweak" }
	| { tag: "draft-applied"; kind: "goal" | "tweak" }
	| { tag: "nudge-reset"; goalId: string | null | undefined }
	| { tag: "agent-settled" }
	| { tag: "dispose" };

export interface ToolCallVerdict {
	blocked: boolean;
	reason?: string;
}

export interface GoalLifecyclePorts {
	haltContinuation(): void;
	pauseClock(): void;
	forgetCarry(goalId: string): void;
	appendFocusEntry(goalId: string | null, reason: GoalFocusReason): void;
	appendLedger(ctx: LifecycleCtx, event: Record<string, unknown>): void;
	syncTools(): void;
	updateUI(ctx: LifecycleCtx): void;
	nowIso(): string;
	mergeGoalPromptFromDisk(ctx: LifecycleCtx, goal: GoalRecord): GoalRecord;
	archiveGoal(ctx: LifecycleCtx, goal: GoalRecord): GoalRecord;
	writeActiveGoalFile(ctx: LifecycleCtx, goal: GoalRecord): GoalRecord;
	readActiveGoalPool(ctx: LifecycleCtx): ReadonlyMap<string, GoalRecord>;
	appendStateEntry(goal: GoalRecord | null): void;
	beginClock(): void;
}

export interface TransitionReport {
	kind: "setGoal" | "focus" | "complete" | "terminate" | "create" | "pause" | "resume" | "activate" | "note" | "tweak" | "retire";
	previousGoalId: string | null;
	nextGoalId: string | null;
	record?: GoalRecord;
	effects: string[];
}

export interface GoalLifecycle {
	focused(): GoalRecord | null;
	readonly focusedId: string | null;
	readonly pool: ReadonlyMap<string, GoalRecord>;

	readonly confirmationIntent: GoalConfirmationIntent | null;
	readonly tweakDraftingFor: string | null;
	readonly isDrafting: boolean;
	readonly turnStoppedFor: string | null;
	readonly goalWorkToolCalledThisTurn: boolean;
	getGoalNudgeCount(goalId: string): number;

	handle(event: GoalLifecycleEvent): ToolCallVerdict | void;

	create(config: GoalCreationConfig, ctx: LifecycleCtx): TransitionReport;
	focus(goalId: string | null, ctx: LifecycleCtx, reason: GoalFocusReason): TransitionReport;
	unfocus(ctx: LifecycleCtx, reason: GoalFocusReason): TransitionReport;
	pause(ctx: LifecycleCtx, opts?: { note?: string; systemReason?: string; suggestedAction?: string }): TransitionReport;
	pauseByAgent(ctx: LifecycleCtx, opts: { reason: string; suggestedAction?: string }): TransitionReport;
	resume(ctx: LifecycleCtx): TransitionReport;
	activate(ctx: LifecycleCtx): TransitionReport;
	setUserNote(ctx: LifecycleCtx, note: string | undefined): TransitionReport;
	applyUsage(delta: { tokens: number; cost: number; seconds: number }): void;
	recordAuditAttempt(ctx: LifecycleCtx, attempt: number): void;
	applyTweak(ctx: LifecycleCtx, newObjective: string): TransitionReport;
	syncObjectiveFromDisk(ctx: LifecycleCtx, readCtx?: { goal: GoalRecord | null }): boolean;
	persistRecord(ctx?: LifecycleCtx, readCtx?: { goal: GoalRecord | null }): void;
	refreshDisplayFromDisk(ctx: LifecycleCtx): void;
	restore(ctx: LifecycleCtx, input: { childSession: boolean; focusEntry: GoalFocusEntry | null; legacyGoal: GoalRecord | null }): string | null;
	retireForReplacement(ctx: LifecycleCtx): TransitionReport;
	reconcileFromDisk(ctx: LifecycleCtx, opts?: {
		preserveMemoryUsage?: boolean;
		captureDiskGoal?: { goal: GoalRecord | null };
	}): boolean;
	complete(goal: GoalRecord, ctx: LifecycleCtx): TransitionReport;
	terminate(
		kind: "clear" | "abort",
		ctx: LifecycleCtx,
		opts?: { by?: "user" | "agent"; note?: string; reason?: string },
	): TransitionReport;
}

const GOAL_PROGRESS_TOOL_SET = new Set<string>(GOAL_PROGRESS_TOOL_NAMES);
const POST_STOP_ALLOWED_TOOL_SET = new Set<string>(POST_STOP_ALLOWED_TOOLS);

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

export function createGoalLifecycle(ports: GoalLifecyclePorts): GoalLifecycle {
	const goalsById = new Map<string, GoalRecord>();
	let focusedGoalId: string | null = null;
	let confirmationIntent: GoalConfirmationIntent | null = null;
	let tweakDraftingFor: string | null = null;
	let goalWorkToolCalledThisTurn = false;
	let turnStoppedFor: string | null = null;
	const activeGetGoalTurnsByGoalId = new Map<string, number>();

	function focusedRecord(): GoalRecord | null {
		if (!focusedGoalId) return null;
		return goalsById.get(focusedGoalId) ?? null;
	}

	function cloneOut(goal: GoalRecord): GoalRecord {
		return cloneGoal(goal);
	}

	function adoptInternal(next: GoalRecord | null): void {
		if (next) {
			goalsById.set(next.id, cloneGoal(next));
			focusedGoalId = next.id;
			return;
		}
		if (focusedGoalId) goalsById.delete(focusedGoalId);
		focusedGoalId = null;
	}

	function replacePoolInternal(fresh: ReadonlyMap<string, GoalRecord>): void {
		goalsById.clear();
		for (const [id, g] of fresh) goalsById.set(id, cloneGoal(g));
	}

	function setFocusedInternal(goalId: string | null): void {
		focusedGoalId = goalId && goalsById.has(goalId) ? goalId : null;
	}

	function removeFromPoolInternal(goalId: string): void {
		goalsById.delete(goalId);
		if (focusedGoalId === goalId) focusedGoalId = null;
	}

	function resetNudge(goalId: string | null | undefined): void {
		if (goalId) activeGetGoalTurnsByGoalId.delete(goalId);
	}

	function releaseStaleTweakGate(focusedId: string | null | undefined): void {
		if (tweakDraftingFor !== null && tweakDraftingFor !== focusedId) tweakDraftingFor = null;
	}

	function setGoalInternal(next: GoalRecord | null, ctx: LifecycleCtx, opts: { persist?: boolean; focusReason?: GoalFocusReason } = {}): TransitionReport {
		const shouldPersist = opts.persist !== false;
		const previousGoalId = focusedRecord()?.id ?? null;
		adoptInternal(next);
		const effects: string[] = [];
		const nowFocused = focusedRecord();
		const focusChanged = previousGoalId !== focusedGoalId;
		if (focusChanged) {
			ports.haltContinuation();
			ports.pauseClock();
			resetNudge(previousGoalId);
			resetNudge(focusedGoalId);
			effects.push("halt-continuation", "pause-clock", `nudge-reset:${previousGoalId ?? "-"}`, `nudge-reset:${focusedGoalId ?? "-"}`);
		}
		if (opts.focusReason && focusChanged) {
			ports.appendFocusEntry(focusedGoalId, opts.focusReason);
			effects.push(`focus-entry:${focusedGoalId ?? "-"}:${opts.focusReason}`);
		}
		if (!nowFocused || nowFocused.status !== "active" || !nowFocused.autoContinue) {
			ports.haltContinuation();
			effects.push("halt-continuation(inactive)");
		}
		if (!nowFocused || nowFocused.status === "paused" || nowFocused.status === "complete") {
			ports.pauseClock();
			effects.push("pause-clock(paused/complete/gone)");
		}
		if (previousGoalId && (!nowFocused || nowFocused.status === "complete")) {
			ports.forgetCarry(previousGoalId);
			effects.push(`forget-carry:${previousGoalId}`);
		}
		if (!nowFocused || nowFocused.id !== previousGoalId) {
			releaseStaleTweakGate(nowFocused?.id);
			effects.push("release-stale-tweak-gate");
		}
		if (shouldPersist) runPersistInternal(ctx);
		else ports.syncTools();
		ports.updateUI(ctx);
		effects.push(shouldPersist ? "persist" : "sync-tools", "update-ui");
		return { kind: "setGoal", previousGoalId, nextGoalId: focusedGoalId, effects };
	}

	function runPersistInternal(ctx?: LifecycleCtx, readCtx?: { goal: GoalRecord | null }): void {
		const current = focusedRecord();
		if (current) {
			adoptInternal({ ...current, updatedAt: ports.nowIso() });
			if (ctx) {
				syncObjectiveInternal(ctx, readCtx);
				const next = focusedRecord();
				if (next) adoptInternal(next.status === "complete" ? ports.archiveGoal(ctx, cloneOut(next)) : ports.writeActiveGoalFile(ctx, cloneOut(next)));
			}
		}
		ports.appendStateEntry(focusedRecord() ? cloneOut(focusedRecord()!) : null);
		ports.syncTools();
		if (ctx) ports.updateUI(ctx);
	}

	function syncObjectiveInternal(ctx: LifecycleCtx, readCtx?: { goal: GoalRecord | null }): boolean {
		const current = focusedRecord();
		if (!current || current.status === "complete") return false;
		const previousObjective = current.objective;
		if (readCtx) {
			if (readCtx.goal) adoptInternal({ ...current, objective: readCtx.goal.objective });
		} else {
			const merged = ports.mergeGoalPromptFromDisk(ctx, cloneOut(current));
			if (merged.objective !== current.objective) adoptInternal(merged);
		}
		return (focusedRecord()?.objective ?? previousObjective) !== previousObjective;
	}

	function handleEvent(event: GoalLifecycleEvent): ToolCallVerdict | void {
		switch (event.tag) {
			case "turn-start":
				goalWorkToolCalledThisTurn = false;
				turnStoppedFor = null;
				return;
			case "turn-stopped":
				turnStoppedFor = event.goalId;
				return;
			case "tool-call": {
				if (turnStoppedFor !== null && !POST_STOP_ALLOWED_TOOL_SET.has(event.toolName)) {
					return {
						blocked: true,
						reason: `The goal was already stopped earlier in this turn (goalId=${turnStoppedFor}). ` +
							`Do not call more tools; end the turn with a brief summary and yield to the user.`,
					};
				}
				const current = focusedRecord();
				if (confirmationIntent === null && tweakDraftingFor === null && current?.status === "active") {
					if (event.toolName === "get_goal") {
						activeGetGoalTurnsByGoalId.set(current.id, (activeGetGoalTurnsByGoalId.get(current.id) ?? 0) + 1);
					}
				}
				if (isMeaningfulProgressToolCall(event.toolName, event.input)) {
					if (current?.id) activeGetGoalTurnsByGoalId.delete(current.id);
					goalWorkToolCalledThisTurn = true;
				}
				return;
			}
			case "usage-accounted":
				return;
			case "draft-start":
				if (event.kind === "goal") {
					confirmationIntent = { focus: event.focus, originalTopic: event.topic, startedAt: event.startedAt };
				} else {
					tweakDraftingFor = event.goalId;
				}
				return;
			case "draft-cancel":
				if (!event.kind || event.kind === "goal") confirmationIntent = null;
				if (!event.kind || event.kind === "tweak") tweakDraftingFor = null;
				return;
			case "draft-applied":
				if (event.kind === "goal") confirmationIntent = null;
				else tweakDraftingFor = null;
				return;
			case "nudge-reset":
				resetNudge(event.goalId);
				return;
			case "agent-settled":
				return;
			case "dispose":
				confirmationIntent = null;
				tweakDraftingFor = null;
				goalWorkToolCalledThisTurn = false;
				turnStoppedFor = null;
				activeGetGoalTurnsByGoalId.clear();
				return;
		}
	}

	return {
		focused: () => {
			const g = focusedRecord();
			return g ? cloneOut(g) : null;
		},
		get focusedId() {
			return focusedGoalId;
		},
		get pool() {
			const copy = new Map<string, GoalRecord>();
			for (const [id, g] of goalsById) copy.set(id, cloneOut(g));
			return copy;
		},
		get confirmationIntent() {
			return confirmationIntent ? { ...confirmationIntent } : null;
		},
		get tweakDraftingFor() {
			return tweakDraftingFor;
		},
		get isDrafting() {
			return confirmationIntent !== null || tweakDraftingFor !== null;
		},
		get turnStoppedFor() {
			return turnStoppedFor;
		},
		get goalWorkToolCalledThisTurn() {
			return goalWorkToolCalledThisTurn;
		},
		getGoalNudgeCount(goalId: string): number {
			return activeGetGoalTurnsByGoalId.get(goalId) ?? 0;
		},

		handle: handleEvent,

		create(config, ctx) {
			const created = createGoal(config);
			const effects: string[] = [];
			const report = setGoalInternal(created, ctx, { focusReason: "created" });
			ports.beginClock();
			effects.push("begin-clock");
			resetNudge(created.id);
			effects.push(`nudge-reset:${created.id}`);
			handleEvent({ tag: "draft-applied", kind: "goal" });
			effects.push("draft-applied:goal");
			try {
				ports.appendLedger(ctx, {
					type: "goal_created",
					goalId: created.id,
					objective: created.objective,
					sisyphus: created.sisyphus,
					autoContinue: created.autoContinue,
					at: created.createdAt,
				});
				effects.push("ledger:goal_created");
			} catch {
			}
			return { ...report, kind: "create", effects: [...report.effects, ...effects] };
		},

		focus(goalId, ctx, reason) {
			const previousGoalId = focusedGoalId;
			setFocusedInternal(goalId);
			const effects: string[] = [];
			if (previousGoalId !== focusedGoalId) {
				ports.haltContinuation();
				ports.pauseClock();
				resetNudge(previousGoalId);
				resetNudge(focusedGoalId);
				releaseStaleTweakGate(focusedGoalId);
				effects.push("halt-continuation", "pause-clock", `nudge-reset:${previousGoalId ?? "-"}`, `nudge-reset:${focusedGoalId ?? "-"}`, "release-stale-tweak-gate");
			}
			ports.appendFocusEntry(focusedGoalId, reason);
			effects.push(`focus-entry:${focusedGoalId ?? "-"}:${reason}`);
			try {
				if (focusedGoalId) {
					ports.appendLedger(ctx, { type: "goal_focused", goalId: focusedGoalId, reason, at: ports.nowIso() });
					effects.push("ledger:goal_focused");
				} else if (previousGoalId) {
					ports.appendLedger(ctx, { type: "goal_unfocused", reason, at: ports.nowIso() });
					effects.push("ledger:goal_unfocused");
				}
			} catch {
			}
			ports.syncTools();
			ports.updateUI(ctx);
			effects.push("sync-tools", "update-ui");
			return { kind: "focus", previousGoalId, nextGoalId: focusedGoalId, effects };
		},

		unfocus(ctx, reason) {
			return this.focus(null, ctx, reason);
		},

		pause(ctx, opts = {}) {
			const current = focusedRecord();
			if (!current || current.status !== "active") {
				return { kind: "pause", previousGoalId: focusedGoalId, nextGoalId: focusedGoalId, effects: [] };
			}
			const note = opts.note?.trim() || undefined;
			const systemReason = opts.systemReason?.trim() || undefined;
			const suggestedAction = opts.suggestedAction?.trim() || undefined;
			const merged = ports.mergeGoalPromptFromDisk(ctx, cloneOut(current));
			const next: GoalRecord = {
				...merged,
				status: "paused",
				autoContinue: false,
				pauseReason: systemReason ?? (note ? `user: ${note}` : undefined),
				pauseSuggestedAction: suggestedAction,
			};
			const stamped = { ...next, stopReason: "user" as StopReason, updatedAt: ports.nowIso() };
			const effects: string[] = [];
			const report = setGoalInternal(stamped, ctx);
			try {
				ports.appendLedger(ctx, {
					type: "goal_paused",
					goalId: next.id,
					reason: systemReason ? "provider-error" : "user",
					suggestedAction: next.pauseSuggestedAction,
					status: next.status,
					at: stamped.updatedAt,
				});
				effects.push("ledger:goal_paused");
			} catch {
			}
			resetNudge(next.id);
			effects.push(`nudge-reset:${next.id}`);
			return { ...report, kind: "pause", effects: [...report.effects, ...effects] };
		},

		pauseByAgent(ctx, opts) {
			const current = focusedRecord();
			if (!current || current.status !== "active") {
				return { kind: "pause", previousGoalId: focusedGoalId, nextGoalId: focusedGoalId, effects: [] };
			}
			const merged = ports.mergeGoalPromptFromDisk(ctx, cloneOut(current));
			const next = buildPausedByAgentGoal(merged, { reason: opts.reason, suggestedAction: opts.suggestedAction, updatedAt: ports.nowIso() });
			const report = setGoalInternal(next, ctx);
			resetNudge(next.id);
			handleEvent({ tag: "turn-stopped", goalId: next.id });
			return {
				...report,
				kind: "pause",
				effects: [...report.effects, `nudge-reset:${next.id}`, `turn-stopped:${next.id}`],
			};
		},

		resume(ctx) {
			const current = focusedRecord();
			if (!current) {
				return { kind: "resume", previousGoalId: null, nextGoalId: null, effects: [] };
			}
			const merged = ports.mergeGoalPromptFromDisk(ctx, cloneOut(current));
			const next = {
				...merged,
				status: "active" as const,
				autoContinue: true,
				stopReason: undefined,
				pauseReason: undefined,
				pauseSuggestedAction: undefined,
			};
			const effects: string[] = [];
			const report = setGoalInternal(next, ctx);
			ports.beginClock();
			effects.push("begin-clock");
			resetNudge(next.id);
			effects.push(`nudge-reset:${next.id}`);
			try {
				ports.appendLedger(ctx, { type: "goal_resumed", goalId: next.id, reason: "user", at: ports.nowIso() });
				effects.push("ledger:goal_resumed");
			} catch {
			}
			return { ...report, kind: "resume", effects: [...report.effects, ...effects] };
		},

		activate(ctx) {
			const current = focusedRecord();
			if (!current) {
				return { kind: "activate", previousGoalId: null, nextGoalId: null, effects: [] };
			}
			const next = {
				...current,
				status: "active" as const,
				autoContinue: true,
				stopReason: undefined,
				pauseReason: undefined,
				pauseSuggestedAction: undefined,
			};
			const report = setGoalInternal(next, ctx);
			return { ...report, kind: "activate" };
		},

		setUserNote(ctx, note) {
			const current = focusedRecord();
			if (!current) {
				return { kind: "note", previousGoalId: null, nextGoalId: null, effects: [] };
			}
			const report = setGoalInternal({ ...current, userNote: note }, ctx);
			return { ...report, kind: "note" };
		},

		applyUsage(delta) {
			const current = focusedRecord();
			if (!current) throw new Error("Goal disappeared during usage application.");
			adoptInternal({
				...current,
				usage: {
					tokensUsed: current.usage.tokensUsed + Math.max(0, Math.trunc(delta.tokens)),
					activeSeconds: current.usage.activeSeconds + Math.max(0, delta.seconds),
					costUsed: (current.usage.costUsed ?? 0) + Math.max(0, delta.cost),
				},
				updatedAt: ports.nowIso(),
			});
		},

		recordAuditAttempt(ctx, attempt) {
			const current = focusedRecord();
			if (!current) return;
			adoptInternal({ ...current, auditAttempts: attempt });
			runPersistInternal(ctx);
		},

		applyTweak(ctx, newObjective) {
			const current = focusedRecord();
			if (!current) {
				return { kind: "tweak", previousGoalId: null, nextGoalId: null, effects: [] };
			}
			const next: GoalRecord = {
				...current,
				objective: newObjective,
				updatedAt: ports.nowIso(),
				pauseReason: undefined,
				pauseSuggestedAction: undefined,
			};
			const written = ports.writeActiveGoalFile(ctx, cloneOut(next));
			adoptInternal(written);
			const effects = [`write-active-file:${next.id}`];
			ports.appendStateEntry(cloneOut(focusedRecord()!));
			effects.push("state-entry");
			handleEvent({ tag: "draft-applied", kind: "tweak" });
			effects.push("draft-applied:tweak");
			const tweaked = focusedRecord()!;
			resetNudge(tweaked.id);
			effects.push(`nudge-reset:${tweaked.id}`);
			handleEvent({ tag: "turn-stopped", goalId: tweaked.id });
			effects.push(`turn-stopped:${tweaked.id}`);
			ports.syncTools();
			ports.updateUI(ctx);
			effects.push("sync-tools", "update-ui");
			return { kind: "tweak", previousGoalId: tweaked.id, nextGoalId: tweaked.id, effects };
		},

		syncObjectiveFromDisk(ctx, readCtx) {
			return syncObjectiveInternal(ctx, readCtx);
		},

		persistRecord(ctx, readCtx) {
			runPersistInternal(ctx, readCtx);
		},

		refreshDisplayFromDisk(ctx) {
			const current = focusedRecord();
			if (!current || current.status === "complete") return;
			if (syncObjectiveInternal(ctx)) {
				const g = focusedRecord();
				if (g) adoptInternal({ ...g, updatedAt: ports.nowIso() });
				const stamped = focusedRecord();
				ports.appendStateEntry(stamped ? cloneOut(stamped) : null);
			}
			ports.syncTools();
			ports.updateUI(ctx);
		},

		restore(ctx, input) {
			goalWorkToolCalledThisTurn = false;
			turnStoppedFor = null;
			replacePoolInternal(input.childSession ? new Map<string, GoalRecord>() : ports.readActiveGoalPool(ctx));
			setFocusedInternal(null);
			const resolved = resolveSessionFocus({
				pool: new Map(goalsById),
				focusEntry: input.focusEntry,
				legacyGoal: input.legacyGoal,
				adoptLegacyGoal: (g) => adoptInternal(g),
			});
			setFocusedInternal(resolved);
			if (!input.focusEntry && focusedGoalId) {
				try {
					ports.appendFocusEntry(focusedGoalId, input.legacyGoal?.id === focusedGoalId ? "migrated" : "selected");
				} catch {
				}
			}
			for (const [id, current] of goalsById) {
				if (current.status === "complete") removeFromPoolInternal(id);
			}
			ports.haltContinuation();
			ports.pauseClock();
			ports.syncTools();
			ports.updateUI(ctx);
			return focusedGoalId;
		},

		retireForReplacement(ctx) {
			const current = focusedRecord();
			if (current) {
				const merged = ports.mergeGoalPromptFromDisk(ctx, cloneOut(current));
				const stamped = {
					...merged,
					status: merged.status === "complete" ? ("complete" as const) : ("paused" as const),
					stopReason: "user" as StopReason,
				};
				ports.archiveGoal(ctx, cloneOut(stamped));
			}
			const report = setGoalInternal(null, ctx, { persist: true, focusReason: "cleared" });
			return { ...report, kind: "retire" };
		},

		reconcileFromDisk(ctx, opts = {}) {
			const current = focusedRecord();
			const fresh = ports.readActiveGoalPool(ctx);
			if (!focusedGoalId) {
				replacePoolInternal(fresh);
				return true;
			}
			const diskGoal = fresh.get(focusedGoalId) ?? null;
			if (opts.captureDiskGoal) opts.captureDiskGoal.goal = diskGoal;
			if (!diskGoal) {
				if (current && !current.activePath) {
					replacePoolInternal(fresh);
					adoptInternal(current);
					setFocusedInternal(current.id);
					return true;
				}
				replacePoolInternal(fresh);
				setFocusedInternal(null);
				ports.haltContinuation();
				ports.pauseClock();
				if (current) resetNudge(current.id);
				handleEvent({ tag: "draft-cancel", kind: "tweak" });
				ports.syncTools();
				ports.updateUI(ctx);
				return false;
			}
			const reconciled = current && opts.preserveMemoryUsage
				? mergeFocusedGoalWithDisk({ memoryGoal: cloneOut(current), diskGoal })
				: diskGoal;
			replacePoolInternal(fresh);
			adoptInternal(reconciled);
			setFocusedInternal(reconciled.id);
			if (reconciled.status !== "active" || !reconciled.autoContinue) ports.haltContinuation();
			if (reconciled.status !== "active") ports.pauseClock();
			return true;
		},

		complete(goal, ctx) {
			adoptInternal(goal);
			const merged = ports.mergeGoalPromptFromDisk(ctx, cloneOut(goal));
			const completed = { ...merged, status: "complete" as const, stopReason: "agent" as StopReason, updatedAt: ports.nowIso() };
			const effects: string[] = [];
			const setReport = setGoalInternal(completed, ctx);
			const terminal = focusedRecord() ?? completed;
			resetNudge(terminal.id);
			effects.push(`nudge-reset:${terminal.id}`);
			removeFromPoolInternal(terminal.id);
			effects.push(`remove-from-pool:${terminal.id}`);
			ports.appendFocusEntry(null, "completed");
			effects.push("focus-entry:null:completed");
			ports.syncTools();
			ports.updateUI(ctx);
			effects.push("sync-tools", "update-ui");
			try {
				ports.appendLedger(ctx, {
					type: "goal_completed",
					goalId: terminal.id,
					archivePath: terminal.archivedPath,
					at: ports.nowIso(),
				});
				effects.push("ledger:goal_completed");
			} catch {
			}
			return { kind: "complete", previousGoalId: setReport.previousGoalId, nextGoalId: null, record: cloneOut(terminal), effects: [...setReport.effects, ...effects] };
		},

		terminate(kind, ctx, opts = {}) {
			const by = opts.by ?? "user";
			const effects: string[] = [];
			const current = focusedRecord();
			let archived: GoalRecord | null = null;
			if (current) {
				const merged = ports.mergeGoalPromptFromDisk(ctx, cloneOut(current));
				const stamped = by === "agent" && kind === "abort"
					? buildAbortedByAgentGoal(merged, { reason: opts.reason ?? "", updatedAt: ports.nowIso() })
					: { ...merged, stopReason: by as StopReason };
				const forArchive = {
					...stamped,
					status: stamped.status === "complete" ? ("complete" as const) : ("paused" as const),
					stopReason: by as StopReason,
				};
				archived = ports.archiveGoal(ctx, cloneOut(forArchive));
				effects.push("archive");
			}
			try {
				ports.appendLedger(ctx, {
					type: "goal_aborted",
					goalId: archived?.id ?? current?.id ?? "unknown",
					reason: by === "agent"
						? (opts.reason ?? "").trim()
						: opts.note?.trim()
							? `user ${kind === "clear" ? "cleared" : "aborted"}: ${opts.note.trim()}`
							: `user ${kind === "clear" ? "cleared" : "aborted"}`,
					archivePath: archived?.archivedPath,
					at: ports.nowIso(),
				});
				effects.push("ledger:goal_aborted");
			} catch {
			}
			if (current) {
				resetNudge(current.id);
				effects.push(`nudge-reset:${current.id}`);
			}
			const setReport = setGoalInternal(null, ctx, { focusReason: kind === "clear" ? "cleared" : "aborted" });
			return { kind: "terminate", previousGoalId: current?.id ?? null, nextGoalId: null, record: archived ? cloneOut(archived) : undefined, effects: [...effects, ...setReport.effects] };
		},
	};
}
