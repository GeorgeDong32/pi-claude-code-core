// Vendored from gvanderclay/pi-bg-bash v0.2.1 (MIT). Copyright (c) 2026 Gage Vander Clay.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { debugError } from "./debug.ts";
import { openView } from "./logview.ts";
import type { Task } from "./registry.ts";
import { sanitize } from "./sanitize.ts";

export const MESSAGE_TYPE = "cc-core-bg-shell";
const TAIL_LINES = 20;
/** No output growth for this long + a prompt-looking last line = the task is probably blocked on input. */
export const STALL_THRESHOLD_MS = 45_000;
export const STALL_TAIL_BYTES = 1_024;
const STALL_TAIL_LINES = 5;
// Last-line patterns that suggest a command is blocked on keyboard input. Only
// the last line is tested so slow commands that merely print questions earlier
// stay silent.
const PROMPT_PATTERNS = [
	/\(y\/n\)/i,
	/\[y\/n\]/i,
	/\(yes\/no\)/i,
	/\b(?:Do you|Would you|Shall I|Are you sure|Ready to)\b.*\? *$/i,
	/Press (any key|Enter)/i,
	/Continue\?/i,
	/Overwrite\?/i,
];

export function looksLikePrompt(tail: string): boolean {
	const lastLine = tail.trimEnd().split("\n").pop() ?? "";
	return PROMPT_PATTERNS.some((pattern) => pattern.test(lastLine));
}
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

/** `bg-5` or `bg-5 (description)` — the id the model needs, with the label it gave. */
export function who(task: Task): string {
	return task.description === undefined || task.description === "" ? task.id : `${task.id} (${task.description})`;
}

export function oneLine(command: string): string {
	const line = command.replace(/\s*\n\s*/g, " ⏎ ");
	return line.length > 200 ? `${line.slice(0, 200)}…` : line;
}

export function completionText(task: Task): string {
	return [
		`Background task ${who(task)} finished: ${stateText(task)}, ran ${runtimeText(task)}.`,
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

/** One line per task, same id/state/runtime/command fields as the single message (BG-MSG-02 batch form). */
export function completionBatchText(tasks: Task[]): string {
	const lines = tasks.map((task) => `- ${who(task)} · ${stateText(task)} · ran ${runtimeText(task)} · ${oneLine(task.command)}`);
	return [
		`Background tasks finished (${tasks.length}):`,
		...lines,
		`Output: read each with TaskOutput (id: ${tasks.map((task) => task.id).join(", ")}).`,
	].join("\n");
}

/** Several completions woken in one turn: one message, so the model is not interrupted N times (CC drain parity). */
export function sendCompletions(pi: ExtensionAPI, tasks: Task[]): void {
	if (tasks.length === 1) {
		sendCompletion(pi, tasks[0]!);
		return;
	}
	pi.sendMessage(
		{
			customType: MESSAGE_TYPE,
			content: completionBatchText(tasks),
			display: false,
			details: {
				id: tasks[0]!.id,
				ids: tasks.map((task) => task.id),
				tasks: tasks.map((task) => ({ id: task.id, exitCode: task.exitCode, state: task.state })),
				batch: true,
			},
		},
		{ deliverAs: "followUp", triggerTurn: true },
	);
}

export function stallText(task: Task, tail: string): string {
	return [
		`Background task ${who(task)} appears to be waiting for interactive input (no output for ${Math.round(STALL_THRESHOLD_MS / 1000)}s).`,
		"Last output:",
		tail.trimEnd(),
		"",
		`The command is likely blocked on an interactive prompt. Stop it with TaskStop (id: ${task.id}) and re-run with piped input (e.g. \`echo y | command\`) or a non-interactive flag if one exists; TaskOutput (id: ${task.id}) reads more.`,
	].join("\n");
}

export function stallTail(task: Task): string {
	return logTail(task, STALL_TAIL_LINES, STALL_TAIL_BYTES).text;
}

export function sendStall(pi: ExtensionAPI, task: Task, tail: string): void {
	pi.sendMessage(
		{
			customType: MESSAGE_TYPE,
			content: stallText(task, tail),
			display: false,
			details: { id: task.id, exitCode: undefined, state: task.state, stall: true },
		},
		{ deliverAs: "followUp", triggerTurn: true },
	);
}
