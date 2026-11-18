// Vendored from gvanderclay/pi-bg-bash v0.2.1 (MIT). Copyright (c) 2026 Gage Vander Clay.
// The task registry, kept on `globalThis` because Pi loads extensions with
// `moduleCache: false`: module state does not survive `/reload`, this does.
// It holds the 2 s poller, the 250 ms log-limit check, and the current `pi` and
// context, which each load refreshes.
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { debug, debugError, exitFields, taskFields } from "./debug.ts";
import type { ForegroundRun } from "./foreground.ts";
import { killGroup, killGroupNow } from "./kill.ts";
import { type LaunchOptions, sessionLogDir } from "./launch.ts";
import { appendStatusEntry, STATUS_ENTRY_TYPE } from "./status-entry.ts";
import { appendLimitMarker, gzipLog, overLogLimit } from "./logs.ts";
import { locateMarker, type Marker } from "./logview.ts";
import { sendCompletion } from "./notify.ts";
import { processPort } from "./port.ts";

const KEY = Symbol.for("cc-core.bg-shell.registry");
export const POLL_MS = 2000;
const LOG_LIMIT_MS = 250;
const READ_FAILURES_LIMIT = 5;

export type TaskState = "running" | "exited" | "exit-unknown" | "killed";

export type KillReason = "killed by agent" | "killed by user" | "timed out" | "log limit passed";

export type Task = {
	id: string;
	command: string;
	description?: string;
	cwd: string;
	logPath: string;
	pid: number;
	nonce: string;
	marker?: Marker;
	limitMarker?: { start: number; end: number };
	scanFrom: number;
	startedAt: number;
	endedAt?: number;
	state: TaskState;
	exitCode?: number;
	reason?: KillReason;
	deadline?: number;
	killing?: Promise<"killed" | "gone" | "stuck">;
	clearing?: Promise<Leftovers>;
	readPosition: number;
	notified: boolean;
	readFailures: number;
	waiting?: number;
};

type Registry = {
	tasks: Map<string, Task>;
	nextId: number;
	pi?: ExtensionAPI;
	ctx?: ExtensionContext;
	poller?: ReturnType<typeof setInterval>;
	limitTimer?: ReturnType<typeof setInterval>;
	groups: Set<number>;
	emptyGroups: Set<number>;
	launching: Set<Promise<void>>;
	foreground: Set<ForegroundRun>;
};

export type Leftovers = "none" | "stopped" | "stuck";

export function getRegistry(): Registry {
	const holder = globalThis as unknown as Record<symbol, Registry | undefined>;
	const registry = (holder[KEY] ??= {
		tasks: new Map(),
		nextId: 1,
		groups: new Set(),
		emptyGroups: new Set(),
		launching: new Set(),
		foreground: new Set(),
	});
	registry.groups ??= new Set();
	registry.emptyGroups ??= new Set();
	registry.launching ??= new Set();
	registry.foreground ??= new Set();
	return registry;
}

export async function launchGroup(options: LaunchOptions): Promise<number> {
	const registry = getRegistry();
	let open!: () => void;
	const gate = new Promise<void>((resolve) => (open = resolve));
	registry.launching.add(gate);
	try {
		const pid = await processPort().launch(options);
		registry.groups.add(pid);
		return pid;
	} finally {
		registry.launching.delete(gate);
		open();
	}
}

export function forgetGroup(pid: number): void {
	getRegistry().groups.delete(pid);
}

export async function endSession(): Promise<void> {
	const registry = getRegistry();
	stopTimers(registry);
	while (registry.launching.size > 0) await Promise.all([...registry.launching]);
	const tasks = [...registry.tasks.values()];
	for (const task of tasks) task.notified = true;
	const pids = new Set(
		[...registry.groups, ...tasks.map((task) => task.pid)].filter((pid) => !registry.emptyGroups.has(pid)),
	);
	registry.groups.clear();
	registry.emptyGroups.clear();
	registry.tasks.clear();
	updateFooter(registry);
	debug("session-end", { tasks: tasks.length, groups: [...pids] });
	const killed = await Promise.allSettled([...pids].map((pid) => killGroup(pid)));
	for (const result of killed) if (result.status === "rejected") debugError("session-end-kill", result.reason);
}

export function attach(pi: ExtensionAPI): void {
	const registry = getRegistry();
	registry.pi = pi;
	stopTimers(registry);
	startPollerIfNeeded(registry);
}

