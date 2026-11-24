import { MEMORY_INDEX_MAX } from "../../lib/context-budget.ts";
import { RECALL_BOUNDARY_TURNS } from "./recall.ts";
import { QUEUE_DIR_MAX_BYTES } from "./queue.ts";

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
	readonly consolidation: { lastReason?: string | null };
	readonly yielded: { yielded: boolean; detectedBy?: string | null };
	readonly hermesDataFound: boolean;
	readonly misplaced: Array<{ file: string; key: string }>;
	readonly recall: {
		status: "on" | "off";
		reason?: string;
		model?: string;
		waitMs: number;
		sessionFiles: number;
		sessionBytes: number;
		stats: { selections: number; empties: number; failures: number; late: number; lastReason: string | null; deliveries: number };
	};
	readonly queue: { records: number; bytes: number; oldestSavedAt?: number } | null;
}

export function renderMemoryDiagnostics(input: MemoryDiagnosticsInput): string {
	const a = input.automation;
	const lines = [
		`user memory (RETIRED 2026-11-24 — pending migration): ${input.userDir} — files: ${input.userScan.entries.length}, skipped: ${input.userScan.skipped}, index: ${input.userIndexBytes} bytes (not injected, not recalled)`,
		`project memory: ${input.projectDir} — files: ${input.projectScan.entries.length}, skipped: ${input.projectScan.skipped}, index: ${input.projectIndexBytes}/${MEMORY_INDEX_MAX} bytes`,
		`automation: ${a.enabled ? "on" : "off"} — reviews ${a.reviews}${a.lastReview ? ` (last: ${a.lastReview})` : ""}, corrections ${a.corrections}${a.lastCorrection ? ` (last: ${a.lastCorrection})` : ""}, flushes ${a.flushes}${a.lastFlush ? ` (last: ${a.lastFlush})` : ""}, ops applied ${a.opsApplied}`,
		...(input.queue
			? [
					`pending-extraction queue: ${input.queue.records} record(s), ${input.queue.bytes}B/${QUEUE_DIR_MAX_BYTES / 1024}KB${input.queue.oldestSavedAt ? ` (oldest ${Math.max(0, Math.floor((Date.now() - input.queue.oldestSavedAt) / 86_400_000))}d)` : ""} — drained by the next same-project session; a plaintext copy of session tails (≤7d)`,
			]
			: []),
		`consolidation: manual-only (/memory-consolidate, project layer; auto trigger removed 2026-11-24)${input.consolidation.lastReason ? ` — last: ${input.consolidation.lastReason}` : ""}`,
		...(a.lastError ? [`last automation error: ${a.lastError}`] : []),
		`yielded to hermes: ${input.yielded.yielded}${input.yielded.detectedBy ? ` (${input.yielded.detectedBy})` : ""}`,
		input.recall.status === "on"
			? `recall: on (${input.recall.model}, wait ${input.recall.waitMs}ms, first ${RECALL_BOUNDARY_TURNS} user message(s) of the session) — session ${input.recall.sessionFiles} file(s) ${input.recall.sessionBytes}B; selections ${input.recall.stats.selections} / empty ${input.recall.stats.empties} / failures ${input.recall.stats.failures} / late ${input.recall.stats.late}${input.recall.stats.lastReason ? ` (last: ${input.recall.stats.lastReason})` : ""}, deliveries ${input.recall.stats.deliveries}`
			: `recall: off${input.recall.reason ? ` (${input.recall.reason})` : ""} — set memory.recallModel in ~/.pi/agent/settings.json to enable`,
		...(input.hermesDataFound ? ["hermes data found — run /memory-import-hermes to migrate it, then uninstall hermes"] : []),
		...(input.misplaced.length > 0
			? [
					`--- user-layer files awaiting migration (${input.misplaced.length}) ---`,
					...input.misplaced.map((m) => `- ${m.file} (mentions project "${m.key}")`),
				]
			: []),
		`--- retired user memories (migrate to Obsidian, then delete) ---`,
		...input.userScan.entries.map((e) => `- [${e.title}](${e.file}) — ${e.description} [${e.type}]`),
		`--- project memories ---`,
		...input.projectScan.entries.map((e) => `- [${e.title}](${e.file}) — ${e.description} [${e.type}]`),
	];
	return lines.join("\n");
}
