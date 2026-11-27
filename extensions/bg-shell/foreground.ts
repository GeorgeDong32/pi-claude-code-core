// Vendored from gvanderclay/pi-bg-bash v0.2.1 (MIT). Copyright (c) 2026 Gage Vander Clay.
import { rmSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";

import {
	type BashOperations,
	createBashToolDefinition,
	type ExtensionContext,
	type ExtensionToolContext,
} from "@earendil-works/pi-coding-agent";

import { debug, debugError, taskFields } from "./debug.ts";
import { killGroupNow } from "./kill.ts";
import { resolveShell, SESSION_ENV_KEYS } from "./launch.ts";
import { markerNeedle, openView, type View } from "./logview.ts";
import { processPort } from "./port.ts";
import { adopt, forgetGroup, getRegistry, launchGroup, makeTask, release, reserve, type Task } from "./registry.ts";
import { sanitize } from "./sanitize.ts";

export const PROMOTE_MS = 120_000;
const HINT_MS = 2000;
const HINT_KEY = "cc-core-bg-shell-hint";
const HINT_TEXT = "(ctrl+shift+b to background)";
const LOG_POLL_MS = 50;
const LATE_GRACE_MS = 100;
/** Pi's longest `timeout`, in milliseconds (`MAX_TIMEOUT_MS` in its bash tool). */
const MAX_TIMEOUT_MS = 2_147_483_647;

export type ForegroundRun = {
	command: string;
	startedAt: number;
	promote(by?: "timer" | "shortcut" | "waitFor"): void;
};

export function foregroundRuns(): ReadonlySet<ForegroundRun> {
	return getRegistry().foreground;
}

/** Pi's `resolveTimeoutMs`: the same bounds and the same error text. */
function checkTimeout(timeout: number | undefined): void {
	if (timeout === undefined) return;
	if (!Number.isFinite(timeout) || timeout <= 0) throw new Error("Invalid timeout: must be a finite number of seconds");
	if (timeout * 1000 > MAX_TIMEOUT_MS) throw new Error(`Invalid timeout: maximum is ${MAX_TIMEOUT_MS / 1000} seconds`);
}

function promoteMs(): number {
	const set = Number(process.env.CC_CORE_BG_PROMOTE_MS);
	return Number.isFinite(set) && set > 0 ? set : PROMOTE_MS;
}

function promotable(command: string): boolean {
	return !/^\s*sleep(\s|$)/.test(command);
}

function heldBack(data: Buffer, nonce: string, last: boolean): number {
	const needle = markerNeedle(nonce).toString("latin1");
	const from = data.lastIndexOf(0x0a);
	if (from < 0 || (last && from === data.length - 1)) return 0;
	const tail = data.toString("latin1", from);
	return needle.startsWith(tail) || tail.startsWith(needle) ? data.length - from : 0;
}

type Run = { task: Task | undefined; elapsedMs: number; waitFor?: string; matched: boolean };

function operations(ctx: ExtensionContext, run: Run) {
	return {
		exec: async (command, cwd, { onData, signal, timeout, env }) => {
			checkTimeout(timeout);
			if (signal?.aborted) throw new Error("aborted");
			const port = processPort();
			const reservation = reserve(ctx.sessionManager.getSessionId());
			const { logPath, nonce } = reservation;
			const sessionEnv: Record<string, string> = {};
			for (const key of SESSION_ENV_KEYS) if (env?.[key] !== undefined) sessionEnv[key] = env[key];
			const shell = env === undefined ? undefined : { ...resolveShell(), env };
			let pid: number;
			try {
				pid = await launchGroup({ command, cwd, logPath, nonce, shell, sessionEnv });
			} catch (error) {
				debugError("foreground-launch", error, { command });
				release(reservation);
				throw error;
			}
			const startedAt = Date.now();
			const task = makeTask(reservation, { command, cwd, pid, startedAt });
			let position = 0;
			const decoder = new StringDecoder("utf8");
			let tail = "";
			const scan = (chunk: Buffer) => {
				const { waitFor } = run;
				if (waitFor === undefined || run.matched) return;
				const text = tail + sanitize(decoder.write(chunk));
				if (text.includes(waitFor)) run.matched = true;
				else tail = text.slice(Math.max(0, text.length - (waitFor.length - 1)));
			};
			const pump = (last = false): { code: number } | undefined => {
				let view: View;
				try {
					view = openView(task);
				} catch (error) {
					debugError("foreground-view", error, taskFields(task));
					return undefined;
				}
				try {
					if (view.size > position) {
						const data = view.read(position, view.size);
						const keep = view.marker === undefined ? heldBack(data, nonce, last) : 0;
						if (data.length > keep) {
							onData(data.subarray(0, data.length - keep));
							scan(data.subarray(0, data.length - keep));
						}
						position += data.length - keep;
					}
					return view.marker === undefined ? undefined : { code: view.marker.code };
				} finally {
					view.close();
				}
			};
			return new Promise((resolve, reject) => {
				let done = false;
				const handle: ForegroundRun = { command, startedAt, promote };
				let timer: ReturnType<typeof setTimeout> | undefined;
				let promoteTimer: ReturnType<typeof setTimeout> | undefined;
				let lateTimer: ReturnType<typeof setTimeout> | undefined;
				let hintTimer: ReturnType<typeof setTimeout> | undefined;
				let hintShown = false;
				let exitCode: number | null = null;
				let promoting = false;
				const poll: ReturnType<typeof setInterval> = setInterval(check, LOG_POLL_MS);
				const clearHint = () => {
					clearTimeout(hintTimer);
					hintTimer = undefined;
					if (!hintShown) return;
					hintShown = false;
					try {
						if (ctx.hasUI) ctx.ui.setWidget(HINT_KEY, undefined);
					} catch (error) {
						debugError("hint-clear", error);
					}
				};
				const finish = (settle: () => void) => {
					if (done) return;
					done = true;
					clearInterval(poll);
					clearTimeout(timer);
					clearTimeout(promoteTimer);
					clearTimeout(lateTimer);
					clearHint();
					getRegistry().foreground.delete(handle);
					signal?.removeEventListener("abort", onAbort);
					settle();
				};
				const ended = (settle: () => void) =>
					finish(() => {
						forgetGroup(pid);
						rmSync(logPath, { force: true });
						release(reservation);
						settle();
					});
				function check() {
					if (done) return;
					try {
						const alive = port.pidAlive(pid);
						const before = position;
						const exit = pump();
						if (exit !== undefined) {
							exitCode = exit.code;
							clearHint();
							if (position > before || lateTimer === undefined) {
								clearTimeout(lateTimer);
								lateTimer = setTimeout(() => ended(() => resolve({ exitCode })), LATE_GRACE_MS);
							}
						} else if (!alive) {
							const last = pump(true);
							ended(() => resolve({ exitCode: last?.code ?? null }));
						} else if (run.matched && !promoting) {
							promoting = true;
							promote("waitFor");
						}
					} catch (error) {
						ended(() => reject(error));
					}
				}
				const stop = (error: Error) => {
					if (done) return;
					finish(() => {
						forgetGroup(pid);
						killGroupNow(pid).then(
							() => {
								try {
									pump(true);
								} catch (error) {
									debugError("foreground-stop-pump", error, taskFields(task));
								}
								rmSync(logPath, { force: true });
								release(reservation);
								reject(error);
							},
							(killError) => {
								debugError("foreground-stop-kill", killError, taskFields(task));
								reject(killError);
							},
						);
					});
				};
				function onAbort() {
					stop(new Error("aborted"));
				}
				function promote(by: "timer" | "shortcut" | "waitFor" = "shortcut") {
					if (done) return;
					check();
					if (done || exitCode !== null) return;
					debug("promote", { ...taskFields(task), by, elapsedMs: Date.now() - startedAt });
					finish(() => {
						pump(true);
						task.readPosition = position;
						run.elapsedMs = Date.now() - startedAt;
						if (timeout !== undefined) task.deadline = startedAt + timeout * 1000;
						run.task = adopt(task);
						resolve({ exitCode: 0 });
					});
				}
				getRegistry().foreground.add(handle);
				if (timeout !== undefined) timer = setTimeout(() => stop(new Error(`timeout:${timeout}`)), timeout * 1000);
				if (promotable(command)) promoteTimer = setTimeout(() => promote("timer"), promoteMs());
				if (ctx.hasUI)
					hintTimer = setTimeout(() => {
						try {
							if (!ctx.hasUI) return;
							hintShown = true;
							ctx.ui.setWidget(HINT_KEY, [HINT_TEXT], { placement: "belowEditor" });
						} catch (error) {
							debugError("hint-show", error);
						}
					}, HINT_MS);
				if (signal?.aborted) onAbort();
				else signal?.addEventListener("abort", onAbort, { once: true });
			});
		},
	} satisfies BashOperations;
}

function retarget(text: string, piFile: string, task: Task): string {
	return text.replace(
		`Full output: ${piFile}]`,
		`Full output so far: ${task.logPath}; it is gzipped to ${task.logPath}.gz once the task ends. TaskOutput ${task.id} continues after this.]`,
	);
}

function promotedText(task: Task, run: Run, output: string): string {
	const seconds = Math.round(run.elapsedMs / 100) / 10;
	const head = run.matched
		? `"${run.waitFor}" appeared after ${seconds} s; the command keeps running as background task ${task.id}. `
		: `Command still running after ${seconds} s; moved to the background as task ${task.id}. `;
	return (
		head +
		"Its completion is reported automatically." +
		(run.waitFor !== undefined && !run.matched ? ` "${run.waitFor}" never appeared in the output.` : "") +
		"\n\n" +
		`Output so far:\n${output === "(no output)" ? "" : output}`
	);
}

export async function runForeground(
	toolCallId: string,
	params: { command: string; timeout?: number; waitFor?: string },
	signal: AbortSignal | undefined,
	onUpdate: Parameters<ReturnType<typeof createBashToolDefinition>["execute"]>[3],
	ctx: ExtensionToolContext,
) {
	const { waitFor, ...piParams } = params;
	if (waitFor === "") throw new Error("waitFor must not be empty.");
	const run: Run = { task: undefined, elapsedMs: 0, waitFor, matched: false };
	const delegate = createBashToolDefinition(ctx.cwd, { operations: operations(ctx, run) });
	let result: Awaited<ReturnType<typeof delegate.execute>>;
	try {
		result = await delegate.execute(toolCallId, piParams, signal, onUpdate, ctx);
	} catch (error) {
		// Pi's bash throws its output with the status (aborted, timed out, no exit code).
		if (error instanceof Error) error.message = sanitize(error.message);
		throw error;
	}
	// Pi's bash hands the agent the output as the command wrote it — sanitize what reaches the model; its own temp file and the task's log stay raw.
	result = {
		...result,
		content: result.content.map((part) => (part.type === "text" ? { ...part, text: sanitize(part.text) } : part)),
	};
	const structured = (result as { structuredContent?: { output?: unknown } }).structuredContent;
	if (typeof structured?.output === "string")
		result = { ...result, structuredContent: { ...structured, output: sanitize(structured.output) } } as typeof result;
	if (run.task === undefined) return result;
	let output = result.content[0]?.type === "text" ? result.content[0].text : "";
	const piFile = result.details?.fullOutputPath;
	if (piFile !== undefined) {
		output = retarget(output, piFile, run.task);
		rmSync(piFile, { force: true });
	}
	return {
		content: [{ type: "text" as const, text: promotedText(run.task, run, output) }],
		details: undefined,
	};
}
