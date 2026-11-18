import {
	VERSION,
	withFileMutationQueue,
	type BashToolOptions,
	createEditToolDefinition,
	createWriteToolDefinition,
	type EditToolDetails,
	type EditToolOptions,
	type ExtensionAPI,
	type ExtensionContext,
	type ExtensionFactory,
	type WriteToolOptions,
} from "@earendil-works/pi-coding-agent";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { assessEconomyModule, probePiCompat } from "../../lib/pi-compat.ts";
import { coreBus } from "../bus.ts";
import { setFooterLine } from "../ui/footer-lines.ts";
import { withFusedFileQueue } from "./file-queue.ts";
import { withThenRunBadge, withThenRunStatus, type ThenRunArgs } from "./renderers.ts";
import { resolveToolPath } from "./tool-path.ts";
import {
	createThenRunSchema,
	executeMutationThenRun,
	type FileQueueFn,
	type ThenRunInput,
} from "./then-run.ts";
import { Type } from "typebox";

const EDIT_THEN_RUN_DESCRIPTION =
	"Command to run next on this file after the edit succeeds — e.g. run, build, install, or check it; timeout in seconds (default 600). Short verification commands only — long-running or server-like commands belong in a background bash call. Skipped if the edit fails; a non-zero exit is reported but keeps the edit.";
const WRITE_THEN_RUN_DESCRIPTION =
	"Command to run next on this file after the write succeeds — e.g. run, build, install, or check it; timeout in seconds (default 600). Short verification commands only — long-running or server-like commands belong in a background bash call. Skipped if the write fails; a non-zero exit is reported but keeps the write.";

const TOOL_DESCRIPTION_GUIDANCE =
	" After a successful write/edit, pass `then_run.command` to run a verification command in the same step instead of a separate bash call.";

export interface ActionFusionOptions {
	readonly version?: string;
	readonly bashOptions?: BashToolOptions;
	readonly editOptions?: EditToolOptions;
	readonly writeOptions?: WriteToolOptions;
}

function memoizeByCwd<T>(create: (cwd: string) => T): (cwd: string) => T {
	const cache = new Map<string, T>();
	return (cwd) => {
		const cached = cache.get(cwd);
		if (cached) return cached;
		const created = create(cwd);
		cache.set(cwd, created);
		return created;
	};
}

