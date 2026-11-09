/*
 * Smart Compaction — preparation builder (SPEC SC §5.5 SUM-01/SUM-02, W3).
 *
 * Builds the plain-data `CompactionPreparation` (H2) the public compact()
 * accepts, mirroring pi's internal prepareCompaction semantics:
 *
 *   - messagesToSummarize / turnPrefixMessages come from the CURRENT
 *     projection (context edits applied — H15: content a later edit removed
 *     must NOT re-enter the summary through the back door);
 *   - the previous summary is passed as its NARRATIVE part only (the
 *     cc-core ledger block is regenerated at apply time, never inherited
 *     through the prompt);
 *   - fileOps replicate extractFileOpsFromMessage + computeFileLists
 *     exactly (SUM-02 differential vs the dist-internal oracle); the
 *     previous PI-GENERATED compaction's read/modified lists seed the sets,
 *     ours (fromHook) do not;
 *   - tokensBefore: estimateProjectedContextTokens is not public (H1), so
 *     the projection message sum feeds the estimate — informational only
 *     for the draft path (the host re-estimates on commit, H3) and a
 *     supplied best-effort number for the fallback leg (FB-04).
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
	CompactionSettings as PiCompactionSettings,
	SessionEntry,
	SessionProjection,
} from "@earendil-works/pi-coding-agent";
import { estimateMessages } from "./policy.ts";
import type { CutSelection } from "./types.ts";

/** pi's internal FileOperations shape (H2): three sets in, two lists out. */
export interface FileOpSets {
	read: Set<string>;
	written: Set<string>;
	edited: Set<string>;
}

/** The public CompactionPreparation structure compact() accepts (H2). */
export interface BuiltPreparation {
	firstKeptEntryId: string;
	messagesToSummarize: AgentMessage[];
	turnPrefixMessages: AgentMessage[];
	isSplitTurn: boolean;
	tokensBefore: number;
	previousSummary?: string;
	fileOps: FileOpSets;
	settings: PiCompactionSettings;
}

function createFileOps(): FileOpSets {
	return { read: new Set(), written: new Set(), edited: new Set() };
}

/** addFileOp replica: only read/write/edit with a string `path` count. */
function addFileOp(toolName: unknown, args: unknown, fileOps: FileOpSets): void {
	const path = (args as { path?: unknown } | undefined)?.path;
	if (typeof path !== "string" || path.length === 0) return;
	if (toolName === "read") fileOps.read.add(path);
	else if (toolName === "write") fileOps.written.add(path);
	else if (toolName === "edit") fileOps.edited.add(path);
}

/** extractFileOpsFromMessage replica (assistant toolCalls + toolResult nestedCalls). */
export function extractFileOpsFromMessage(message: AgentMessage, fileOps: FileOpSets): void {
	const record = message as {
		role?: string;
		content?: unknown;
		nestedCalls?: { calls?: Array<{ name?: unknown; arguments?: unknown }> };
	};
	if (record.role === "toolResult") {
		for (const call of record.nestedCalls?.calls ?? []) addFileOp(call.name, call.arguments, fileOps);
		return;
	}
	if (record.role !== "assistant" || !Array.isArray(record.content)) return;
	for (const block of record.content as Array<{ type?: string; name?: unknown; arguments?: unknown }>) {
		if (block?.type === "toolCall") addFileOp(block.name, block.arguments, fileOps);
	}
}

/** computeFileLists replica: modified = written ∪ edited; reads minus modified. */
export function computeFileLists(fileOps: FileOpSets): { readFiles: string[]; modifiedFiles: string[] } {
	const modified = new Set([...fileOps.edited, ...fileOps.written]);
	const readOnly = [...fileOps.read].filter((f) => !modified.has(f)).sort();
	return { readFiles: readOnly, modifiedFiles: [...modified].sort() };
}

/** flattenProjected replica: compaction entries contribute nothing; system is prompt state. */
function messagesOf(entries: { sourceEntry: SessionEntry; messages: AgentMessage[] }[]): AgentMessage[] {
	const out: AgentMessage[] = [];
	for (const entry of entries) {
		if (entry.sourceEntry.type === "compaction") continue;
		for (const message of entry.messages) {
			if (message.role !== "system") out.push(message);
		}
	}
	return out;
}

export interface BuildPreparationInput {
	/** Current projection (context edits already applied — H15). */
	projection: SessionProjection;
	/** The chosen cut (indices are into projection.entries). */
	cut: CutSelection;
	/** Effective host compaction settings. */
	settings: PiCompactionSettings;
	/** Narrative part of the previous compaction's summary (ledger stripped). */
	previousSummaryNarrative?: string;
}

/** Index of the newest compaction entry that still projects messages. */
function prevCompactionIndex(projection: SessionProjection): number {
	return projection.entries.findIndex(
		(entry) => entry.sourceEntry.type === "compaction" && entry.messages.length > 0,
	);
}

/**
 * Build the preparation for OUR cut. Returns undefined when there is nothing
 * to summarize (mirrors prepareCompaction's empty-message undefined).
 */
export function buildPreparation(input: BuildPreparationInput): BuiltPreparation | undefined {
	const { projection, cut, settings } = input;
	const entries = projection.entries;
	const prevIndex = prevCompactionIndex(projection);
	const boundaryStart = prevIndex >= 0 ? prevIndex + 1 : 0;
	const historyEnd = cut.isSplitTurn ? cut.turnStartIndex : cut.firstKeptEntryIndex;

	const messagesToSummarize = messagesOf(entries.slice(boundaryStart, historyEnd));
	const turnPrefixMessages = cut.isSplitTurn ? messagesOf(entries.slice(cut.turnStartIndex, cut.firstKeptEntryIndex)) : [];
	if (messagesToSummarize.length === 0 && turnPrefixMessages.length === 0) return undefined;

	// SUM-02 fileOps: seed from a previous PI-generated compaction's details
	// (ours carry their own ledger/state, not reusable file lists), then the
	// edited model-visible messages, then the turn prefix on split.
	const fileOps = createFileOps();
	if (prevIndex >= 0) {
		const prev = entries[prevIndex].sourceEntry as {
			type: string;
			fromHook?: boolean;
			details?: { readFiles?: unknown; modifiedFiles?: unknown };
		};
		if (!prev.fromHook && prev.details) {
			if (Array.isArray(prev.details.readFiles)) for (const f of prev.details.readFiles) if (typeof f === "string") fileOps.read.add(f);
			if (Array.isArray(prev.details.modifiedFiles)) for (const f of prev.details.modifiedFiles) if (typeof f === "string") fileOps.edited.add(f);
		}
	}
	for (const message of messagesToSummarize) extractFileOpsFromMessage(message, fileOps);
	for (const message of turnPrefixMessages) extractFileOpsFromMessage(message, fileOps);

	const tokensBefore = estimateMessages(projection.messages);

	return {
		firstKeptEntryId: cut.firstKeptEntryId,
		messagesToSummarize,
		turnPrefixMessages,
		isSplitTurn: cut.isSplitTurn,
		tokensBefore,
		previousSummary: input.previousSummaryNarrative,
		fileOps,
		settings,
	};
}
