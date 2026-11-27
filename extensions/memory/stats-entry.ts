/**
 * memory/stats-entry.ts — the probe half of the context diet (spec v3 §6).
 *
 * One display-only session entry per agent run, pure counters, so a later
 * log scan can tell whether the compact index still leads the model to the
 * memories it needs: reads of memory files, lookup/search calls, recall
 * injections, index size and description-length violations. Never sent to
 * the model; a failure to append must not break the run.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const MEMORY_STATS_ENTRY_TYPE = "cc-core-memory-stats";

export interface MemoryStatsData {
	v: 1;
	indexBytes: number;
	indexRows: number;
	descTooLong: number;
	memoryReads: number;
	lookups: number;
	searches: number;
	recallInjections: number;
	descRewritten: number;
}

/** Reset at session_start; the agent_end snapshot is per run. */
export interface MemoryStatsCounters {
	memoryReads: number;
	lookups: number;
	searches: number;
	recallInjections: number;
}

export function emptyCounters(): MemoryStatsCounters {
	return { memoryReads: 0, lookups: 0, searches: 0, recallInjections: 0 };
}

export function appendMemoryStatsEntry(pi: ExtensionAPI, data: MemoryStatsData): void {
	try {
		pi.appendEntry(MEMORY_STATS_ENTRY_TYPE, data);
	} catch {
		/* display-only probe: fail open */
	}
}
