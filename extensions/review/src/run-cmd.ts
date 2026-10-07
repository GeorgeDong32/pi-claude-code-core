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
 */
import { spawn } from "node:child_process";

export interface CmdResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

export type RunCmd = (
	cmd: string,
	args: string[],
	opts: { cwd: string },
) => Promise<CmdResult>;

let injected: RunCmd | undefined;

/** Run a command through the current (possibly test-injected) adapter. */
export function runCmd(cmd: string, args: string[], opts: { cwd: string }): Promise<CmdResult> {
	return (injected ?? defaultRunCmd)(cmd, args, opts);
}

/** Tests inject a fake. */
export function setRunCmd(fn: RunCmd): void {
	injected = fn;
}

export function resetRunCmd(): void {
	injected = undefined;
}

async function defaultRunCmd(cmd: string, args: string[], opts: { cwd: string }): Promise<CmdResult> {
	return new Promise((resolve) => {
		try {
			const child = spawn(cmd, args, { cwd: opts.cwd, stdio: ["ignore", "pipe", "pipe"] });
			let stdout = "";
			let stderr = "";
			child.stdout?.setEncoding("utf-8");
			child.stderr?.setEncoding("utf-8");
			child.stdout?.on("data", (d: string) => (stdout += d));
			child.stderr?.on("data", (d: string) => (stderr += d));
			child.on("error", () => resolve({ stdout, stderr, exitCode: 1 }));
			child.on("close", (code) => resolve({ stdout, stderr, exitCode: code ?? 1 }));
		} catch (err) {
			resolve({ stdout: "", stderr: err instanceof Error ? err.message : "spawn failed", exitCode: 1 });
		}
	});
}
