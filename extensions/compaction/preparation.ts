import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
	CompactionSettings as PiCompactionSettings,
	SessionEntry,
	SessionProjection,
} from "@earendil-works/pi-coding-agent";
import { estimateMessages } from "./policy.ts";
import type { CutSelection } from "./types.ts";

export interface FileOpSets {
	read: Set<string>;
	written: Set<string>;
	edited: Set<string>;
}

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

function addFileOp(toolName: unknown, args: unknown, fileOps: FileOpSets): void {
	const path = (args as { path?: unknown } | undefined)?.path;
	if (typeof path !== "string" || path.length === 0) return;
	if (toolName === "read") fileOps.read.add(path);
	else if (toolName === "write") fileOps.written.add(path);
	else if (toolName === "edit") fileOps.edited.add(path);
}

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

export function computeFileLists(fileOps: FileOpSets): { readFiles: string[]; modifiedFiles: string[] } {
	const modified = new Set([...fileOps.edited, ...fileOps.written]);
	const readOnly = [...fileOps.read].filter((f) => !modified.has(f)).sort();
	return { readFiles: readOnly, modifiedFiles: [...modified].sort() };
}

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
	projection: SessionProjection;
	cut: CutSelection;
	settings: PiCompactionSettings;
	previousSummaryNarrative?: string;
}

function prevCompactionIndex(projection: SessionProjection): number {
	return projection.entries.findIndex(
		(entry) => entry.sourceEntry.type === "compaction" && entry.messages.length > 0,
	);
}

export function buildPreparation(input: BuildPreparationInput): BuiltPreparation | undefined {
	const { projection, cut, settings } = input;
	const entries = projection.entries;
	const prevIndex = prevCompactionIndex(projection);
	const boundaryStart = prevIndex >= 0 ? prevIndex + 1 : 0;
	const historyEnd = cut.isSplitTurn ? cut.turnStartIndex : cut.firstKeptEntryIndex;

	const messagesToSummarize = messagesOf(entries.slice(boundaryStart, historyEnd));
	const turnPrefixMessages = cut.isSplitTurn ? messagesOf(entries.slice(cut.turnStartIndex, cut.firstKeptEntryIndex)) : [];
	if (messagesToSummarize.length === 0 && turnPrefixMessages.length === 0) return undefined;

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

	// pi does not export estimateProjectedContextTokens and the host re-estimates
	// tokens on commit, so this projection-sum value is informational only.
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
