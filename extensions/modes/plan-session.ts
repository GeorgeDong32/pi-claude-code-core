/**
 * modes/plan-session.ts — the PlanSession state owner (SPEC SR W-M: E13b +
 * CORE-17). Extracted from the modes extension factory (index.ts) so the
 * plan lifecycle has ONE state owner: planExecuting / planPhase / planTodos /
 * lastExtractedPlanHash / the offer cooldown + suppress timestamps and the
 * pre-plan tool snapshot all live here; index.ts keeps only mode state and
 * builds the persisted `modes` entry from entryFields().
 *
 * Design decisions (behavior-preserving move — quirks are pinned by
 * plan-flow.test.ts and index.test.ts and must NOT be "fixed" here):
 * - startExecution keeps the RAW `setModeRaw("auto")` write (skips the BH-E4
 *   generation tail / permission strip / capability publish) — the historical
 *   /plan-execute transition order is: state → tool restrictions → status
 *   clear → plan widget sync → persist → model profile → modes-execute send.
 * - entryFields() returns the SAME planTodos array reference (no cloning) and
 *   a FIXED key order so the spread in persistState() stays JSON-identical
 *   (contract P0-CT-08/09).
 * - restoreFromEntry is overlay-ONLY: missing fields keep the in-memory
 *   values; mode-name mapping (normal/default/accept-edits) stays in
 *   index.ts. Cooldown timestamps are never persisted and never reset.
 * - markPlanOfferHandled is intentionally called TWICE around each approval
 *   dialog (plan_ready and agent_end offer) — before the await so a
 *   concurrent agent_end cannot open a second dialog, and after dismissal.
 * - onAgentEnd early-returns (reports "handled") while an execution is
 *   running, even when not every step is done.
 * - The headless plan_ready path reports "auto-execute" text but does NOT
 *   execute (only the interactive dialog drives startExecution).
 * - The planPhase fallback in the capability channel (index.ts) reads
 *   `session.phase` — only consulted while the bus field is undefined.
 *
 * Plan text/file primitives come from plan.ts (the pure plan concept module)
 * — nothing here duplicates them.
 */
import { Type } from "typebox";
import {
	defineTool,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth } from "@earendil-works/pi-tui";
import { clearModesStatus } from "./ui/footer.ts";
import { clearPlanWidget, updatePlanWidget as updatePlanWidgetUi } from "./ui/plan-widget.ts";
import { notify as uiNotify } from "../ui/notify.ts";
import { runPlanApprovalDialog } from "./ui/plan-approval-dialog.ts";
import {
	type TodoItem,
	ensurePlanFile,
	extractPlanSection,
	extractTodoItems,
	filterSubstantivePlanItems,
	hashPlan,
	markCompletedSteps,
	readPlanFile,
	shouldSyncAssistantPlanToFile,
	writePlanFile,
} from "./plan.ts";
import type { PermissionMode, PlanPhase } from "./mode-prompt.ts";

/** Tools available in plan mode (edit/write only for plan.md via tool_call gate). */
const PLAN_TOOLS = ["read", "bash", "grep", "find", "ls", "edit", "write", "plan_ready"];
/**
 * Gate-side classification for pi 0.99's meta tools (SPEC META-01..03):
 * `tool_search` only loads tool declarations (retrieval), `codemode` runs
 * model-written scripts that call other tools (execution surface). MCP
 * tools are detected via the shared lib/mcp-shape.ts predicate (native /
 * proxy / direct-named / bare `mcp_*` — declaring != executing, but every
 * MCP tool is a potential mutation, so plan denies them outright).
 */
const PLAN_DISABLED = new Set<string>();

const PLAN_OFFER_COOLDOWN_MS = 60_000;

/** The plan-owned slice of the persisted `modes` entry (fixed key order). */
export interface PlanEntryFields {
	planPhase: PlanPhase;
	planExecuting: boolean;
	planTodos: TodoItem[];
	lastExtractedPlanHash: string;
}

/** Overlay subset of a restored `modes` entry that this session consumes. */
export interface PlanEntryOverlay {
	planPhase?: unknown;
	planExecuting?: unknown;
	planTodos?: unknown;
	lastExtractedPlanHash?: unknown;
}

