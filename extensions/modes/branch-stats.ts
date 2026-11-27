import type { BranchEntry } from "./session-branch.ts"

export interface BranchStats {
	input: number
	output: number
	cacheRead: number
	cacheWrite: number
	cost: number
}

export interface BranchStatsState {
	accum: BranchStats
	processedCount: number
	tailEntryId: string | undefined
}

type BranchEntryWithUsage = {
	type?: string
	id?: string
	message?: {
		usage?: {
			input?: number
			output?: number
			cacheRead?: number
			cacheWrite?: number
			cost?: { total?: number }
		}
	}
}

export function emptyBranchStatsState(): BranchStatsState {
	return {
		accum: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
		processedCount: 0,
		tailEntryId: undefined,
	}
}

function foldInto(accum: BranchStats, entry: BranchEntryWithUsage): void {
	if (entry?.type !== "message") return
	const u = entry.message?.usage
	if (!u) return
	accum.input += u.input || 0
	accum.output += u.output || 0
	accum.cacheRead += u.cacheRead || 0
	accum.cacheWrite += u.cacheWrite || 0
	accum.cost += u.cost?.total || 0
}

// pi appends entries only at message boundaries — the branch is frozen
// while message_update chunks stream — so the processed prefix can be
// trusted incrementally and anything else recomputes from zero.
export function accumulateBranchStats(
	branch: BranchEntry[],
	state: BranchStatsState,
): BranchStats {
	const typed = branch as BranchEntryWithUsage[]
	const prefixIntact =
		typed.length >= state.processedCount &&
		typed[state.processedCount - 1]?.id === state.tailEntryId

	if (!prefixIntact) {
		state.accum = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }
		state.processedCount = 0
	}
	for (let i = state.processedCount; i < typed.length; i++) {
		foldInto(state.accum, typed[i]!)
	}
	state.processedCount = typed.length
	state.tailEntryId = typed[typed.length - 1]?.id
	return { ...state.accum }
}
