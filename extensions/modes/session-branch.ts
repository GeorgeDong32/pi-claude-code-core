// pi session entries wrap messages as {type:"message", message: AgentMessage};
// roles are user/assistant/toolResult — never "tool".
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
