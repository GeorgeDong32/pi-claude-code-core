// Vendored adaptation for pi-claude-code-core (BG): the user-visible task
// status row, the pi equivalent of CC's `task_status` attachment rendered by
// GenericTaskMessage — `⏺ Task "desc" completed in background` in dim, shown
// in the stream BEFORE the agent's response to the completion.
//
// Mechanism: `pi.appendEntry` appends a persistent session entry that is NOT
// sent to the LLM (display-only by API contract); `pi.registerEntryRenderer`
// renders it inline, and it replays on resume. The model-side notification
// stays the followUp message from notify.ts — the two are separate faces of
// one completion, exactly like CC's enqueueShellNotification (model) plus the
// task_status attachment (user).
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

import { debugError } from "./debug.ts";
import { oneLine } from "./notify.ts";
import type { Task } from "./registry.ts";

/** The session entry type; frozen by the BG-ENTRY-03 contract row. */
export const STATUS_ENTRY_TYPE = "cc-core-bg-shell-task";

/** Pure data carried by the entry (no functions — it persists to disk). */
export interface TaskStatusData {
	id: string;
	command: string;
	state: string;
	exitCode?: number;
	runtimeMs: number;
}

export function statusData(task: Task): TaskStatusData {
	return {
		id: task.id,
		command: task.command,
		state: task.state,
		exitCode: task.exitCode,
		runtimeMs: (task.endedAt ?? Date.now()) - task.startedAt,
	};
}

/**
 * The status wording, CC GenericTaskStatus parity: `completed in background`,
 * `stopped`; a non-zero exit is a failure and names its code (CC's summary
 * style `(exit code N)`).
 */
export function statusWording(data: TaskStatusData): string {
	if (data.state === "killed") return "stopped";
	if (data.state === "exited") return data.exitCode === 0 ? "completed in background" : `failed in background (exit ${data.exitCode})`;
	return "ended in background";
}

/** One rendered row: `⏺ Task "cmd on one line" completed in background`, dim. */
export function statusRowText(data: TaskStatusData): string {
	return `⏺ Task "${oneLine(data.command)}" ${statusWording(data)}`;
}

/** Register the renderer once per process (index.ts calls this at attach). */
export function registerStatusEntry(pi: ExtensionAPI): void {
	pi.registerEntryRenderer(STATUS_ENTRY_TYPE, (entry, _options, theme) => {
		const data = entry.data as TaskStatusData | undefined;
		if (data === undefined || typeof data !== "object") return undefined;
		return new Text(theme.fg("dim", statusRowText(data)));
	});
}

/**
 * Append the status entry; display-only, so a failure must never propagate.
 * `override` patches the data (a kill appends before the registry settles the
 * killed state, so it forces `state: "killed"` for the `stopped` wording).
 */
export function appendStatusEntry(pi: ExtensionAPI, task: Task, override?: Partial<TaskStatusData>): void {
	try {
		pi.appendEntry(STATUS_ENTRY_TYPE, { ...statusData(task), ...override });
	} catch (error) {
		debugError("status-entry", error, { task: task.id });
	}
}
