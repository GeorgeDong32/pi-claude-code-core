// Vendored from gvanderclay/pi-bg-bash v0.2.1 (MIT). Copyright (c) 2026 Gage Vander Clay.
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { gzipSync } from "node:zlib";

import { stateRoot } from "./launch.ts";
import { oneLine } from "./notify.ts";
import type { Task } from "./registry.ts";

const ROTATE_ABOVE_BYTES = 5 * 1024 * 1024;
const GENERATIONS = 5;

export function debugOn(): boolean {
	return process.env.CC_CORE_BG_DEBUG === "1";
}

function debugPath(): string {
	return join(stateRoot(), "debug.log");
}

export function debug(event: string, fields: Record<string, unknown> = {}): void {
	if (!debugOn()) return;
	try {
		const line: Record<string, unknown> = { t: new Date().toISOString(), event, ...fields };
		if (typeof line.command === "string") line.command = oneLine(line.command);
		mkdirSync(stateRoot(), { recursive: true, mode: 0o700 });
		appendFileSync(debugPath(), `${JSON.stringify(line)}\n`, { mode: 0o600 });
	} catch {
	}
}

export function debugError(where: string, error: unknown, fields: Record<string, unknown> = {}): void {
	const e = error as { message?: unknown; code?: unknown; stack?: unknown } | null | undefined;
	debug("error", {
		where,
		...fields,
		error: typeof e?.message === "string" ? e.message : String(error),
		code: e?.code,
		stack: e?.stack,
	});
}

export function taskFields(task: Task): Record<string, unknown> {
	return {
		task: task.id,
		session: basename(dirname(task.logPath)),
		pid: task.pid,
		command: task.command,
	};
}

export function exitFields(task: Task): Record<string, unknown> {
	return { ...taskFields(task), state: task.state, exitCode: task.exitCode, reason: task.reason };
}

const generation = (n: number): string => `${debugPath()}.${n}.gz`;

export function rotateDebugLog(): void {
	if (!debugOn()) return;
	try {
		const log = debugPath();
		if (!existsSync(log) || statSync(log).size <= ROTATE_ABOVE_BYTES) return;
		const claimed = join(dirname(log), `debug.log.${process.pid}.${Date.now()}.rotating`);
		try {
			renameSync(log, claimed);
		} catch {
			return;
		}
		if (existsSync(generation(GENERATIONS))) unlinkSync(generation(GENERATIONS));
		for (let n = GENERATIONS - 1; n >= 1; n--) {
			if (existsSync(generation(n))) renameSync(generation(n), generation(n + 1));
		}
		writeFileSync(generation(1), gzipSync(readFileSync(claimed)), { mode: 0o600 });
		unlinkSync(claimed);
		debug("rotate", { generations: GENERATIONS });
	} catch (error) {
		debugError("rotate", error);
	}
}