export interface PlanSessionDeps {
	pi: Pick<
		ExtensionAPI,
		"getActiveTools" | "setActiveTools" | "sendMessage" | "sendUserMessage"
	>;
	getMode(): PermissionMode;
	/** The historical raw write into the factory's currentMode (no side effects). */
	setModeRaw(mode: PermissionMode): void;
	persistState(): void;
	applyProfileForMode(mode: PermissionMode, ctx: ExtensionContext): Promise<void>;
}

export interface PlanSession {
	/** Current plan phase (capability-channel fallback consumer). */
	readonly phase: PlanPhase;
	/** The persisted slice — SAME planTodos reference, fixed key order. */
	entryFields(): PlanEntryFields;
	/** Overlay-only restore of the plan fields from the last `modes` entry. */
	restoreFromEntry(last: PlanEntryOverlay | undefined): void;
	applyToolRestrictions(): void;
	/** setMode sync part: executing flag, phase/hash reset, todos, widget clear. */
	resetOnModeSwitch(mode: PermissionMode, ctx: ExtensionContext): void;
	/** plan.md is created only when plan mode SETTLES (BH-E4). */
	onPlanModeSettled(prev: PermissionMode, cwd: string): void;
	startExecution(ctx: ExtensionContext, todos: TodoItem[]): Promise<void>;
	/**
	 * The before_agent_start executing block. Returns the mode block when an
	 * execution is running (and marks phase="executing"), else undefined.
	 */
	executingPromptBlock(complianceBlock: string): string | undefined;
	onTurnEnd(text: string, ctx: ExtensionContext): void;
	/**
	 * agent_end plan flow: completion announcement while executing, else the
	 * plan-mode offer. Returns true when it handled the event so the caller
	 * can early-return.
	 */
	onAgentEnd(event: { messages: unknown[] }, ctx: ExtensionContext): Promise<boolean>;
	onSessionStartUi(ctx: ExtensionContext): void;
	/** Registers /plan-execute + plan_ready (call at the historical position). */
	registerSurfaces(pi: ExtensionAPI): void;
}

