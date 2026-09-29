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
	type ExtensionFactory,
	type WriteToolOptions,
} from "@earendil-works/pi-coding-agent";
import { probePiCompat } from "../../lib/pi-compat.ts";
import { coreBus } from "../bus.ts";
import { resolveToolPath, withFusedFileQueue } from "./file-queue.ts";
import {
	createThenRunSchema,
	executeMutationThenRun,
	THEN_RUN_SUCCEEDED,
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
		// CMP-02 version gate + FUS-03 queue adapter selection.
		const compat = probePiCompat({
			version: VERSION,
			toolFactories: {
				write: createWriteToolDefinition,
				edit: createEditToolDefinition,
			},
			mutationQueue: withFileMutationQueue,
		});
		if (!compat.versionOk || !compat.toolFactories) {
			console.warn(`[action-fusion] disabled: ${compat.problems.join("; ")}`);
			coreBus().publish({ display: { footer: [`action-fusion requires pi >=0.87`] } });
			return;
		}
		// FUS-03: official queue preferred; ported promise-chain fallback.
		const queue = compat.mutationQueue ? withFileMutationQueue : withFusedFileQueue;

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

		pi.registerTool<typeof editParameters, EditToolDetails | undefined>({
			...editTemplate,
			parameters: editParameters,
			description: fusedGuidance(editTemplate.description),
			async execute(toolCallId, input, signal, onUpdate, ctx) {
				const { then_run, ...editInput } = input as typeof input & { then_run?: ThenRunInput };
				const result = await executeMutationThenRun({
					toolCallId,
					absolutePath: resolveToolPath(ctx.cwd, input.path),
					thenRun: then_run,
					bashOptions: options.bashOptions,
					signal,
					ctx,
					queue,
					mutate: () => baseEdit(ctx.cwd).execute(toolCallId, editInput, signal, onUpdate, ctx),
				});
				if (
					then_run &&
					result.content.some((block) => block.type === "text" && (block as { text: string }).text.includes(THEN_RUN_SUCCEEDED))
				) {
					noteFused();
				}
				return result;
			},
			// FUS-06: pass the built-in renderers through untouched.
			renderCall: (args, theme, context) => baseEdit(context.cwd).renderCall!(args, theme, context),
			renderResult: (result, resultOptions, theme, context) =>
				baseEdit(context.cwd).renderResult!(result, resultOptions, theme, context),
		});

		pi.registerTool<typeof writeParameters, undefined>({
			...writeTemplate,
			parameters: writeParameters,
			description: fusedGuidance(writeTemplate.description),
			async execute(toolCallId, input, signal, onUpdate, ctx) {
				const { then_run, ...writeInput } = input as typeof input & { then_run?: ThenRunInput };
				const result = await executeMutationThenRun({
					toolCallId,
					absolutePath: resolveToolPath(ctx.cwd, input.path),
					thenRun: then_run,
					bashOptions: options.bashOptions,
					signal,
					ctx,
					queue,
					mutate: () => baseWrite(ctx.cwd).execute(toolCallId, writeInput, signal, onUpdate, ctx),
				});
				if (
					then_run &&
					result.content.some((block) => block.type === "text" && (block as { text: string }).text.includes(THEN_RUN_SUCCEEDED))
				) {
					noteFused();
				}
				return result;
			},
			renderCall: (args, theme, context) => baseWrite(context.cwd).renderCall!(args, theme, context),
			renderResult: (result, resultOptions, theme, context) =>
				baseWrite(context.cwd).renderResult!(result, resultOptions, theme, context),
		});
		selfCheck();
	};
}

export default createActionFusionExtension;
