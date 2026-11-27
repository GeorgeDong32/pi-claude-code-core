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
	assistantMessageText,
	ensurePlanFile,
	extractPlanSection,
	extractTodoItems,
	filterSubstantivePlanItems,
	hashPlan,
	isAssistantMessage,
	markCompletedSteps,
	readPlanFile,
	shouldSyncAssistantPlanToFile,
	writePlanFile,
} from "./plan.ts";
import type { PermissionMode, PlanPhase } from "./mode-prompt.ts";

const PLAN_TOOLS = ["read", "bash", "grep", "find", "ls", "edit", "write", "plan_ready"];
const PLAN_DISABLED = new Set<string>();

const PLAN_OFFER_COOLDOWN_MS = 60_000;

export interface PlanEntryFields {
	planPhase: PlanPhase;
	planExecuting: boolean;
	planTodos: TodoItem[];
	lastExtractedPlanHash: string;
}

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
	setModeRaw(mode: PermissionMode): void;
	persistState(): void;
	applyProfileForMode(mode: PermissionMode, ctx: ExtensionContext): Promise<void>;
}

export interface PlanSession {
	readonly phase: PlanPhase;
	entryFields(): PlanEntryFields;
	restoreFromEntry(last: PlanEntryOverlay | undefined): void;
	applyToolRestrictions(): void;
	resetOnModeSwitch(mode: PermissionMode, ctx: ExtensionContext): void;
	onPlanModeSettled(prev: PermissionMode, cwd: string): void;
	executingPromptBlock(complianceBlock: string): string | undefined;
	onTurnEnd(text: string, ctx: ExtensionContext): void;
	onAgentEnd(event: { messages: unknown[] }, ctx: ExtensionContext): Promise<boolean>;
	onSessionStartUi(ctx: ExtensionContext): void;
	registerSurfaces(pi: ExtensionAPI): void;
}

export function createPlanSession(deps: PlanSessionDeps): PlanSession {
	let planExecuting = false;
	let planPhase: PlanPhase = "exploring";
	let lastExtractedPlanHash = "";
	let lastPlanOfferAt = 0;
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

	async function startExecution(ctx: ExtensionContext, todos: TodoItem[]): Promise<void> {
		planExecuting = true;
		planPhase = "executing";
		planTodos = todos;
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

	function markPlanOfferHandled(planContent: string): void {
		lastPlanOfferAt = Date.now();
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

		if (deps.getMode() !== "plan" || !ctx.hasUI || planExecuting) return false;

		const planContent = readPlanFile(ctx.cwd);
		let extracted = filterSubstantivePlanItems(
			planContent ? extractTodoItems(planContent) : [],
		);

		const lastAssistant = [...event.messages].reverse().find(isAssistantMessage);
		const assistantText = lastAssistant ? assistantMessageText(lastAssistant) : "";
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
		return true;
	}

	const session: PlanSession = {
		get phase() {
			return planPhase;
		},
		entryFields() {
			return {
				planPhase,
				planExecuting,
				planTodos,
				lastExtractedPlanHash,
			};
		},
		restoreFromEntry(last) {
			if (!last) return;
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
			ensurePlanFile(cwd);
			if (prev !== "plan") planPhase = "exploring";
		},
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
						const summaryLine = summary ? `${summary}\n\n` : "";
						return {
							content: [{ type: "text", text: `Plan submitted (headless auto-execute).\n${summaryLine}${stepsPreview}` }],
							details: undefined,
						};
					}

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

export function registerPlanSurfaces(pi: ExtensionAPI, session: PlanSession): void {
	session.registerSurfaces(pi);
}
