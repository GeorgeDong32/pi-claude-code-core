import { spawn } from "node:child_process";

export interface CmdResult {
	stdout: string;
	stderr: string;
	exitCode: number;
	timedOut?: boolean;
}

export interface RunCmdOpts {
	cwd: string;
	timeoutMs?: number;
	env?: Record<string, string>;
}

export type RunCmd = (cmd: string, args: string[], opts: RunCmdOpts) => Promise<CmdResult>;

export const RUN_CMD_KILL_GRACE_MS = 2_000;
export const RUN_CMD_PIPE_DRAIN_MS = 250;

let injected: RunCmd | undefined;

export function runCmd(cmd: string, args: string[], opts: RunCmdOpts): Promise<CmdResult> {
	return (injected ?? defaultRunCmd)(cmd, args, opts);
}

export function setRunCmd(fn: RunCmd): void {
	injected = fn;
}

export function resetRunCmd(): void {
	injected = undefined;
}

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
			const hasTimeout = opts.timeoutMs !== undefined
				&& Number.isFinite(opts.timeoutMs)
				&& opts.timeoutMs > 0;
			const destroyStdio = () => {
				try {
					child.stdout?.destroy();
					child.stderr?.destroy();
				} catch {
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
				timer = setTimeout(() => setImmediate(() => {
					if (settled) return;
					if (exited) {
						destroyStdio();
						finalize({ stdout, stderr, exitCode: childExitCode ?? 1 });
						return;
					}
					timedOut = true;
					child.kill("SIGTERM");
					killTimer = setTimeout(() => {
						try {
							child.kill("SIGKILL");
						} catch {
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
