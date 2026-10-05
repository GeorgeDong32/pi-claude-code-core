/**
 * modes/working-stats.ts — the streaming working-stats cache (AR1005-ST,
 * spec 2026-10-05 §9). ONE owner of the stats snapshot, the host-read
 * invalidation and the context-usage snapshot; the incremental
 * accumulateBranchStats sum and its prefix check are untouched.
 *
 * Cheap-key discipline (ST-02): a snapshot is cacheable only when the host
 * provides a reliable cheap identity —
 *   • the sessionManager INSTANCE (a WeakMap id; hosts may create a new ctx
 *     object per event, so ctx identity is meaningless),
 *   • the available sessionId,
 *   • the current leafId from the shape authority (session-branch.ts) —
 *     including the LEGAL empty-branch null (rendered as ""); a missing or
 *     throwing getter means "uncacheable", never "empty leaf".
 * A missing/failed cheap key falls back to the uncached read path (old
 * hosts keep working; the peer floor is not raised). Read failures are
 * never cached as successful empty snapshots — the next event retries.
 *
 * Invalidation model (spec table):
 *   reset()         session_start / session_tree / session_shutdown — drop
 *                  the accumulator and the cache; the next read re-bases.
 *   invalidate()    session_compact — drop the cached snapshot (the branch
 *                  rewrite re-bases the accumulator via its tail check).
 *   markDirty()     message_end — fired BEFORE the host appends the entry;
 *                  the cached snapshot must not be mistaken for the new
 *                  branch state (belt-and-suspenders with the leafId key,
 *                  which also moves on append).
 *   onModelChange() model_select / observable model or contextWindow
 *                  change — the usage snapshot is stale.
 *   snapshot(host, { force, forceUsage }) — the ONE read point. Key hit +
 *                  not dirty → ZERO getBranch/getContextUsage calls (the
 *                  message_update hot path). force → re-read the branch
 *                  (turn_start/turn_end committed-final); forceUsage →
 *                  re-read context usage only (before_provider_request —
 *                  no unconditional branch re-sum).
 *
 * Streaming fragments never enter the branch totals (they are not entries
 * — unchanged accumulate semantics).
 */
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

/** Per-instance identity (ctx objects are recreated per event; the manager is not). */
const instanceIds = new WeakMap<object, number>();
let nextInstanceId = 1;

export function createWorkingStats(): WorkingStatsCache {
	const branchState: BranchStatsState = emptyBranchStatsState();
	let cachedKey: string | undefined;
	let cachedEntry: WorkingStatsEntry | undefined;
	let usageFresh = false;

	function cheapKeyOf(sessionManager: unknown): string | undefined {
		if (!sessionManager || typeof sessionManager !== "object") return undefined;
		try {
			const leaf = readLeafId(sessionManager);
			if (leaf === undefined) return undefined; // unsupported getter → uncacheable
			let inst = instanceIds.get(sessionManager);
			if (inst === undefined) {
				inst = nextInstanceId++;
				instanceIds.set(sessionManager, inst);
			}
			return `${inst}|${readSessionId(sessionManager) ?? ""}|${leaf ?? ""}`;
		} catch {
			return undefined; // read failure → uncacheable (NOT an empty leaf)
		}
	}

	/** Read context usage. A returning-undefined or throwing read stays
	 *  unfresh — the next event retries (a failure is never cached as a
	 *  successful empty snapshot). An ABSENT capability also leaves freshness
	 *  unset: a capability-less read must never mark usage fresh, or a later
	 *  capability-bearing key hit would wrongly reuse a missing value
	 *  (adversarial R1 — the ctx% line would vanish mid-stream). The absent
	 *  case costs one typeof check, no host read. */
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
					return hit; // key hit: ZERO getBranch / getContextUsage calls
				}
				// Only the usage is stale (model_select / provider request):
				// refresh the usage, reuse the committed branch totals.
				const entry: WorkingStatsEntry = { stats: hit.stats, usage: readUsage(host) };
				cachedEntry = entry;
				return entry;
			}

			// Full read. A throwing/missing getBranch is NOT cached as a
			// successful empty snapshot — fall back to the last totals and
			// leave the cache empty so the next event retries.
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
