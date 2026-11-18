// Vendored from gvanderclay/pi-bg-bash v0.2.1 (MIT). Copyright (c) 2026 Gage Vander Clay.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { debugError } from "./debug.ts";
import { openView } from "./logview.ts";
import type { Task } from "./registry.ts";
import { sanitize } from "./sanitize.ts";

export const MESSAGE_TYPE = "cc-core-bg-shell";
const TAIL_LINES = 20;
const TAIL_BYTES = 4096;
const READ_WINDOW = 64 * 1024;

export function formatRuntime(ms: number): string {
	const seconds = ms / 1000;
	if (seconds < 60) return `${seconds.toFixed(1)}s`;
	return `${Math.floor(seconds / 60)}m ${Math.floor(seconds % 60)}s`;
}

function fromCharacterBoundary(buffer: Buffer): Buffer {
	let start = 0;
	while (start < buffer.length && start < 3 && (buffer[start] & 0xc0) === 0x80) start++;
	return buffer.subarray(start);
}

export function logTail(task: Task, maxLines = TAIL_LINES, maxBytes = TAIL_BYTES): { text: string; cut: boolean } {
	let buffer: Buffer;
	let size: number;
	try {
		const view = openView(task);
		try {
			size = view.size;
			buffer = view.read(Math.max(0, size - READ_WINDOW), size);
		} finally {
			view.close();
		}
	} catch (error) {
		debugError("log-tail", error, { task: task.id, log: task.logPath });
		return { text: "(log unavailable)", cut: false };
	}
	const lines = sanitize(fromCharacterBoundary(buffer).toString("utf8")).replace(/\n$/, "").split("\n");
	const tail = lines.slice(-maxLines).join("\n");
	const bytes = Buffer.from(tail, "utf8");
	const cut = size > READ_WINDOW || lines.length > maxLines || bytes.length > maxBytes;
	if (bytes.length <= maxBytes) return { text: tail, cut };
	return { text: fromCharacterBoundary(bytes.subarray(bytes.length - maxBytes)).toString("utf8"), cut };
}

export function stateText(task: Task, markerCode?: number): string {
	if (task.state === "killed") return `killed (${task.reason})`;
	if (task.state === "exited") return `exited (code ${task.exitCode})`;
	if (task.state === "running") return markerCode === undefined ? "running" : `exited (code ${markerCode})`;
	return "exit unknown";
}

export function runtimeText(task: Task): string {
	return formatRuntime((task.endedAt ?? Date.now()) - task.startedAt);
}

export function taskLine(task: Task): string {
	const who = task.description === undefined || task.description === "" ? task.id : `${task.id} · ${task.description}`;
	return `${who} | ${stateText(task)} | ${runtimeText(task)} | ${oneLine(task.command)}`;
}

export function oneLine(command: string): string {
	const line = command.replace(/\s*\n\s*/g, " ⏎ ");
	return line.length > 200 ? `${line.slice(0, 200)}…` : line;
}

export function completionText(task: Task): string {
	const who = task.description === undefined || task.description === "" ? task.id : `${task.id} (${task.description})`;
	return [
		`Background task ${who} finished: ${stateText(task)}, ran ${runtimeText(task)}.`,
		`Command: ${oneLine(task.command)}`,
		`Output: read it with TaskOutput (id: ${task.id}).`,
	].join("\n");
}

export function sendCompletion(pi: ExtensionAPI, task: Task): void {
	pi.sendMessage(
		{
			customType: MESSAGE_TYPE,
			content: completionText(task),
			display: false,
			details: { id: task.id, exitCode: task.exitCode, state: task.state },
		},
		{ deliverAs: "followUp", triggerTurn: true },
	);
}
