/*
 * Test-only synthetic-session builders for the compaction suites (INV-7:
 * every fixture here is synthetic — no real session content).
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { ProjectedEntry } from "../types.ts";

let idCounter = 0;
export function nextId(prefix: string): string {
	idCounter += 1;
	return `${prefix}-${idCounter}`;
}

export function textBlock(text: string): { type: "text"; text: string } {
	return { type: "text", text };
}

export function toolCallBlock(name = "read"): { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> } {
	return { type: "toolCall", id: nextId("call"), name, arguments: { path: "/tmp/synthetic" } };
}

/** A user-role message entry (human turn input). */
export function userEntry(text: string, timestamp = "2026-11-09T10:00:00Z"): ProjectedEntry {
	const message = { role: "user", content: [textBlock(text)] } as unknown as AgentMessage;
	return wrap({ type: "message", id: nextId("u"), parentId: null, timestamp, message: message as never });
}

/** Assistant entry, optionally carrying tool calls. */
export function assistantEntry(text: string, opts: { toolCalls?: number; timestamp?: string } = {}): ProjectedEntry {
	const content: Array<Record<string, unknown>> = text.length > 0 ? [textBlock(text)] : [];
	for (let i = 0; i < (opts.toolCalls ?? 0); i += 1) content.push(toolCallBlock());
	const message = { role: "assistant", content } as unknown as AgentMessage;
	return wrap({ type: "message", id: nextId("a"), parentId: null, timestamp: opts.timestamp ?? "2026-11-09T10:00:01Z", message: message as never });
}

/** toolResult entry that follows its assistant tool call. */
export function toolResultEntry(output: string, timestamp = "2026-11-09T10:00:02Z"): ProjectedEntry {
	const message = {
		role: "toolResult",
		content: [{ type: "toolResult", toolCallId: nextId("call"), output }],
	} as unknown as AgentMessage;
	return wrap({ type: "message", id: nextId("tr"), parentId: null, timestamp, message: message as never });
}

/** The latest compaction entry heading a projection. */
export function compactionEntry(summary = "prior summary", firstKeptEntryId = "kept-1"): ProjectedEntry {
	const source = {
		type: "compaction",
		id: nextId("c"),
		parentId: null,
		timestamp: "2026-11-09T09:00:00Z",
		summary,
		firstKeptEntryId,
		tokensBefore: 100_000,
	} as SessionEntry;
	const message = { role: "compactionSummary", summary, tokensBefore: 100_000, timestamp: Date.parse("2026-11-09T09:00:00Z") } as unknown as AgentMessage;
	return { sourceEntry: source, messages: [message] };
}

/** A state-only entry (projects to no messages — e.g. usage row). */
export function stateOnlyEntry(type = "usage"): ProjectedEntry {
	return wrap({ type, id: nextId("s"), parentId: null, timestamp: "2026-11-09T10:00:03Z" } as SessionEntry, []);
}

function wrap(source: SessionEntry, messages?: AgentMessage[]): ProjectedEntry {
	if (messages) return { sourceEntry: source, messages };
	const message = (source as { message?: AgentMessage }).message;
	return { sourceEntry: source, messages: message ? [message] : [] };
}

/** Deterministic RNG (mulberry32) for seeded property tests. */
export function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

export function pick<T>(rng: () => number, items: readonly T[]): T {
	return items[Math.floor(rng() * items.length)];
}
