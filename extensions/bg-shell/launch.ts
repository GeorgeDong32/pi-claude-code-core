// Vendored from gvanderclay/pi-bg-bash v0.2.1 (MIT). Copyright (c) 2026 Gage Vander Clay.
import { spawn } from "node:child_process";
import {
	accessSync,
	chmodSync,
	closeSync,
	constants,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

import * as pi from "@earendil-works/pi-coding-agent";

import { debug, debugError } from "./debug.ts";
import { needsPipefail, pipefailArgs } from "./pipefail.ts";

const WRAPPER = [
	"cmd=$1; nonce=$2; shift 3; exec 3>&2 2>/dev/null",
	'( "$@" "$cmd" 2>&3 3>&- ); code=$?',
	'printf "\\n__CC_BG_EXIT__:%s:%s\\n" "$nonce" "$code"',
].join("\n");

const WATCH =
	'pi=$1; grp=$2; nonce=$3; exec 2>/dev/null; while kill -0 "$pi"; do kill -s 0 -- "-$grp" || exit 0; sleep 1; done; kill -s 0 -- "-$grp" || exit 0; printf "\\n__CC_BG_GONE__:%s\\n" "$nonce"; kill -s KILL -- "-$grp"';

export function stateRoot(): string {
	return join(homedir(), ".pi", "agent", "cc-core", "logs", "bg-shell");
}

export const OWNER_FILE = "owner.pid";

export function sessionLogDir(sessionId: string): string {
	const dir = join(stateRoot(), sessionId);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	chmodSync(dir, 0o700);
	const tmp = join(dir, `${OWNER_FILE}.${process.pid}.tmp`);
	try {
		writeFileSync(tmp, String(process.pid), { mode: 0o600 });
		renameSync(tmp, join(dir, OWNER_FILE));
	} catch (error) {
		debugError("owner-marker", error, { dir });
		try {
			rmSync(tmp, { force: true });
		} catch (rmError) {
			debugError("owner-marker-rm", rmError, { dir });
		}
	}
	return dir;
}

export function ownerPid(dir: string): number | undefined {
	try {
		const pid = Number(readFileSync(join(dir, OWNER_FILE), "utf8").trim());
		// Bounded like `process.kill`: a larger value throws rather than answering liveness.
		return Number.isInteger(pid) && pid > 1 && pid <= 0x7fffffff ? pid : undefined;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") debugError("owner-pid", error, { dir });
		return undefined;
	}
}

export type Shell = { shell: string; args: string[]; env: NodeJS.ProcessEnv };

// pi's getShellConfig/getShellEnv exports vary across pi versions and can throw — resolveShell must degrade (missing → `sh -c` / process.env + <agent dir>/bin).
export function resolveShell(): Shell {
	const api = pi as unknown as Record<string, ((...args: never[]) => unknown) | undefined>;
	let shell = "sh";
	let args = ["-c"];
	try {
		const config = api.getShellConfig?.() as { shell: string; args: string[] } | undefined;
		if (config !== undefined) ({ shell, args } = config);
	} catch (error) {
		debugError("shell-config", error);
	}
	let env: NodeJS.ProcessEnv | undefined;
	try {
		env = api.getShellEnv?.() as NodeJS.ProcessEnv | undefined;
	} catch (error) {
		debugError("shell-env", error);
	}
	if (env === undefined) {
		env = { ...process.env };
		try {
			const bin = join(api.getAgentDir?.() as string, "bin");
			const key = Object.keys(env).find((k) => k.toLowerCase() === "path") ?? "PATH";
			const current = env[key] ?? "";
			if (!current.split(delimiter).includes(bin)) env[key] = [bin, current].filter(Boolean).join(delimiter);
		} catch (error) {
			debugError("agent-dir", error);
		}
	}
	return { shell, args, env };
}

export type LaunchOptions = {
	command: string;
	cwd: string;
	logPath: string;
	nonce: string;
	shell?: Shell;
	piPid?: number;
	sessionEnv?: Record<string, string>;
};

export const SESSION_ENV_KEYS = ["PI_SESSION_ID", "PI_SESSION_FILE", "PI_PROVIDER", "PI_MODEL", "PI_REASONING_LEVEL"];

export async function launch(options: LaunchOptions): Promise<number> {
	const { command, cwd, logPath, nonce } = options;
	try {
		accessSync(cwd, constants.F_OK);
	} catch (error) {
		debugError("launch-cwd", error, { cwd });
		throw new Error(`Working directory does not exist: ${cwd}\nCannot execute bash commands.`);
	}
	const { shell, args, env: base } = options.shell ?? resolveShell();
	const finalArgs = needsPipefail(command) ? pipefailArgs(shell, args) : args;
	if (finalArgs !== args) debug("pipefail", { shell, command: command.slice(0, 200) });
	const env = { ...base };
	for (const key of SESSION_ENV_KEYS) delete env[key];
	Object.assign(env, options.sessionEnv);
	const fd = openSync(logPath, "wx", 0o600);
	try {
		const child = spawn(
			"sh",
			["-c", WRAPPER, "cc-bg", command, nonce, String(options.piPid ?? process.pid), shell, ...finalArgs],
			{
				cwd,
				env,
				detached: true,
				stdio: ["ignore", fd, fd],
			},
		);
		await new Promise<void>((resolve, reject) => {
			child.once("spawn", resolve);
			child.once("error", reject);
		});
		child.on("error", (error) => debugError("child-error", error, { pid: child.pid })); // a later error must not become an uncaught exception
		child.unref();
		if (child.pid === undefined) throw new Error(`could not start the shell for ${JSON.stringify(command)}`);
		try {
			const watcher = spawn(
				"sh",
				["-c", WATCH, "cc-bg-watch", String(options.piPid ?? process.pid), String(child.pid), nonce],
				{ detached: true, stdio: ["ignore", fd, fd] },
			);
			watcher.on("error", (error) => debugError("watcher-error", error, { pid: child.pid }));
			watcher.unref();
		} catch (error) {
			debugError("watcher-spawn", error, { pid: child.pid });
		}
		return child.pid;
	} catch (error) {
		rmSync(logPath, { force: true });
		throw error;
	} finally {
		closeSync(fd);
	}
}
