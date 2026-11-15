/**
 * review/src/run-cmd.ts — the ONE command-execution adapter (SPEC
 * 2026-10-07 P3-1 S1).
 *
 * Was three copies: review-report.ts / target-workspace.ts / review-run.ts
 * each shipped an identical spawn loop with its own injector
 * (setReviewRunCmd / setTargetWorkspaceCmd / setRunCmd). The spawn
 * implementation is the review-report.ts version — the only one that
 * preserved the spawn error message instead of collapsing it to
 * "spawn failed" (behavior note: the other two files' synchronous-spawn
 * failures now surface err.message; the exitCode contract is identical).
 *
 * Test discipline: every suite that injects a fake MUST reset in
 * finally/afterEach — the injector is a shared global; concurrent
 * execution with a live stub is forbidden. Fakes dispatch on cmd + cwd.
 *
 * D-FX-1 (2026-11-14): two optional opts — `timeoutMs` (kill the child on
 * expiry; the promise resolves non-zero with a "timed out" note appended
 * to stderr) and `env` (merged over process.env for this one call, e.g.
 * GIT_TERMINAL_PROMPT=0). Both are optional: existing callers and injected
 * fakes are unchanged when they are absent. `defaultRunCmd` is exported so
 * test spies can wrap the REAL spawn loop while recording calls.
 *
 * SPEC CH (2026-11-15) timeout hardening:
 *   - T1: expiry escalates — SIGTERM first, SIGKILL after
 *     RUN_CMD_KILL_GRACE_MS (2s). When the child has exited but `close`
 *     has not fired (an orphaned grandchild holds the stdio pipes), a
 *     brief drain (RUN_CMD_PIPE_DRAIN_MS) is followed by a stdio destroy
 *     so `close` fires and the promise resolves bounded.
 *   - T2: if the timer fires after the child ALREADY exited, the promise
 *     resolves with the child's real exit code (not a timeout) and stops
 *     waiting on the pipes.
 *   - T3: `timeoutMs <= 0` or non-finite means NO timeout (Node
 *     convention) — the timer is simply not armed.
 *   - T4/S5: timed-out results carry `timedOut: true` on CmdResult so
 *     callers branch on data, not stderr text.
 *   - CH-8a (2026-11-15): the timer body is deferred one check-phase hop
 *     (setTimeout → setImmediate) so a child that died before a due timer
 *     is delivered by the poll phase first and resolves with its real exit
 *     code (T5) instead of being misclassified as a timeout. A child
 *     exiting after that poll phase but before the check phase is truly
 *     simultaneous with the deadline — inherent, not fixed. The timeout
 *     classification deliberately ignores the exit signal (a child that
 *     traps TERM and exits 0 would be misread; compare T1a).
 */
import { spawn } from "node:child_process";

export interface CmdResult {
	stdout: string;
	stderr: string;
	exitCode: number;
	/** T4/S5: true when the call was resolved by the timeout machinery
	 *  (SIGTERM/SIGKILL escalation). Absent = not timed out. */
	timedOut?: boolean;
}

export interface RunCmdOpts {
	cwd: string;
	/** Kill the child after this many ms and resolve non-zero with a
	 *  "timed out" note on stderr (escalating SIGTERM → SIGKILL after
	 *  RUN_CMD_KILL_GRACE_MS). Absent, <= 0, or non-finite = wait
	 *  indefinitely (no timeout; Node convention, T3). */
	timeoutMs?: number;
	/** Extra environment merged over process.env for this one call. */
	env?: Record<string, string>;
}

export type RunCmd = (cmd: string, args: string[], opts: RunCmdOpts) => Promise<CmdResult>;

/** T1: grace between the SIGTERM and the SIGKILL on timeout expiry. */
export const RUN_CMD_KILL_GRACE_MS = 2_000;
/** T1: how long a dead child's still-open stdio pipes are drained before
 *  they are destroyed (an orphaned grandchild holding them would otherwise
 *  stall `close` indefinitely). */
export const RUN_CMD_PIPE_DRAIN_MS = 250;

let injected: RunCmd | undefined;

/** Run a command through the current (possibly test-injected) adapter. */
export function runCmd(cmd: string, args: string[], opts: RunCmdOpts): Promise<CmdResult> {
	return (injected ?? defaultRunCmd)(cmd, args, opts);
}

/** Tests inject a fake. */
export function setRunCmd(fn: RunCmd): void {
	injected = fn;
}

