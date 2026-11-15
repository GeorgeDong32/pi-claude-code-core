// `bg-shell` (BG): the model's `bash` tool with a `background: true` flag.
//
// Vendored from gvanderclay/pi-bg-bash v0.2.1 (MIT), Copyright (c) 2026 Gage
// Vander Clay, and adapted for pi-claude-code-core (BG-D1): the cc-core log
// namespace `~/.pi/agent/cc-core/logs/bg-shell/<session-id>/` (BG-P1),
// CC-parity tool names TaskOutput/TaskStop/TaskList, and the `/tasks` panel.
// BH-R4 (2026-11-14, D-BH-2): a deliberate vendored deviation — an explicit
// `timeout` no longer disables auto-promotion; it becomes the promoted task's
// deadline. Upstream 0.5.0+ instead removed auto-promotion entirely (opposite
// direction); do not port that.
//
// E4 (SPEC SR, 2026-11-15): TaskOutput gained optional `block`/`timeout`
// parameters (seconds, default 30, cap 600 — over the cap throws, never
// clamps). A blocking call waits via `awaitTaskEnd` and claims the completion
// via `claimCompletion`, so no followUp message follows; a plain read of a
// finished task also claims through `claimCompletion`, which — unlike the old
// inline flag in `readOutput` — appends the status row and gzips the log
// (BG-ENTRY-03). A user message typed while waiting (steer or follow-up) ends
// the wait early with the output so far, no error (pi-subagents bg_wait
// parity).
//
// A background call starts the command detached, logs it under the session's
// log directory, and returns a task id at once. When the command exits the
// agent gets one completion message, which starts a turn if the agent is idle.
// The footer shows `bg: N` while N tasks run. A call without `background` is
// Pi's own `bash` over the same wrapper (`foreground.ts`), and moves to the
// background if it outlasts 120 s. Task ids continue across processes within
// one session: session_start seeds the counter past the ids the session's
// status entries already recorded (CH E6).
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

/** TaskOutput's blocking wait: default budget and hard cap, in seconds (E4). */
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
	// E4: a message typed while the agent waits (steer or follow-up) ends open
	// TaskOutput waits so it reaches the model (pi-subagents bg_wait parity).
	// Extension-sourced input is the agent's own doing and must not interrupt.
	const userInputWaits = new Set<AbortController>();
	pi.on("input", (event) => {
		if (event.source === "extension" || !event.streamingBehavior) return;
		for (const controller of userInputWaits) controller.abort();
	});
	// The user can move the running foreground command to the background at once.
	pi.registerShortcut("ctrl+shift+b", {
		description: "Move the running foreground command to the background",
		handler: (ctx) => {
			setContext(ctx);
			// One press promotes every foreground call in flight: with parallel tool
			// calls the turn stays blocked until all finish, so several can be running
			// at once.
			for (const run of foregroundRuns()) run.promote("shortcut");
		},
	});
	const builtin = createBashToolDefinition(process.cwd());
	pi.registerTool({
		...builtin,
		description: `${builtin.description} ${BACKGROUND_DESCRIPTION}`,
		parameters: Type.Object({
			...builtin.parameters.properties,
			// D2 (loop-guard spec) + BH-R4: the timeout never disables auto-
			// backgrounding — past PROMOTE_MS the command still moves to the
			// background and the timeout becomes that task's deadline.
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
				Type.Number({ description: "Seconds (not ms) to wait when `block: true`; default 30, maximum 600" }),
			),
		}),
		async execute(_toolCallId, params, signal) {
			const task = getRegistry().tasks.get(params.id);
			if (task === undefined) throw new Error(`Unknown task id: ${params.id}. TaskList lists this session's tasks.`);
			if (params.timeout !== undefined && params.timeout > BLOCK_MAX_SECONDS)
				throw new Error("timeout is in seconds (not ms); maximum is 600");
			if (params.timeout !== undefined && !params.block) throw new Error("timeout applies only with block: true");
			if (!params.block) {
				// A plain read claims a finished task's completion itself (CC
				// markTaskNotified parity): the result carries the output and the exit
				// state, so no completion message follows — but the status row and the
				// gzip still happen (BG-ENTRY-03; E4 moved the claim out of
				// `readOutput` into `claimCompletion`). A no-op while still running.
				const out = readOutput(task, params);
				claimCompletion(task);
				return { content: [{ type: "text", text: out }], details: undefined };
			}
			const seconds = params.timeout ?? BLOCK_DEFAULT_SECONDS;
			// While this waiter holds the task, no kill path can send the completion
			// message (the `waiting` guard in `notifyOnce`): the waiter claims it.
			task.waiting = (task.waiting ?? 0) + 1;
			// A user message ends the wait early (bg_wait parity): it aborts the
			// wait, not the tool call — the read after it is a normal one.
			const userInput = new AbortController();
			userInputWaits.add(userInput);
			const wait = new AbortController();
			const abortWait = () => wait.abort();
			// Pi always passes a tool signal; a caller that omits it simply never
			// aborts the wait.
			signal?.addEventListener("abort", abortWait);
			userInput.signal.addEventListener("abort", abortWait);
			let ended = false;
			// The wait rejects on abort — the tool's own signal (the call is being
			// cancelled: rethrow without reading) or the user's message (return the
			// output so far). The `waiting` release and listener cleanup run either way.
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
			// Read first, claim second: both synchronous, so no poller tick can slip
			// a message in between, and the gzip inside the claim cannot replace the
			// plain log under a read still in flight.
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
		// CH E6: continue the session's task-id numbering instead of restarting
		// at bg-1 — the ids the transcript's status entries recorded are the
		// floor. Fail-open: a seeding problem must never break session start.
		try {
			const branch = (ctx.sessionManager as { getBranch?: () => unknown }).getBranch?.();
			if (Array.isArray(branch)) seedNextIdFromBranch(branch);
		} catch (error) {
			debugError("id-seed", error);
		}
		rotateDebugLog();
		cleanupOldLogs(getRegistry().tasks.values());
	});
	// Tasks belong to the session: a reload keeps them (the new load takes them over), every other end kills them.
	pi.on("session_shutdown", async (event) => {
		if (event.reason !== "reload") await endSession();
	});
}