export function createActionFusionExtension(options: ActionFusionOptions = {}): ExtensionFactory {
	return (pi: ExtensionAPI) => {
		const compat = probePiCompat({
			version: options.version ?? VERSION,
			toolFactories: {
				write: createWriteToolDefinition,
				edit: createEditToolDefinition,
			},
			mutationQueue: withFileMutationQueue,
		});
		const assessment = assessEconomyModule(compat, "action-fusion");
		if (!assessment.enabled) {
			console.warn(assessment.warning);
			pi.on("session_start", () => {
				setFooterLine("action-fusion", assessment.footerLine);
			});
			return;
		}
		// FUS-03 (revised after TST-04): the OUTER serialization must be the
		// ported fused queue. pi's builtin write/edit already wrap their own
		// bodies in the official withFileMutationQueue for the same path, so
		// using it as the outer layer too deadlocks on re-entry (sandbox-proven:
		// the session froze mid-write). The official export stays as a
		void compat.mutationQueue;
		const queue: FileQueueFn = withFusedFileQueue;

		const baseEdit = memoizeByCwd((cwd: string) => createEditToolDefinition(cwd, options.editOptions));
		const baseWrite = memoizeByCwd((cwd: string) => createWriteToolDefinition(cwd, options.writeOptions));
		let fusedCount = 0;

		const editTemplate = baseEdit(process.cwd());
		const writeTemplate = baseWrite(process.cwd());

		const editParameters = Type.Object({
			...editTemplate.parameters.properties,
			then_run: createThenRunSchema(EDIT_THEN_RUN_DESCRIPTION),
		});
		const writeParameters = Type.Object({
			...writeTemplate.parameters.properties,
			then_run: createThenRunSchema(WRITE_THEN_RUN_DESCRIPTION),
		});

		const selfCheck = () => {
			try {
				const write = pi
					.getAllTools()
					.find((tool) => tool.name === "write") as { parameters?: { properties?: Record<string, unknown> } } | undefined;
				if (write && !("then_run" in (write.parameters?.properties ?? {}))) {
					console.warn("[action-fusion] write schema is missing then_run after registration — host override semantics may have changed");
				}
			} catch {
				// Self-check must never break the session.
			}
		};

		const noteFused = () => {
			fusedCount += 1;
			coreBus().publish({ fusion: { fusedCount } });
		};

		const fusedGuidance = (description: string | undefined): string =>
			description ? `${description}${TOOL_DESCRIPTION_GUIDANCE}` : TOOL_DESCRIPTION_GUIDANCE.trim();

		const runFused = async <D>(args: {
			toolCallId: string;
			absolutePath: string;
			thenRun: ThenRunInput | undefined;
			signal: AbortSignal | undefined;
			ctx: ExtensionContext;
			mutate: () => Promise<AgentToolResult<D>>;
		}): Promise<AgentToolResult<D>> => {
			const result = await executeMutationThenRun<D>({
				toolCallId: args.toolCallId,
				absolutePath: args.absolutePath,
				thenRun: args.thenRun,
				bashOptions: options.bashOptions,
				signal: args.signal,
				ctx: args.ctx,
				queue,
				mutate: args.mutate,
			});
			if (args.thenRun && (result.details as { thenRun?: string } | undefined)?.thenRun === "succeeded") {
				noteFused();
			}
			return result;
		};

		pi.registerTool<typeof editParameters, EditToolDetails | undefined>({
			...editTemplate,
			parameters: editParameters,
			description: fusedGuidance(editTemplate.description),
			async execute(toolCallId, input, signal, onUpdate, ctx) {
				const { then_run, ...editInput } = input as typeof input & { then_run?: ThenRunInput };
				return runFused({
					toolCallId,
					absolutePath: resolveToolPath(ctx.cwd, input.path),
					thenRun: then_run,
					signal,
					ctx,
					mutate: () => baseEdit(ctx.cwd).execute(toolCallId, editInput, signal, onUpdate, ctx),
				});
			},
			renderCall: (args, theme, context) => withThenRunBadge(baseEdit(context.cwd).renderCall!(args, theme, context), args as ThenRunArgs, theme),
			renderResult: (result, resultOptions, theme, context) => withThenRunStatus(baseEdit(context.cwd).renderResult!(result, resultOptions, theme, context), result, theme, { args: context.args as ThenRunArgs | undefined, isPartial: resultOptions.isPartial || context.isPartial }),
		});

		pi.registerTool<typeof writeParameters, undefined>({
			...writeTemplate,
			parameters: writeParameters,
			description: fusedGuidance(writeTemplate.description),
			async execute(toolCallId, input, signal, onUpdate, ctx) {
				const { then_run, ...writeInput } = input as typeof input & { then_run?: ThenRunInput };
				return runFused({
					toolCallId,
					absolutePath: resolveToolPath(ctx.cwd, input.path),
					thenRun: then_run,
					signal,
					ctx,
					mutate: () => baseWrite(ctx.cwd).execute(toolCallId, writeInput, signal, onUpdate, ctx),
				});
			},
			renderCall: (args, theme, context) => withThenRunBadge(baseWrite(context.cwd).renderCall!(args, theme, context), args as ThenRunArgs, theme),
			renderResult: (result, resultOptions, theme, context) => withThenRunStatus(baseWrite(context.cwd).renderResult!(result, resultOptions, theme, context), result, theme, { args: context.args as ThenRunArgs | undefined, isPartial: resultOptions.isPartial || context.isPartial }),
		});

		selfCheck();
	};
}

export default createActionFusionExtension;