export function resetRunCmd(): void {
	injected = undefined;
}

/** The real spawn loop — exported so tests can wrap it with a recording
 * spy and keep real behavior (D-FX-1). */
export async function defaultRunCmd(cmd: string, args: string[], opts: RunCmdOpts): Promise<CmdResult> {
	return new Promise((resolve) => {
		try {
			const child = spawn(cmd, args, {
				cwd: opts.cwd,
				stdio: ["ignore", "pipe", "pipe"],
				...(opts.env ? { env: { ...process.env, ...opts.env } } : {}),
			});
			let stdout = "";
			let stderr = "";
			let timedOut = false;
			let settled = false;
			let exited = false;
			let childExitCode: number | null = null;
			let timer: ReturnType<typeof setTimeout> | undefined;
			let killTimer: ReturnType<typeof setTimeout> | undefined;
			let drainTimer: ReturnType<typeof setTimeout> | undefined;
			// T3: <= 0 or non-finite means NO timeout (Node convention).
			const hasTimeout = opts.timeoutMs !== undefined
				&& Number.isFinite(opts.timeoutMs)
				&& opts.timeoutMs > 0;
			const destroyStdio = () => {
				try {
					child.stdout?.destroy();
					child.stderr?.destroy();
				} catch {
					/* already gone */
				}
			};
			const finalize = (r: CmdResult) => {
				if (settled) return;
				settled = true;
				if (timer) clearTimeout(timer);
				if (killTimer) clearTimeout(killTimer);
				if (drainTimer) clearTimeout(drainTimer);
				resolve(r);
			};
			if (hasTimeout) {
				// CH-8a: the timer body is deferred one libuv phase (check
				// phase via setImmediate). Without the hop, timers run BEFORE
				// poll in one iteration: a child that already died (zombie,
				// exit pending) plus a timer due in the same iteration sees
				// exited === false and is misclassified as a timeout. The
				// poll phase in between delivers the pending exit, so the T2
				// branch below resolves with the real exit code. The
				// `settled` guard covers an immediate firing after finalize.
				// Inherent (not fixed): a child exiting after that poll phase
				// but before the check phase is truly simultaneous with the
				// deadline. Deliberately NOT "exit signal === null means not
				// timed out" — that would misclassify a child that traps TERM
				// and exits 0 (compare T1a).
				timer = setTimeout(() => setImmediate(() => {
					if (settled) return;
					if (exited) {
						// T2: the child is already dead — this is not a timeout.
						// Resolve with the real exit code and stop waiting on
						// the pipes (a grandchild may still hold them).
						destroyStdio();
						finalize({ stdout, stderr, exitCode: childExitCode ?? 1 });
						return;
					}
					// T1: escalate — SIGTERM first, SIGKILL after the grace.
					timedOut = true;
					child.kill("SIGTERM");
					killTimer = setTimeout(() => {
						try {
							child.kill("SIGKILL");
						} catch {
							/* already gone */
						}
					}, RUN_CMD_KILL_GRACE_MS);
				}), opts.timeoutMs);
			}
			child.stdout?.setEncoding("utf-8");
			child.stderr?.setEncoding("utf-8");
			child.stdout?.on("data", (d: string) => (stdout += d));
			child.stderr?.on("data", (d: string) => (stderr += d));
			child.on("error", () => {
				finalize({ stdout, stderr, exitCode: 1 });
			});
			child.on("exit", (code) => {
				exited = true;
				childExitCode = code ?? 1;
				// T1: the child is dead but `close` has not fired — a
				// grandchild is holding the stdio pipes. Drain briefly, then
				// destroy them so `close` fires and the promise resolves
				// bounded. Only under an armed timeout: without one, the
				// legacy behavior (wait for close) is preserved.
				if (hasTimeout && !settled) {
					drainTimer = setTimeout(destroyStdio, RUN_CMD_PIPE_DRAIN_MS);
				}
			});
			child.on("close", (code) => {
				if (timedOut) {
					const note = `${cmd} timed out after ${opts.timeoutMs}ms`;
					finalize({ stdout, stderr: stderr ? `${stderr}\n${note}` : note, exitCode: 1, timedOut: true });
					return;
				}
				finalize({ stdout, stderr, exitCode: code ?? 1 });
			});
		} catch (err) {
			resolve({ stdout: "", stderr: err instanceof Error ? err.message : "spawn failed", exitCode: 1 });
		}
	});
}
