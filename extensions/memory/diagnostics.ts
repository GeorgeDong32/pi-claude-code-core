/**
 * memory/diagnostics.ts — the /memory status rendering (arch B8, moved out
 * of the index.ts wiring closure). Pure data-in/text-out: the wiring
 * collects scans and state, this module formats. USER_INDEX_MAX /
 * MEMORY_INDEX_MAX come from the budget authorities (no second encoding).
 */
import { MEMORY_INDEX_MAX } from "../../lib/context-budget.ts";
import { USER_INDEX_MAX } from "./policy.ts";

export interface MemoryDiagnosticsInput {
	readonly userDir: string;
	readonly projectDir: string;
	readonly userScan: { entries: ReadonlyArray<{ title: string; file: string; description: string; type: string }>; skipped: number };
	readonly projectScan: { entries: ReadonlyArray<{ title: string; file: string; description: string; type: string }>; skipped: number };
	readonly userIndexBytes: number;
	readonly projectIndexBytes: number;
	readonly automation: {
		enabled: boolean;
		reviews: number;
		lastReview?: string | null;
		corrections: number;
		lastCorrection?: string | null;
		flushes: number;
		lastFlush?: string | null;
		opsApplied: number;
		lastError?: string | null;
	};
	readonly consolidation: { inFlight: boolean; attempts: number; lastReason?: string | null };
	readonly yielded: { yielded: boolean; detectedBy?: string | null };
	readonly hermesDataFound: boolean;
	/** RV: recall lane status — off when memory.recallModel is unset or
	 * unresolvable (D3); session counts derive from the projection history. */
	readonly recall: {
		status: "on" | "off";
		reason?: string;
		model?: string;
		waitMs: number;
		sessionFiles: number;
		sessionBytes: number;
		stats: { selections: number; empties: number; failures: number; lastReason: string | null; deliveries: number };
	};
}

export function renderMemoryDiagnostics(input: MemoryDiagnosticsInput): string {
	const a = input.automation;
	const lines = [
		`user memory: ${input.userDir} — files: ${input.userScan.entries.length}, skipped: ${input.userScan.skipped}, index: ${input.userIndexBytes}/${USER_INDEX_MAX} bytes`,
		`project memory: ${input.projectDir} — files: ${input.projectScan.entries.length}, skipped: ${input.projectScan.skipped}, index: ${input.projectIndexBytes}/${MEMORY_INDEX_MAX} bytes`,
		`automation: ${a.enabled ? "on" : "off"} — reviews ${a.reviews}${a.lastReview ? ` (last: ${a.lastReview})` : ""}, corrections ${a.corrections}${a.lastCorrection ? ` (last: ${a.lastCorrection})` : ""}, flushes ${a.flushes}${a.lastFlush ? ` (last: ${a.lastFlush})` : ""}, ops applied ${a.opsApplied}`,
		`consolidation: ${input.consolidation.inFlight ? `in-flight (attempt ${input.consolidation.attempts}/2${input.consolidation.lastReason ? `, ${input.consolidation.lastReason}` : ""})` : `idle${input.consolidation.lastReason ? ` (last: ${input.consolidation.lastReason}, attempt ${input.consolidation.attempts}/2)` : ""}`}`,
		...(a.lastError ? [`last automation error: ${a.lastError}`] : []),
		`yielded to hermes: ${input.yielded.yielded}${input.yielded.detectedBy ? ` (${input.yielded.detectedBy})` : ""}`,
		input.recall.status === "on"
			? `recall: on (${input.recall.model}, wait ${input.recall.waitMs}ms) — session ${input.recall.sessionFiles} file(s) ${input.recall.sessionBytes}B; selections ${input.recall.stats.selections} / empty ${input.recall.stats.empties} / failures ${input.recall.stats.failures}${input.recall.stats.lastReason ? ` (last: ${input.recall.stats.lastReason})` : ""}, deliveries ${input.recall.stats.deliveries}`
			: `recall: off${input.recall.reason ? ` (${input.recall.reason})` : ""} — set memory.recallModel in ~/.pi/agent/settings.json to enable`,
		...(input.hermesDataFound ? ["hermes data found — run /memory-import-hermes to migrate it, then uninstall hermes"] : []),
		`--- user memories ---`,
		...input.userScan.entries.map((e) => `- [${e.title}](${e.file}) — ${e.description} [${e.type}]`),
		`--- project memories ---`,
		...input.projectScan.entries.map((e) => `- [${e.title}](${e.file}) — ${e.description} [${e.type}]`),
	];
	return lines.join("\n");
}
