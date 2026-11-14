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
 */
import { spawn } from "node:child_process";

export interface CmdResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

export interface RunCmdOpts {
	cwd: string;
	/** Kill the child after this many ms and resolve non-zero with a
	 * "timed out" note on stderr. Absent = wait indefinitely (legacy). */
	timeoutMs?: number;
	/** Extra environment merged over process.env for this one call. */
	env?: Record<string, string>;
}

export type RunCmd = (cmd: string, args: string[], opts: RunCmdOpts) => Promise<CmdResult>;

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
			let timer: ReturnType<typeof setTimeout> | undefined;
			if (opts.timeoutMs !== undefined) {
				timer = setTimeout(() => {
					timedOut = true;
					child.kill();
				}, opts.timeoutMs);
			}
			child.stdout?.setEncoding("utf-8");
			child.stderr?.setEncoding("utf-8");
			child.stdout?.on("data", (d: string) => (stdout += d));
			child.stderr?.on("data", (d: string) => (stderr += d));
			child.on("error", () => {
				if (timer) clearTimeout(timer);
				resolve({ stdout, stderr, exitCode: 1 });
			});
			child.on("close", (code) => {
				if (timer) clearTimeout(timer);
				if (timedOut) {
					const note = `${cmd} timed out after ${opts.timeoutMs}ms`;
					resolve({ stdout, stderr: stderr ? `${stderr}\n${note}` : note, exitCode: 1 });
					return;
				}
				resolve({ stdout, stderr, exitCode: code ?? 1 });
			});
		} catch (err) {
			resolve({ stdout: "", stderr: err instanceof Error ? err.message : "spawn failed", exitCode: 1 });
		}
	});
}
