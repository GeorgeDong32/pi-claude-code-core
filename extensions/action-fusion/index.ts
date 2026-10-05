/*
 * Action Fusion core module (SPEC FUS-01..11).
 *
 * Fuses a file mutation and its follow-up command into one model turn:
 * the built-in edit/write tools are re-registered with an optional
 * `then_run` object parameter; execute delegates to the built-in
 * implementation, then runs the command through the built-in bash tool so
 * the permission pipeline is inherited, and merges the outputs.
 *
 * Ported from NVlabs/SoL-Pi (MIT) with three core-side changes (PORT §7.5
 * and SPEC FUS-03/05/06): the official withFileMutationQueue is preferred
 * over a private queue; guidance is dual-channel (schema + tool description
 * tail); renderCall/renderResult pass through the built-in renderers with
 * zero new rendering surface.
 */
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
import { degradeEconomyModule, probePiCompat } from "../../lib/pi-compat.ts";
import { coreBus } from "../bus.ts";
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
	"Command to run next on this file after the edit succeeds — e.g. run, build, start/restart, install, or check it; optional timeout in seconds. Skipped if the edit fails; a non-zero exit is reported but keeps the edit.";
const WRITE_THEN_RUN_DESCRIPTION =
	"Command to run next on this file after the write succeeds — e.g. run, build, start/restart, install, or check it; optional timeout in seconds. Skipped if the write fails; a non-zero exit is reported but keeps the write.";

/** DEC-03: second guidance channel, appended to the tool description tail. */
const TOOL_DESCRIPTION_GUIDANCE =
	" After a successful write/edit, pass `then_run.command` to run a verification command in the same step instead of a separate bash call.";

export interface ActionFusionOptions {
	/** B4: host pi version injection — tests pin the self-disable path with
	 * an old version without touching the real import. Defaults to the
	 * compiled-in VERSION. */
	readonly version?: string;
	/** Optional programmatic bash overrides, primarily for tests. */
	readonly bashOptions?: BashToolOptions;
	readonly editOptions?: EditToolOptions;
	readonly writeOptions?: WriteToolOptions;
}

/**
 * Built-in tool definitions capture their cwd in closures, so keep one per
 * working directory instead of rebuilding them on every call and every redraw.
 */
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
		// CMP-02 version gate + FUS-03 queue adapter selection. B4: version
		// comes in via options (assembly passes the real one; tests pin the
		// self-disable path), and the degrade tail is the shared helper.
		const compat = probePiCompat({
			version: options.version ?? VERSION,
			toolFactories: {
				write: createWriteToolDefinition,
				edit: createEditToolDefinition,
			},
			mutationQueue: withFileMutationQueue,
		});
		if (
			!degradeEconomyModule({
				compat,
				label: "action-fusion",
				publish: (line) => coreBus().publish({ display: { footer: [line] } }),
			})
		) {
			return;
		}
		// FUS-03 (revised after TST-04): the OUTER serialization must be the
		// ported fused queue. pi's builtin write/edit already wrap their own
		// bodies in the official withFileMutationQueue for the same path, so
		// using it as the outer layer too deadlocks on re-entry (sandbox-proven:
		// the session froze mid-write). The official export stays as a
		// host-health probe only.
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

		/** CMP-03: registration self-check — the model-visible schema must carry then_run. */
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

		// B6: the fused orchestration + outcome counting lives in ONE place;
		// the two registrations below differ only in base template, parameters,
		// description and the mutate closure.
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
			// B6: count from the structured outcome on the merged details — the
			// caller no longer sniffs the THEN_RUN_SUCCEEDED protocol token.
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
			// FUS-06: pass the built-in renderers through — TR B adds ONLY a
			// wrapper row (↳ then_run badge / status), the builtin payload is
			// untouched and plain write/edit render identically (zero-wrap rule).
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
