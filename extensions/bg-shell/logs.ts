// Vendored from gvanderclay/pi-bg-bash v0.2.1 (MIT). Copyright (c) 2026 Gage Vander Clay.
import {
	appendFileSync,
	createReadStream,
	createWriteStream,
	lstatSync,
	readdirSync,
	rmdirSync,
	rmSync,
	statSync,
	unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";

import { debugError } from "./debug.ts";
import { OWNER_FILE, ownerPid, stateRoot } from "./launch.ts";
import { processPort } from "./port.ts";
import type { Task } from "./registry.ts";

const MIB = 1024 * 1024;
const DAY = 24 * 60 * 60 * 1000;
const LOG_LIMIT_BYTES = 100 * MIB;
const CLEANUP_DAYS = 7;
const LOG_NAME = /^bg-\d+\.log(\.gz)?$/;

export function logLimitBytes(): number {
	const set = Number(process.env.CC_CORE_BG_LOG_LIMIT_BYTES);
	return Number.isFinite(set) && set > 0 ? set : LOG_LIMIT_BYTES;
}

export function overLogLimit(task: Task): boolean {
	try {
		return statSync(task.logPath).size > logLimitBytes();
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") debugError("log-limit-stat", error, { log: task.logPath });
		return false;
	}
}

export function appendLimitMarker(task: Task): void {
	const line = `\n__CC_BG_LIMIT__:${task.nonce}\n`;
	const before = statSync(task.logPath).size;
	appendFileSync(task.logPath, line);
	task.limitMarker = { start: before, end: before + Buffer.byteLength(line) };
}

export async function gzipLog(task: Task): Promise<void> {
	if (task.logPath.endsWith(".gz")) return;
	const plain = task.logPath;
	const gz = `${plain}.gz`;
	try {
		await pipeline(createReadStream(plain), createGzip(), createWriteStream(gz, { mode: 0o600 }));
	} catch (error) {
		try {
			rmSync(gz, { force: true, recursive: true });
		} catch (rmError) {
			debugError("gzip-partial-rm", rmError, { log: gz });
		}
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
	task.logPath = gz;
	unlinkSync(plain);
}

function mtimeMs(path: string): number | undefined {
	try {
		return lstatSync(path).mtimeMs;
	} catch (error) {
		debugError("mtime", error, { path });
		return undefined;
	}
}

export function cleanupOldLogs(tasks: Iterable<Task>): void {
	const cutoff = Date.now() - CLEANUP_DAYS * DAY;
	const keep = new Set<string>();
	for (const task of tasks) {
		keep.add(task.logPath);
		keep.add(task.logPath.endsWith(".gz") ? task.logPath.slice(0, -3) : `${task.logPath}.gz`);
	}
	let sessions;
	try {
		sessions = readdirSync(stateRoot(), { withFileTypes: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
	for (const session of sessions) {
		if (!session.isDirectory()) continue;
		const dir = join(stateRoot(), session.name);
		const owner = ownerPid(dir);
		let ownerAlive = false;
		if (owner !== undefined) {
			try {
				ownerAlive = processPort().pidAlive(owner);
			} catch (error) {
				debugError("owner-alive", error, { dir });
				ownerAlive = false;
			}
		}
		if (ownerAlive) continue;
		const dirMt = mtimeMs(dir);
		let entries;
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch (error) {
			debugError("cleanup-readdir", error, { dir });
			continue;
		}
		for (const entry of entries) {
			if (!entry.isFile() || !LOG_NAME.test(entry.name)) continue;
			const path = join(dir, entry.name);
			if (keep.has(path)) continue;
			const mt = mtimeMs(path);
			if (mt !== undefined && mt < cutoff) {
				try {
					unlinkSync(path);
				} catch (error) {
					debugError("cleanup-unlink", error, { path });
				}
			}
		}
		try {
			unlinkSync(join(dir, OWNER_FILE));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") debugError("cleanup-owner-unlink", error, { dir });
		}
		if (dirMt !== undefined && dirMt < cutoff) {
			try {
				rmdirSync(dir);
			} catch (error) {
				const code = (error as NodeJS.ErrnoException).code;
				if (code !== "ENOENT" && code !== "ENOTEMPTY" && code !== "ENOTDIR") throw error;
			}
		}
	}
}