export function createPlanSession(deps: PlanSessionDeps): PlanSession {
	// ---- plan state (moved verbatim from index.ts) --------------------------
	let planExecuting = false;
	let planPhase: PlanPhase = "exploring";
	let lastExtractedPlanHash = "";
	let lastPlanOfferAt = 0;
	/** Suppress agent_end re-offer after the user dismisses plan approval (Stay/Esc/Refine). */
	let suppressPlanOfferUntil = 0;
	let toolsBeforePlanMode: string[] | undefined;
	let planTodos: TodoItem[] = [];

	function applyToolRestrictions(): void {
		if (planExecuting) {
			if (toolsBeforePlanMode !== undefined) {
				deps.pi.setActiveTools(toolsBeforePlanMode);
				toolsBeforePlanMode = undefined;
			}
			return;
		}
		if (deps.getMode() === "plan") {
			if (toolsBeforePlanMode === undefined)
				toolsBeforePlanMode = deps.pi.getActiveTools();
			const kept = toolsBeforePlanMode.filter((t) => !PLAN_DISABLED.has(t));
			deps.pi.setActiveTools([...new Set([...kept, ...PLAN_TOOLS])]);
		} else if (toolsBeforePlanMode !== undefined) {
			deps.pi.setActiveTools(toolsBeforePlanMode);
			toolsBeforePlanMode = undefined;
		}
	}

	/** P3-1 S2 (SPEC 2026-10-07): the ONE plan→auto execution transition.
	 *  Order follows /plan-execute: state → tool restrictions → status clear →
	 *  plan widget sync → persist → model profile → the modes-execute send.
	 *  The plan_ready path previously missed the widget update after the mode
	 *  flip — unified here (visible widget-sync fix, CHANGELOG'd). */
	async function startExecution(ctx: ExtensionContext, todos: TodoItem[]): Promise<void> {
		planExecuting = true;
		planPhase = "executing";
		planTodos = todos;
		// RAW mode write (historical): skips the setMode generation tail,
		// the auto permission strip and the capability publish on purpose.
		deps.setModeRaw("auto");
		applyToolRestrictions();
		clearModesStatus(ctx);
		updatePlanWidgetUi(ctx, planTodos);
		deps.persistState();
		await deps.applyProfileForMode("auto", ctx);
		const steps = planTodos.map((t) => `${t.step}. ${t.text}`).join("\n");
		deps.pi.sendMessage(
			{
				customType: "modes-execute",
				content: `Execute the plan now. Steps:\n${steps}\n\nStart with step 1. After finishing each step, include a [DONE:n] tag in your reply.`,
				display: true,
			},
			{ triggerTurn: true, deliverAs: "followUp" },
		);
	}

	// ---- plan approval helpers ---------------------------------------------
	function markPlanOfferHandled(planContent: string): void {
		lastPlanOfferAt = Date.now();
		// Keep agent_end from immediately re-opening the same plan dialog after Stay/Esc.
		suppressPlanOfferUntil = Date.now() + PLAN_OFFER_COOLDOWN_MS;
		if (planContent) {
			lastExtractedPlanHash = hashPlan(planContent);
		}
	}

	async function promptPlanRefinement(ctx: ExtensionContext): Promise<void> {
		if (!ctx.hasUI) return;
		planPhase = "refining";
		const refinement = await ctx.ui.editor("Refine the plan:", "");
		if (refinement?.trim()) {
			deps.pi.sendUserMessage(refinement.trim(), { deliverAs: "followUp" });
		}
	}

	function planReviewClosedToolResult() {
		return {
			content: [
				{
					type: "text" as const,
					text: "Plan review closed. Wait for the user's next message; do not continue on your own.",
				},
			],
			terminate: true as const,
			details: undefined,
		};
	}

	async function onAgentEnd(
		event: { messages: unknown[] },
		ctx: ExtensionContext,
	): Promise<boolean> {
		// Plan execution in progress: announce completion when all steps are done.
		if (planExecuting && planTodos.length) {
			if (planTodos.every((t) => t.completed)) {
				if (ctx.hasUI) {
					deps.pi.sendMessage(
						{
							customType: "plan-complete",
							content: "**Plan Complete!** ✓",
							display: true,
						},
						{ triggerTurn: false },
					);
					clearPlanWidget(ctx);
				}
				planExecuting = false;
				planTodos = [];
				deps.persistState();
			}
			return true;
		}

		// In plan mode: sync plan.md and offer next action (throttled).
		if (deps.getMode() !== "plan" || !ctx.hasUI || planExecuting) return false;

		const planContent = readPlanFile(ctx.cwd);
		let extracted = filterSubstantivePlanItems(
			planContent ? extractTodoItems(planContent) : [],
		);

		const isAssistant = (m: any): boolean =>
			!!m && m.role === "assistant" && Array.isArray(m.content);
		const getText = (m: any): string =>
			Array.isArray(m?.content)
				? m.content
						.filter((c: any) => c?.type === "text")
						.map((c: any) => c.text)
						.join("\n")
				: typeof m?.content === "string"
					? m.content
					: "";

		const lastAssistant = [...event.messages].reverse().find(isAssistant);
		const assistantText = lastAssistant ? getText(lastAssistant) : "";
		const assistantPlan = assistantText
			? filterSubstantivePlanItems(extractTodoItems(assistantText))
			: [];

		if (!extracted.length && assistantPlan.length) {
			if (shouldSyncAssistantPlanToFile(planContent)) {
				const planSection = extractPlanSection(assistantText);
				if (planSection) writePlanFile(ctx.cwd, planSection);
				extracted = assistantPlan;
			}
		} else if (assistantPlan.length) {
			if (shouldSyncAssistantPlanToFile(planContent)) {
				const assistantSection = extractPlanSection(assistantText);
				if (assistantSection) writePlanFile(ctx.cwd, assistantSection);
				extracted = assistantPlan;
			}
		}

		if (!extracted.length) return true;

		// Cooldown / Stay dismiss: don't re-offer within 60s of the last offer.
		if (Date.now() - lastPlanOfferAt < PLAN_OFFER_COOLDOWN_MS) return true;
		if (Date.now() < suppressPlanOfferUntil) return true;

		const syncedContent = readPlanFile(ctx.cwd) ?? planContent ?? "";
		const contentHash = hashPlan(
			syncedContent || JSON.stringify(extracted),
		);
		const isFirst = !lastExtractedPlanHash;
		const changed = contentHash !== lastExtractedPlanHash;
		if (!isFirst && !changed) return true;

		planTodos = extracted;
		deps.persistState();

		// Mark before await so a concurrent agent_end cannot open a second dialog.
		markPlanOfferHandled(syncedContent || JSON.stringify(extracted));
		const choice = await runPlanApprovalDialog(ctx, {
			planContent: syncedContent,
			stepCount: extracted.length,
		});
		markPlanOfferHandled(syncedContent || JSON.stringify(extracted));

		if (choice === "execute") {
			await startExecution(ctx, planTodos);
		} else if (choice === "refine") {
			await promptPlanRefinement(ctx);
		}
		// stay | cancel (Esc): dialog already closed; return silently to the input prompt.
		return true;
	}

	const session: PlanSession = {
		get phase() {
			return planPhase;
		},
		entryFields() {
			// Key order is FIXED (spread-compatible with the persisted entry);
			// planTodos is the SAME reference — no cloning.
			return {
				planPhase,
				planExecuting,
				planTodos,
				lastExtractedPlanHash,
			};
		},
		restoreFromEntry(last) {
			if (!last) return;
			// Overlay-ONLY: typeof-guarded fields; missing fields keep the
			// in-memory values. Cooldown timestamps are never persisted.
			if (typeof last.planPhase === "string")
				planPhase = last.planPhase as PlanPhase;
			if (typeof last.planExecuting === "boolean")
				planExecuting = last.planExecuting;
			if (Array.isArray(last.planTodos))
				planTodos = last.planTodos as TodoItem[];
			if (typeof last.lastExtractedPlanHash === "string")
				lastExtractedPlanHash = last.lastExtractedPlanHash;
		},
		applyToolRestrictions,
		resetOnModeSwitch(mode, ctx) {
			planExecuting = false;
			if (mode !== "plan") {
				planPhase = "exploring";
				lastExtractedPlanHash = "";
			}
			planTodos = [];
			if (ctx.hasUI) clearPlanWidget(ctx);
		},
		onPlanModeSettled(prev, cwd) {
			// plan.md is created only when plan mode SETTLES (BH-E4)
			ensurePlanFile(cwd);
			if (prev !== "plan") planPhase = "exploring";
		},
		startExecution,
		executingPromptBlock(complianceBlock) {
			if (!(planExecuting && planTodos.length)) return undefined;
			const remaining = planTodos
				.filter((t) => !t.completed)
				.map((t) => `${t.step}. ${t.text}`)
				.join("\n");
			let modeBlock = `[Plan/executing] Execute steps from plan.md. Remaining:\n${remaining}\nMark progress with [DONE:n] tags.`;
			planPhase = "executing";
			if (complianceBlock) modeBlock = `${modeBlock}\n${complianceBlock}`;
			return modeBlock;
		},
		onTurnEnd(text, ctx) {
			if (planExecuting && planTodos.length) {
				if (markCompletedSteps(text, planTodos) > 0) updatePlanWidgetUi(ctx, planTodos);
				deps.persistState();
			}
		},
		onAgentEnd,
		onSessionStartUi(ctx) {
			if (planExecuting && planTodos.length) updatePlanWidgetUi(ctx, planTodos);
		},
		registerSurfaces(pi) {
			// ---- /plan-execute ----------------------------------------------
			pi.registerCommand("plan-execute", {
				description:
					"Execute the current plan immediately (switches to auto mode with step tracking)",
				handler: async (_args, ctx) => {
					if (deps.getMode() !== "plan" && !planExecuting) {
						uiNotify(ctx, "Not in plan mode. Use /plan first.", "warning");
						return;
					}
					const planContent = readPlanFile(ctx.cwd);
					const extracted = filterSubstantivePlanItems(
						planContent ? extractTodoItems(planContent) : [],
					);
					if (!extracted.length) {
						uiNotify(ctx, "No plan steps found in plan.md. Write a plan first.", "warning");
						return;
					}
					await startExecution(ctx, extracted);
				},
			});

			// ---- plan_ready tool (model-initiated plan submission) -----------
			const PLAN_READY_TOOL_NAME = "plan_ready";

			pi.registerTool(defineTool({
				name: PLAN_READY_TOOL_NAME,
				label: "Plan Ready",
				description:
					"Submit the completed plan to the user for approval. Only available in plan mode. The user will see the plan and choose to execute, refine, or stay in plan mode.",
				promptSnippet:
					"Call plan_ready when your plan in plan.md is complete and ready for user review.",
				promptGuidelines: [
					"Only call plan_ready when you have finished exploring and the plan file contains a concrete, numbered implementation plan.",
					"Do NOT call plan_ready if the plan still has open questions or incomplete sections.",
					"After calling plan_ready, stop and wait for the user's decision. Do not begin implementation.",
					"If the user asks to refine, update plan.md and call plan_ready again when ready.",
				],
				parameters: Type.Object({
					summary: Type.Optional(
						Type.String({ description: "Brief one-line summary of the plan for the approval dialog." }),
					),
				}),
				executionMode: "sequential",
				async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
					if (deps.getMode() !== "plan") {
						return {
							content: [{ type: "text", text: "plan_ready is only available in plan mode. Current mode: " + deps.getMode() }],
							details: undefined,
						};
					}
					const planContent = readPlanFile(ctx.cwd);
					const extracted = filterSubstantivePlanItems(
						planContent ? extractTodoItems(planContent) : [],
					);
					if (!extracted.length) {
						return {
							content: [{ type: "text", text: "No plan steps found in plan.md. Write a numbered plan first, then call plan_ready." }],
							details: undefined,
						};
					}

					planTodos = extracted;
					deps.persistState();
					updatePlanWidgetUi(ctx, planTodos);

					const summary = params.summary?.trim() || undefined;
					const stepsPreview = extracted.map((t) => `${t.step}. ${t.text}`).join("\n");

					if (!ctx.hasUI) {
						// Headless: auto-execute
						const summaryLine = summary ? `${summary}\n\n` : "";
						return {
							content: [{ type: "text", text: `Plan submitted (headless auto-execute).\n${summaryLine}${stepsPreview}` }],
							details: undefined,
						};
					}

					// Suppress agent_end re-offer while this dialog is open and after dismiss.
					markPlanOfferHandled(planContent ?? "");
					const choice = await runPlanApprovalDialog(ctx, {
						summary,
						planContent: planContent ?? "",
						stepCount: extracted.length,
					});
					markPlanOfferHandled(planContent ?? "");

					if (choice === "execute") {
						await startExecution(ctx, planTodos);
						return {
							content: [{ type: "text", text: "Plan approved by user. Switching to execution mode." }],
							terminate: true,
							details: undefined,
						};
					}

					if (choice === "refine") {
						await promptPlanRefinement(ctx);
						return planReviewClosedToolResult();
					}

					// stay | cancel (Esc): one dismiss returns to the input prompt.
					return planReviewClosedToolResult();
				},
				renderCall(args, theme) {
					return new Text(
						theme.fg("toolTitle", "plan_ready ") + theme.fg("muted", truncateToWidth(String(args?.summary ?? ""), 60)),
						0, 0,
					);
				},
				renderResult(result, _options, theme) {
					const first = result.content?.find((c: any) => c.type === "text") as
						| { text?: string }
						| undefined;
					return new Text(theme.fg("muted", truncateToWidth(String(first?.text ?? ""), 80)), 0, 0);
				},
			}));
		},
	};

	return session;
}

/** Exported wrapper: registers /plan-execute + plan_ready at the historical
 *  position (between /mode and /outside-writes in the factory body). */
export function registerPlanSurfaces(pi: ExtensionAPI, session: PlanSession): void {
	session.registerSurfaces(pi);
}