export function setContext(ctx: ExtensionContext): void {
	getRegistry().ctx = ctx;
}

export function runningCount(registry = getRegistry()): number {
	return [...registry.tasks.values()].filter((task) => task.state === "running").length;
}

/** Footer: `bg: N` while N > 0 tasks run, cleared at 0. A stale context must not break the caller. */
function updateFooter(registry: Registry): void {
	try {
		const running = runningCount(registry);
		registry.ctx?.ui.setStatus("bg", running > 0 ? `bg: ${running}` : undefined);
	} catch (error) {
		debugError("footer", error);
	}
}

export type Reservation = { id: string; logPath: string; nonce: string };

export function reserve(sessionId: string): Reservation {
	const registry = getRegistry();
	const dir = sessionLogDir(sessionId);
	let id: string;
	do id = `bg-${registry.nextId++}`;
	while (existsSync(join(dir, `${id}.log`)) || existsSync(join(dir, `${id}.log.gz`)));
	return { id, logPath: join(dir, `${id}.log`), nonce: randomBytes(8).toString("hex") };
}

export function release(reservation: Reservation): void {
	const registry = getRegistry();
	if (reservation.id === `bg-${registry.nextId - 1}`) registry.nextId--;
}

export function seedNextIdFromBranch(entries: readonly unknown[]): void {
	const registry = getRegistry();
	for (const entry of entries) {
		const e = entry as { type?: string; customType?: string; data?: { id?: unknown } };
		if (e.type !== "custom" || e.customType !== STATUS_ENTRY_TYPE) continue;
		const id = typeof e.data?.id === "string" ? e.data.id : "";
		const match = /^bg-(\d+)$/.exec(id);
		if (match === null) continue;
		const n = Number(match[1]);
		if (Number.isSafeInteger(n) && n >= registry.nextId) registry.nextId = n + 1;
	}
}

export function makeTask(
	reservation: Reservation,
	launched: { command: string; cwd: string; pid: number; startedAt: number; timeout?: number; description?: string },
): Task {
	const { id, logPath, nonce } = reservation;
	const { command, cwd, pid, startedAt } = launched;
	return {
		id,
		command,
		description: launched.description,
		cwd,
		logPath,
		pid,
		nonce,
		scanFrom: 0,
		startedAt,
		deadline: launched.timeout !== undefined && launched.timeout > 0 ? startedAt + launched.timeout * 1000 : undefined,
		state: "running",
		readPosition: 0,
		notified: false,
		readFailures: 0,
	};
}

export function adopt(task: Task): Task {
	const registry = getRegistry();
	registry.tasks.set(task.id, task);
	debug("task-start", { ...taskFields(task), cwd: task.cwd, deadline: task.deadline });
	updateFooter(registry);
	startPollerIfNeeded(registry);
	return task;
}

export async function startTask(
	command: string,
	ctx: ExtensionContext,
	options: { timeout?: number; description?: string } = {},
): Promise<Task> {
	getRegistry().ctx = ctx;
	const reservation = reserve(ctx.sessionManager.getSessionId());
	const { logPath, nonce } = reservation;
	const pid = await launchGroup({ command, cwd: ctx.cwd, logPath, nonce, sessionEnv: sessionEnv(ctx) });
	return adopt(makeTask(reservation, { command, cwd: ctx.cwd, pid, startedAt: Date.now(), timeout: options.timeout, description: options.description }));
}

function sessionEnv(ctx: ExtensionContext): Record<string, string> {
	const env: Record<string, string> = { PI_SESSION_ID: ctx.sessionManager.getSessionId() };
	const file = ctx.sessionManager.getSessionFile();
	if (file) env.PI_SESSION_FILE = file;
	if (ctx.model) {
		env.PI_PROVIDER = ctx.model.provider;
		env.PI_MODEL = ctx.model.id;
	}
	if (ctx.thinkingLevel) env.PI_REASONING_LEVEL = ctx.thinkingLevel;
	return env;
}

function stopTimers(registry: Registry): void {
	if (registry.poller !== undefined) clearInterval(registry.poller);
	registry.poller = undefined;
	if (registry.limitTimer !== undefined) clearInterval(registry.limitTimer);
	registry.limitTimer = undefined;
}

function stopLimitTimer(registry: Registry): void {
	if (registry.limitTimer !== undefined) clearInterval(registry.limitTimer);
	registry.limitTimer = undefined;
}

