/** P0-SK-05 spike ① — mirrors the planned core /types subpath surface. */

export interface CoreStatus {
	version: number;
	modes: { mode: string; workingStats: string | null };
}

/**
 * Total reader with built-in fallback chain (new key → legacy keys →
 * defaults). Never throws on any input.
 */
export declare function readCoreStatus(g?: unknown): CoreStatus;
