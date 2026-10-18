// Vendored adaptation for pi-claude-code-core (BG): the data half of the
// user-visible task status row (BG-ENTRY-03). Every background-task
// completion and every user kill appends a display-only session entry via
// `pi.appendEntry` — the API contract keeps it OUT of the LLM context.
//
// The RENDERING half lives in pi-claude-code-tui (`lib/bg-task-row.ts`):
// a `⏺ Background Task(bg-N)` pseudo tool row with a `⎿` detail gutter,
// CC GenericTaskStatus parity. core deliberately registers NO entry
// renderer here — pi's renderer lookup is first-wins across extensions in
// load order, so a core renderer would permanently shadow the TUI's; with
// core silent, the TUI is the single rendering owner, and environments
// without the TUI simply persist the entry (data is never lost, the row
// appears once the TUI is installed).
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

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
		command: oneLine(task.command),
		state: task.state,
		exitCode: task.exitCode,
		runtimeMs: (task.endedAt ?? Date.now()) - task.startedAt,
	};
}

/**
 * Append the status entry; display-only, so a failure must never propagate.
 * `override` patches the data (a kill appends before the registry settles
 * the killed state, so it forces `state: "killed"` for the `stopped` row).
 */
export function appendStatusEntry(pi: ExtensionAPI, task: Task, override?: Partial<TaskStatusData>): void {
	try {
		pi.appendEntry(STATUS_ENTRY_TYPE, { ...statusData(task), ...override });
	} catch (error) {
		debugError("status-entry", error, { task: task.id });
	}
}