function startPollerIfNeeded(registry: Registry): void {
	if (registry.poller === undefined && hasPending(registry)) {
		registry.poller = setInterval(() => poll(registry), POLL_MS);
		registry.poller.unref();
	}
	if (registry.limitTimer === undefined && runningCount(registry) > 0) {
		registry.limitTimer = setInterval(() => checkLogLimits(registry), LOG_LIMIT_MS);
		registry.limitTimer.unref();
	}
}

function checkLogLimits(registry: Registry): void {
	for (const task of registry.tasks.values()) {
		if (task.state !== "running" || task.killing !== undefined) continue;
		if (overLogLimit(task)) {
			killForLogLimit(registry, task).catch((error) => debugError("log-limit-kill", error, taskFields(task)));
		}
	}
	if (runningCount(registry) === 0) stopLimitTimer(registry);
}

function hasPending(registry: Registry): boolean {
	return [...registry.tasks.values()].some((task) => task.state === "running" || !task.notified);
}

function refresh(registry: Registry, task: Task): void {
	if (task.state !== "running") return;
	const alive = processPort().pidAlive(task.pid);
	let marker: Marker | undefined;
	let unreadable = false;
	try {
		marker = locateMarker(task);
		task.readFailures = 0;
	} catch (error) {
		debugError("locate-marker", error, { ...taskFields(task), alive, failures: task.readFailures + 1 });
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
			task.readFailures++;
			if (alive || task.readFailures < READ_FAILURES_LIMIT) return;
		}
		unreadable = true;
	}
	if (marker === undefined && alive && !unreadable) return;
	task.endedAt = Date.now();
	task.state = marker === undefined ? "exit-unknown" : "exited";
	task.exitCode = marker?.code;
	if (marker !== undefined && !processPort().groupAlive(task.pid)) registry.emptyGroups.add(task.pid);
	updateFooter(registry);
	debug("task-exit", { ...exitFields(task), by: "poller" });
}

function pollTask(registry: Registry, task: Task): void {
	if (task.killing !== undefined) return;
	refresh(registry, task);
	if (task.state === "running") {
		if (overLogLimit(task)) {
			killForLogLimit(registry, task).catch((error) => debugError("log-limit-kill", error, taskFields(task)));
			return;
		}
		if (task.deadline !== undefined && Date.now() >= task.deadline) {
			debug("deadline", { ...taskFields(task), deadline: task.deadline });
			killTask(task, "timed out", { notify: true }).catch((error) =>
				debugError("deadline-kill", error, taskFields(task)),
			);
		}
		return;
	}
	notifyOnce(registry, task);
}

export async function killTask(
	task: Task,
	reason: KillReason,
	options: { notify: boolean },
): Promise<"finished" | "gone" | "killed" | "stuck" | "cleared" | "leftover-stuck"> {
	const registry = getRegistry();
	debug("kill-request", { ...taskFields(task), reason, notify: options.notify, joined: task.killing !== undefined });
	if (task.killing === undefined) {
		refresh(registry, task);
		if (task.state !== "running") {
			if (!options.notify) {
				if (!task.notified && registry.pi !== undefined) appendStatusEntry(registry.pi, task);
				task.notified = true;
			}
			task.clearing ??= stopLeftovers(task).finally(() => {
				task.clearing = undefined;
			});
			const left = await task.clearing;
			debug("kill", { ...exitFields(task), reason, leftovers: left });
			return left === "none" ? "finished" : left === "stopped" ? "cleared" : "leftover-stuck";
		}
		const stopping = stopGroup(registry, task, reason, options.notify);
		task.killing = stopping;
		const clear = () => {
			task.killing = undefined;
		};
		stopping.then(clear, clear);
	}
	if (!options.notify) {
		if (!task.notified && registry.pi !== undefined) appendStatusEntry(registry.pi, task, { state: "killed" });
		task.notified = true;
	}
	return task.killing;
}

async function stopLeftovers(task: Task): Promise<Leftovers> {
	if (getRegistry().emptyGroups.has(task.pid) || !processPort().groupAlive(task.pid)) return "none";
	for (let i = 0; i < 20 && processPort().pidAlive(task.pid); i++) await new Promise((r) => setTimeout(r, 10));
	if (!processPort().groupAlive(task.pid)) return "none";
	const how = await killGroup(task.pid);
	return how === "gone" ? "none" : how === "stopped" ? "stopped" : "stuck";
}

