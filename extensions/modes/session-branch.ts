/**
 * Typed adapter over ctx.sessionManager — the single place that knows pi's
 * real SessionEntry shape. Messages arrive wrapped as
 * {type:"message", message: AgentMessage} with roles user/assistant/toolResult
 * (never "tool"). A private shape guess elsewhere previously left the
 * injection probe dead at runtime (plan B1); every session read goes through
 * this port so the shape has one owner and one test surface.
 */

export interface BranchAgentMessage {
	role: "user" | "assistant" | "toolResult"
	content?: unknown
	usage?: {
		input?: number
		output?: number
		cacheRead?: number
		cacheWrite?: number
		cost?: { total?: number }
	}
	toolName?: string
	toolCallId?: string
}

export interface BranchMessageEntry {
	type: "message"
	id?: string
	message: BranchAgentMessage
}

export interface BranchCustomEntry {
	type: "custom"
	customType?: string
	data?: unknown
}

export type BranchEntry = BranchMessageEntry | BranchCustomEntry | { type: string }

type SessionManagerLike = {
	getLeafId?: () => string | null
	getBranch?: () => unknown
	getEntries?: () => unknown
	getGitBranch?: () => unknown
	getSessionId?: () => unknown
	buildSessionProjection?: () => { messages?: unknown[] } | undefined
}

export function readLeafId(sessionManager: unknown): string | null | undefined {
	try {
		const sm = sessionManager as SessionManagerLike | undefined
		if (typeof sm?.getLeafId !== "function") return undefined
		const raw = (sm as { getLeafId: () => string | null }).getLeafId()
		if (raw === null) return null
		return typeof raw === "string" ? raw : undefined
	} catch {
		return undefined
	}
}

export function readBranchEntries(sessionManager: unknown): BranchEntry[] {
	try {
		const raw = (sessionManager as SessionManagerLike | undefined)?.getBranch?.()
		return Array.isArray(raw) ? (raw as BranchEntry[]) : []
	} catch {
		return []
	}
}

/** Strict variant for cache owners (AR1005-ST): null = the read failed or
 *  the host has no getBranch — a failure must NEVER be cached as a
 *  successful empty snapshot. A legal empty branch returns []. */
export function readBranchEntriesStrict(sessionManager: unknown): BranchEntry[] | null {
	try {
		const raw = (sessionManager as SessionManagerLike | undefined)?.getBranch?.()
		if (!Array.isArray(raw)) return null
		return raw as BranchEntry[]
	} catch {
		return null
	}
}

export function readBranchMessages(
	sessionManager: unknown,
	tail?: number,
): BranchAgentMessage[] {
	const messages: BranchAgentMessage[] = []
	if (tail !== undefined && tail <= 0) return messages
	const keep = tail ?? Number.POSITIVE_INFINITY
	for (const entry of readBranchEntries(sessionManager)) {
		if (entry?.type !== "message") continue
		const msg = (entry as BranchMessageEntry).message
		if (msg && (msg.role === "user" || msg.role === "assistant" || msg.role === "toolResult")) {
			messages.push(msg)
			if (messages.length > keep) messages.shift()
		}
	}
	return messages
}

export function readCustomEntryData(
	sessionManager: unknown,
	customType: string,
): unknown[] {
	const payloads: unknown[] = []
	try {
		const raw = (sessionManager as SessionManagerLike | undefined)?.getEntries?.()
		if (!Array.isArray(raw)) return payloads
		for (const entry of raw as BranchEntry[]) {
			if (entry?.type !== "custom") continue
			const custom = entry as BranchCustomEntry
			if (custom.customType === customType && custom.data !== undefined) {
				payloads.push(custom.data)
			}
		}
	} catch {
		return payloads
	}
	return payloads
}

export function readGitBranch(sessionManager: unknown): string | undefined {
	try {
		const raw = (sessionManager as SessionManagerLike | undefined)?.getGitBranch?.()
		return typeof raw === "string" ? raw : undefined
	} catch {
		return undefined
	}
}

export function readSessionProjection(sessionManager: unknown): readonly unknown[] {
	try {
		const raw = (sessionManager as SessionManagerLike | undefined)?.buildSessionProjection?.()
		return raw?.messages ?? []
	} catch {
		return []
	}
}

export function readSessionId(sessionManager: unknown): string | undefined {
	try {
		const raw = (sessionManager as SessionManagerLike | undefined)?.getSessionId?.()
		return typeof raw === "string" ? raw : undefined
	} catch {
		return undefined
	}
}
