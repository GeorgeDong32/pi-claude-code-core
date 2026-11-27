import { accumulateBranchStats, emptyBranchStatsState, type BranchStats, type BranchStatsState } from "./branch-stats.ts";
import { readBranchEntriesStrict, readLeafId, readSessionId } from "./session-branch.ts";

export interface ContextUsageLike {
	tokens: number | null;
	contextWindow: number;
	percent: number | null;
}

export interface WorkingStatsEntry {
	stats: BranchStats;
	usage: ContextUsageLike | undefined;
}

export interface WorkingStatsHost {
	sessionManager: unknown;
	getContextUsage?: () => ContextUsageLike | undefined;
}

export interface WorkingStatsCache {
	reset(): void;
	invalidate(): void;
	markDirty(): void;
	onModelChange(): void;
	snapshot(host: WorkingStatsHost, opts?: { force?: boolean; forceUsage?: boolean }): WorkingStatsEntry;
}

const instanceIds = new WeakMap<object, number>();
let nextInstanceId = 1;

export function createWorkingStats(): WorkingStatsCache {
	const branchState: BranchStatsState = emptyBranchStatsState();
	let cachedKey: string | undefined;
	let cachedEntry: WorkingStatsEntry | undefined;
	let usageFresh = false;

	// Hosts may create a new ctx object per event, so ctx identity is
	// meaningless — key on the sessionManager instance (a WeakMap id).
	function cheapKeyOf(sessionManager: unknown): string | undefined {
		if (!sessionManager || typeof sessionManager !== "object") return undefined;
		try {
			const leaf = readLeafId(sessionManager);
			if (leaf === undefined) return undefined;
			let inst = instanceIds.get(sessionManager);
			if (inst === undefined) {
				inst = nextInstanceId++;
				instanceIds.set(sessionManager, inst);
			}
			return `${inst}|${readSessionId(sessionManager) ?? ""}|${leaf ?? ""}`;
		} catch {
			return undefined;
		}
	}

	function readUsage(host: WorkingStatsHost): ContextUsageLike | undefined {
		if (typeof host.getContextUsage !== "function") {
			usageFresh = false;
			return undefined;
		}
		try {
			const usage = host.getContextUsage();
			usageFresh = usage !== undefined;
			return usage;
		} catch {
			usageFresh = false;
			return undefined;
		}
	}

	return {
		reset() {
			Object.assign(branchState, emptyBranchStatsState());
			cachedKey = undefined;
			cachedEntry = undefined;
			usageFresh = false;
		},
		invalidate() {
			cachedKey = undefined;
			cachedEntry = undefined;
			usageFresh = false;
		},
		markDirty() {
			cachedKey = undefined;
			cachedEntry = undefined;
		},
		onModelChange() {
			usageFresh = false;
		},
		snapshot(host, opts = {}) {
			const key = cheapKeyOf(host.sessionManager);
			const cacheable = key !== undefined;
			const keyHit = cacheable && cachedEntry !== undefined && cachedKey === key;

			if (keyHit && !opts.force) {
				const hit = cachedEntry!;
				if (usageFresh && !opts.forceUsage) {
					return hit;
				}
				const entry: WorkingStatsEntry = { stats: hit.stats, usage: readUsage(host) };
				cachedEntry = entry;
				return entry;
			}

			const branch = readBranchEntriesStrict(host.sessionManager);
			const branchFailed = branch === null;
			if (branch !== null) {
				accumulateBranchStats(branch, branchState);
			}
			const entry: WorkingStatsEntry = {
				stats: branchFailed ? { ...branchState.accum } : { ...branchState.accum },
				usage: readUsage(host),
			};
			if (cacheable && !branchFailed) {
				cachedKey = key;
				cachedEntry = entry;
			} else {
				cachedKey = undefined;
				cachedEntry = undefined;
			}
			return entry;
		},
	};
}