async function stopGroup(
	registry: Registry,
	task: Task,
	reason: KillReason,
	notify: boolean,
): Promise<"killed" | "gone" | "stuck"> {
	const how = await killGroup(task.pid);
	task.endedAt = Date.now();
	if (how === "gone") {
		task.state = "exit-unknown";
	} else {
		task.state = "killed";
		task.reason = reason;
	}
	updateFooter(registry);
	debug("kill", { ...exitFields(task), reason, outcome: how });
	if (notify) {
		try {
			notifyOnce(registry, task);
		} catch (error) {
			debugError("notify", error, taskFields(task));
		}
	}
	return how === "stopped" ? "killed" : how;
}

async function killForLogLimit(registry: Registry, task: Task): Promise<"killed" | "gone" | "stuck"> {
	const stopping = (async () => {
		const how = await killGroupNow(task.pid);
		try {
			appendLimitMarker(task);
		} catch (error) {
			debugError("limit-marker", error, taskFields(task));
		}
		task.endedAt = Date.now();
		let marker: Marker | undefined;
		try {
			marker = locateMarker(task);
		} catch (error) {
			debugError("locate-marker", error, taskFields(task));
			marker = undefined;
		}
		if (marker !== undefined) {
			task.state = "exited";
			task.exitCode = marker.code;
		} else if (how === "gone") {
			task.state = "exit-unknown";
		} else {
			task.state = "killed";
			task.reason = "log limit passed";
		}
		// A group known empty must never be signalled again: the pid may be reused.
		if (how !== "stuck") registry.emptyGroups.add(task.pid);
		updateFooter(registry);
		debug("kill", { ...exitFields(task), reason: "log limit passed", outcome: how });
		try {
			notifyOnce(registry, task);
		} catch (error) {
			debugError("notify", error, taskFields(task));
		}
		return how === "gone" ? "gone" : how === "stuck" ? "stuck" : "killed";
	})();
	task.killing = stopping;
	const clear = () => {
		task.killing = undefined;
	};
	stopping.then(clear, clear);
	return stopping;
}

function poll(registry: Registry): void {
	for (const task of registry.tasks.values()) {
		try {
			pollTask(registry, task);
		} catch (error) {
			debugError("poll", error, taskFields(task));
		}
	}
	if (!hasPending(registry)) stopTimers(registry);
}

/** Report the task's end once: the flag is set before the send, and reset when the send throws so a later tick retries. The log is gzipped only after the message really went out (Q21); a gzip failure leaves the plain log and must not resend the message. */
function notifyOnce(registry: Registry, task: Task): void {
	if ((task.waiting ?? 0) > 0) return;
	if (task.notified || registry.pi === undefined) return;
	task.notified = true;
	try {
		sendCompletion(registry.pi, task);
	} catch (error) {
		task.notified = false;
		throw error;
	}
	appendStatusEntry(registry.pi, task);
	if (!processPort().groupAlive(task.pid))
		void gzipLog(task).catch((error) => debugError("gzip", error, taskFields(task)));
}

const WAIT_POLL_MS = 250;

function waitSleep(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		const onAbort = () => {
			clearTimeout(timer);
			reject(new Error("aborted"));
		};
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		signal.addEventListener("abort", onAbort, { once: true });
	});
}

export async function awaitTaskEnd(task: Task, ms: number, signal: AbortSignal): Promise<boolean> {
	const registry = getRegistry();
	const deadline = Date.now() + ms;
	for (;;) {
		if (getRegistry().tasks.get(task.id) !== task) return true;
		if (task.killing === undefined) refresh(registry, task);
		if (task.state !== "running") return true;
		if (signal.aborted) throw new Error("aborted");
		const left = deadline - Date.now();
		if (left <= 0) return false;
		await waitSleep(Math.min(WAIT_POLL_MS, left), signal);
	}
}

export function claimCompletion(task: Task): void {
	if (task.notified) return;
	const registry = getRegistry();
	if (task.state === "running" && task.killing === undefined) refresh(registry, task);
	if (task.state === "running" || registry.pi === undefined) return;
	task.notified = true;
	appendStatusEntry(registry.pi, task);
	if (!processPort().groupAlive(task.pid))
		void gzipLog(task).catch((error) => debugError("gzip", error, taskFields(task)));
}
