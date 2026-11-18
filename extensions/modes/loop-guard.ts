/**
 * modes/loop-guard.ts — [D1/D1b] provider-output loop defenses at the
 * tool_call gate (spec docs/{en,zh}/tool-call-loop-guard.md, reviewed
 * 2026-10-20 R1).
 *
 * D1 — message-level duplicate suppression: pi finalizes the whole
 * assistant message (message_end carries every toolCall part + id) before
 * dispatching toolCalls one by one through the gate, so same-batch
 * identity is exactly knowable. The index keeps the FIRST call of each
 * byte-identical group (parts order) and marks followers; the gate
 * blocks followers with a self-healing reason. Fail-open by construction:
 * an id missing from the index passes (older hosts, nested executeTool
 * calls — those carry parentToolCallId and never appear in message
 * parts, so the D1b breaker owns them instead).
 *
 * D1b — parent-level circuit breaker: codemode nested calls DO pass the
 * gate individually; a stuck script re-issuing byte-identical calls
 * trips the per-parent counter at maxIdentical. Bounded memory: parents
 * FIFO-evict at maxParents; a parent stops admitting new keys at
 * maxKeysPerParent (a stuck loop reuses few keys — detection intact).
 *
 * This is a DEFENSE, not a permission: the gate step runs before the
 * adjudicator. EXCEPTED in bypass mode since 2026-11-02 (P1-B, BREAKING):
 * the adapter skips the D1b check entirely when the current mode is
 * bypass — Claude Code's bypass has no loop defense, and its scripts
 * legitimately repeat identical calls (polling, retries). D1 (same-batch
 * byte-identical followers) still runs in every mode. Cross-turn
 * repetition stays legal by design (polling, retries) — only same-batch
 * duplicates and same-parent loops (non-bypass) block.
 */

export function duplicateKey(toolName: string, input: unknown): string {
	const sorted = canonicalize(input);
	return `${toolName}\u0000${JSON.stringify(sorted)}`;
}

function canonicalize(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonicalize);
	if (value && typeof value === "object") {
		const record = value as Record<string, unknown>;
		const out: Record<string, unknown> = {};
		for (const key of Object.keys(record).sort()) out[key] = canonicalize(record[key]);
		return out;
	}
	return value;
}


export interface BatchDupIndex {
	readonly byId: ReadonlyMap<string, { key: string; isDupFollow: boolean; firstId: string }>;
}

interface ToolCallPartLike {
	type?: string;
	id?: unknown;
	name?: unknown;
	arguments?: unknown;
}

export function indexBatchDupes(message: { role?: string; content?: unknown }): BatchDupIndex | null {
	if (message.role !== "assistant") return null;
	const content = message.content;
	if (!Array.isArray(content)) return null;
	const byId = new Map<string, { key: string; isDupFollow: boolean; firstId: string }>();
	const firstOfKey = new Map<string, string>();
	for (const part of content as ToolCallPartLike[]) {
		if (part?.type !== "toolCall") continue;
		if (typeof part.id !== "string" || typeof part.name !== "string") continue;
		const key = duplicateKey(part.name, part.arguments);
		let firstId = firstOfKey.get(key);
		const isDupFollow = firstId !== undefined;
		if (firstId === undefined) {
			firstId = part.id;
			firstOfKey.set(key, firstId);
		}
		byId.set(part.id, { key, isDupFollow, firstId });
	}
	if (byId.size === 0) return null;
	return { byId };
}

export function batchDupReason(firstIdHint: string): string {
	return (
		`This call is a byte-identical duplicate of call ${firstIdHint} in the same response — ` +
		"the first copy has already been processed (executed or blocked). " +
		"Repeating it in one batch has no effect; if you need to run it again, do so in your next turn with a fresh call."
	);
}

/**
 * D1 gate check: returns the block reason when toolCallId is a duplicate
 * follower of the indexed batch, else undefined (pass — including the
 * fail-open miss, which covers nested parentToolCallId calls).
 */
export function checkBatchDup(index: BatchDupIndex | undefined, toolCallId: string): string | undefined {
	const entry = index?.byId.get(toolCallId);
	if (!entry || !entry.isDupFollow) return undefined;
	return batchDupReason(entry.firstId);
}


export interface ParentLoopBreaker {
	check(parentToolCallId: string, key: string): string | undefined;
}

export function createParentLoopBreaker(maxIdentical = 20, maxParents = 256, maxKeysPerParent = 64): ParentLoopBreaker {
	const parents = new Map<string, Map<string, number>>();
	return {
		check(parentToolCallId: string, key: string): string | undefined {
			let counts = parents.get(parentToolCallId);
			if (!counts) {
				if (parents.size >= maxParents) {
					const oldest = parents.keys().next().value;
					if (oldest !== undefined) parents.delete(oldest);
				}
				counts = new Map();
				parents.set(parentToolCallId, counts);
			}
			const count = counts.get(key) ?? 0;
			if (count >= maxIdentical) {
				return (
					"the codemode script has issued " +
					`${count} byte-identical calls to this tool through one parent — ` +
					"vary the arguments or break the loop; further identical calls are blocked."
				);
			}
			if (counts.size >= maxKeysPerParent && !counts.has(key)) {
				return undefined;
			}
			counts.set(key, count + 1);
			return undefined;
		},
	};
}

export function parentLoopKey(toolName: string, input: unknown): string {
	return duplicateKey(toolName, input);
}
