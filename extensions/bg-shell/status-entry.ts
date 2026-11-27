import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { debugError } from "./debug.ts";
import { oneLine } from "./notify.ts";
import type { Task } from "./registry.ts";

export const STATUS_ENTRY_TYPE = "cc-core-bg-shell-task";

export interface TaskStatusData {
	id: string;
	command: string;
	description?: string;
	state: string;
	exitCode?: number;
	runtimeMs: number;
}

export function statusData(task: Task): TaskStatusData {
	return {
		id: task.id,
		command: oneLine(task.command),
		description: task.description,
		state: task.state,
		exitCode: task.exitCode,
		runtimeMs: (task.endedAt ?? Date.now()) - task.startedAt,
	};
}

export function appendStatusEntry(pi: ExtensionAPI, task: Task, override?: Partial<TaskStatusData>): void {
	try {
		pi.appendEntry(STATUS_ENTRY_TYPE, { ...statusData(task), ...override });
	} catch (error) {
		debugError("status-entry", error, { task: task.id });
	}
}
