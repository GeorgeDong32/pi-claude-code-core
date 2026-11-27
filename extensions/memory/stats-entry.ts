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
	}
}
