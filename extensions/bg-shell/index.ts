// Vendored from gvanderclay/pi-bg-bash v0.2.1 (MIT), Copyright (c) 2026 Gage
// Vander Clay, and adapted for pi-claude-code-core (BG-D1): the cc-core log
// BH-R4 (2026-11-14, D-BH-2): a deliberate vendored deviation — an explicit
// `timeout` no longer disables auto-promotion; it becomes the promoted task's
// deadline. Upstream 0.5.0+ instead removed auto-promotion entirely (opposite
// direction); do not port that.
import { createBashToolDefinition, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { tasksCommand } from "./bg.ts";
import { debugError, rotateDebugLog } from "./debug.ts";
import { foregroundRuns, PROMOTE_MS, runForeground } from "./foreground.ts";
import { GRACE_MS } from "./kill.ts";
import { cleanupOldLogs } from "./logs.ts";
import { stateText, taskLine } from "./notify.ts";
import { readOutput } from "./output.ts";
import { attach, awaitTaskEnd, claimCompletion, endSession, getRegistry, killTask, seedNextIdFromBranch, setContext, startTask } from "./registry.ts";

const BLOCK_DEFAULT_SECONDS = 30;
const BLOCK_MAX_SECONDS = 600;

const BACKGROUND_DESCRIPTION =
	"Set `background: true` for a command you expect to outlast a minute or two, such as a long build, a deploy or a server, " +
	"when you have other work to do meanwhile or nothing to do until it ends. " +
	"The call returns a task id at once; when the command exits, a message with its exit status arrives " +
	"and starts a turn if you are idle, so do not sleep or poll `TaskOutput` to wait for it. " +
	"Read a finished task's output with `TaskOutput` — the notification itself carries none. " +
	"To wait for something outside this machine, such as CI, background one command that blocks until it is done, " +
	"such as `gh run watch <run-id> --exit-status` or `gh pr checks <number> --watch`, instead of running `sleep N` and a check yourself. " +
	`A foreground command still running after ${PROMOTE_MS / 1000} s (unless it starts with \`sleep\`) moves to the background on its own; an explicit \`timeout\` becomes the backgrounded task's deadline.`;

export default function (pi: ExtensionAPI): void {
	attach(pi);
	const userInputWaits = new Set<AbortController>();
	pi.on("input", (event) => {
		if (event.source === "extension" || !event.streamingBehavior) return;
		for (const controller of userInputWaits) controller.abort();
	});
	pi.registerShortcut("ctrl+shift+b", {
		description: "Move the running foreground command to the background",
		handler: (ctx) => {
			setContext(ctx);
			for (const run of foregroundRuns()) run.promote("shortcut");
		},
	});
	const builtin = createBashToolDefinition(process.cwd());
	pi.registerTool({
		...builtin,
		description: `${builtin.description} ${BACKGROUND_DESCRIPTION}`,
		parameters: Type.Object({
			...builtin.parameters.properties,
			timeout: Type.Optional(
				Type.Number({
					description: `Seconds (not ms). Still running after ${PROMOTE_MS / 1000} s → background; timeout becomes its deadline.`,
				}),
			),
			waitFor: Type.Optional(
				Type.String({
					description:
						'Text to wait for in the output, such as "listening on" for a server. When it appears the call returns the output so far and the command keeps running as a background task. A `timeout` then limits the task, not the call. Omit it when you are not waiting for anything — never a placeholder value.',
				}),
			),
			background: Type.Optional(
				Type.Boolean({ description: "Run the command as a detached background task and return its id" }),
			),
			description: Type.Optional(
				Type.String({
					description:
						"A short human-readable label for this command (3-6 words), shown with the task id everywhere tasks are listed. Optional; ids alone are hard to tell apart.",
				}),
			),
		}),
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			setContext(ctx);
			if (params.waitFor !== undefined && params.background)
				throw new Error("waitFor applies to foreground calls: drop `background: true`, or drop `waitFor`.");
			if (!params.background) return runForeground(toolCallId, params, signal, onUpdate, ctx);
			const task = await startTask(params.command, ctx, {
				timeout: params.timeout,
				description: params.description,
			});
			return {
				content: [
					{
						type: "text",
						text: `Started background task ${task.id}. Its completion is reported automatically.`,
					},
				],
				details: undefined,
			};
		},
	});
	pi.registerTool({
		name: "TaskOutput",
		label: "TaskOutput",
		description:
			"Read the output of a background bash task from where you last stopped, capped like `bash`. " +
			"Each call returns only output you have not read yet and says how much remains. " +
			"`latest: true` skips to the newest unread output. `filter` is a regex that keeps only matching lines. " +
			"The result also says whether the task is running or has exited. " +
			"With `block: true` the call waits for the task to end before returning, up to `timeout` seconds " +
			"(default 30, maximum 600); a user message ends the wait early and returns the output so far.",
		parameters: Type.Object({
			id: Type.String({ description: "The task id returned by a background bash call" }),
			latest: Type.Optional(Type.Boolean({ description: "Skip to the end of the log and return the newest output" })),
			filter: Type.Optional(Type.String({ description: "Regex; return only the matching lines of the output read" })),
			block: Type.Optional(
				Type.Boolean({
					description:
						"Wait for the task to end before returning (default false: return the unread output at once)",
				}),
			),
			timeout: Type.Optional(
				Type.Number({ description: "Seconds (not ms), above 0, to wait when `block: true`; default 30, maximum 600" }),
			),
		}),
		async execute(_toolCallId, params, signal) {
			const task = getRegistry().tasks.get(params.id);
			if (task === undefined) throw new Error(`Unknown task id: ${params.id}. TaskList lists this session's tasks.`);
			if (params.timeout !== undefined && (!Number.isFinite(params.timeout) || params.timeout <= 0))
				throw new Error("timeout is in seconds (not ms); must be a finite number above 0");
			if (params.timeout !== undefined && params.timeout > BLOCK_MAX_SECONDS)
				throw new Error("timeout is in seconds (not ms); maximum is 600");
			if (params.timeout !== undefined && !params.block) throw new Error("timeout applies only with block: true");
			if (!params.block) {
				const out = readOutput(task, params);
				claimCompletion(task);
				return { content: [{ type: "text", text: out }], details: undefined };
			}
			const seconds = params.timeout ?? BLOCK_DEFAULT_SECONDS;
			task.waiting = (task.waiting ?? 0) + 1;
			const userInput = new AbortController();
			userInputWaits.add(userInput);
			const wait = new AbortController();
			const abortWait = () => wait.abort();
			signal?.addEventListener("abort", abortWait);
			userInput.signal.addEventListener("abort", abortWait);
			let ended = false;
			let waitError: unknown;
			try {
				ended = await awaitTaskEnd(task, seconds * 1000, wait.signal);
			} catch (error) {
				waitError = error;
			} finally {
				task.waiting = Math.max(0, (task.waiting ?? 1) - 1);
				userInputWaits.delete(userInput);
				signal?.removeEventListener("abort", abortWait);
				userInput.signal.removeEventListener("abort", abortWait);
			}
			if (signal?.aborted) throw waitError ?? new Error("aborted");
			const out = readOutput(task, params);
			claimCompletion(task);
			if (!ended && !userInput.signal.aborted)
				return { content: [{ type: "text", text: `${out}\n[still running after ${seconds} s]` }], details: undefined };
			return { content: [{ type: "text", text: out }], details: undefined };
		},
	});
	pi.registerTool({
		name: "TaskList",
		label: "TaskList",
		description:
			"List every background bash task of this session with its id, label (or command when no label was given), " +
			"state, runtime, and exit code or reason. States: running, exited, killed, exit unknown.",
		parameters: Type.Object({}),
		async execute() {
			const tasks = [...getRegistry().tasks.values()];
			const text = tasks.length === 0 ? "No background tasks." : tasks.map(taskLine).join("\n");
			return { content: [{ type: "text", text }], details: undefined };
		},
	});
	pi.registerTool({
		name: "TaskStop",
		label: "TaskStop",
		description:
			"Stop a background bash task and everything it started: SIGTERM to its process group, then SIGKILL " +
			`after about ${GRACE_MS / 1000} s if anything is left. No completion message follows; the result reports the final state.`,
		parameters: Type.Object({
			id: Type.String({ description: "The task id returned by a background bash call" }),
		}),
		async execute(_toolCallId, params) {
			const task = getRegistry().tasks.get(params.id);
			if (task === undefined) throw new Error(`Unknown task id: ${params.id}. TaskList lists this session's tasks.`);
			const outcome = await killTask(task, "killed by agent", { notify: false });
			const text =
				outcome === "finished"
					? `Task ${task.id} has already finished: ${stateText(task)}.`
					: outcome === "gone"
						? `Task ${task.id} had already ended: exit unknown.`
						: outcome === "cleared"
							? `Task ${task.id} had already finished: ${stateText(task)}; stopped the processes it left running.`
							: outcome === "leftover-stuck"
								? `Task ${task.id} had already finished: ${stateText(task)}; the processes it left running survived SIGKILL and are still running.`
								: outcome === "stuck"
									? `Task ${task.id} was sent SIGKILL, but its process group is still running.`
									: `Task ${task.id} killed; its process group is gone.`;
			return { content: [{ type: "text", text }], details: undefined };
		},
	});
	pi.registerCommand("tasks", {
		description: "List and manage background tasks (CC parity)",
		handler: async (_args, ctx) => {
			setContext(ctx);
			await tasksCommand(ctx);
		},
	});
	pi.on("session_start", (_event, ctx) => {
		setContext(ctx);
		try {
			const branch = (ctx.sessionManager as { getBranch?: () => unknown }).getBranch?.();
			if (Array.isArray(branch)) seedNextIdFromBranch(branch);
		} catch (error) {
			debugError("id-seed", error);
		}
		rotateDebugLog();
		cleanupOldLogs(getRegistry().tasks.values());
	});
	pi.on("session_shutdown", async (event) => {
		if (event.reason !== "reload") await endSession();
	});
}
