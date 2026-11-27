// Ported from NVlabs/SoL-Pi (MIT) @ src/sol-pi/extensions/observation-pack/observation.ts.
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { type FileHandle, lstat, mkdir, open } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { TextContent, ToolResultMessage } from "@earendil-works/pi-ai";

export const THRESHOLD_BYTES = 10 * 1024;
export const FULL_SENDS = 2;
export const PLACEHOLDER_EXCERPT_BYTES = 1024;
export const RECALL_TOOL_NAME = "obs_recall";

const CHARS_PER_TOKEN = 4;
const OBSERVATION_ID_PATTERN = /^obs_[a-f0-9]{24}$/u;
const READ_OBJECT_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW;
const CREATE_OBJECT_FLAGS = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;

const EVIDENCE_REDUCER_RECEIPT_PREFIX = "sol_pi_evidence_receipt_v1";

export interface Observation {
	readonly id: string;
	readonly contentHash: string;
	readonly filePath: string;
	readonly toolName: string;
	readonly text: string;
	readonly bytes: number;
	readonly lines: number;
	readonly tokens: number;
}

export function hash(value: string | Buffer): string {
	return createHash("sha256").update(value).digest("hex");
}

export function estimateTokens(text: string): number {
	let ascii = 0;
	let nonAscii = 0;
	for (const character of text) {
		if (character.codePointAt(0)! < 0x80) ascii += 1;
		else nonAscii += 1;
	}
	return Math.ceil(ascii / CHARS_PER_TOKEN + nonAscii);
}

export function countLines(text: string): number {
	if (text.length === 0) return 0;
	let lines = text.endsWith("\n") ? 0 : 1;
	for (const character of text) {
		if (character === "\n") lines += 1;
	}
	return lines;
}

function countBufferLines(buffer: Buffer): number {
	if (buffer.length === 0) return 0;
	let lines = buffer[buffer.length - 1] === 0x0a ? 0 : 1;
	for (const byte of buffer) {
		if (byte === 0x0a) lines += 1;
	}
	return lines;
}

export function isPureTextResult(message: AgentMessage): message is ToolResultMessage {
	return (
		message.role === "toolResult" &&
		!message.isError &&
		message.content.length > 0 &&
		message.content.every((block) => block.type === "text")
	);
}

function textFromResult(message: ToolResultMessage): string {
	return (message.content as TextContent[]).map((block) => block.text).join("\n");
}

function containsReducerReceipt(text: string): boolean {
	return text.split("\n").some((line) => line === EVIDENCE_REDUCER_RECEIPT_PREFIX);
}

export function observationPath(runtimeRoot: string, id: string): string {
	return join(runtimeRoot, "objects", `${id}.txt`);
}

export function isObservationId(id: string): boolean {
	return OBSERVATION_ID_PATTERN.test(id);
}

export function createObservation(message: ToolResultMessage, runtimeRoot: string): Observation | undefined {
	const text = textFromResult(message);
	if (containsReducerReceipt(text)) return undefined;
	const bytes = Buffer.byteLength(text, "utf8");
	if (bytes <= THRESHOLD_BYTES) return undefined;
	if (!runtimeRoot) throw new Error("Persistent session directory is unavailable for observation packing");

	const contentHash = hash(text);
	const id = `obs_${hash(`${message.toolName}\0${message.toolCallId}\0${contentHash}`).slice(0, 24)}`;
	return {
		id,
		contentHash,
		filePath: observationPath(runtimeRoot, id),
		toolName: message.toolName,
		text,
		bytes,
		lines: countLines(text),
		tokens: estimateTokens(text),
	};
}

export async function ensureStored(observation: Observation): Promise<void> {
	const directoryPath = dirname(observation.filePath);
	await mkdir(directoryPath, { recursive: true, mode: 0o700 });
	const directoryStats = await lstat(directoryPath);
	if (!directoryStats.isDirectory() || directoryStats.isSymbolicLink()) {
		throw new Error(`Observation directory is not a regular directory for ${observation.id}`);
	}

	let handle: FileHandle | undefined;
	try {
		handle = await open(observation.filePath, CREATE_OBJECT_FLAGS, 0o600);
		await handle.writeFile(observation.text, { encoding: "utf8" });
	} catch (error) {
		if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
		const existingHandle = await open(observation.filePath, READ_OBJECT_FLAGS);
		try {
			const existing = await existingHandle.stat();
			if (!existing.isFile()) {
				throw new Error(`Content-addressed observation is not a regular file for ${observation.id}`);
			}
			if (existing.size !== observation.bytes) {
				throw new Error(`Content-addressed observation size mismatch for ${observation.id}`);
			}
			const existingContent = await existingHandle.readFile();
			if (hash(existingContent) !== observation.contentHash) {
				throw new Error(`Content-addressed observation hash mismatch for ${observation.id}`);
			}
		} finally {
			await existingHandle.close();
		}
	} finally {
		await handle?.close();
	}
}

function completeLineExcerpt(text: string, budgetBytes: number, fromEnd: boolean): string {
	const lines = text.split(/(?<=\n)/);
	const selected: string[] = [];
	let selectedBytes = 0;
	let index = fromEnd ? lines.length - 1 : 0;

	while (index >= 0 && index < lines.length) {
		const line = lines[index];
		if (line === undefined) break;
		const lineBytes = Buffer.byteLength(line, "utf8");
		if (selectedBytes + lineBytes > budgetBytes) break;
		if (fromEnd) selected.unshift(line);
		else selected.push(line);
		selectedBytes += lineBytes;
		index += fromEnd ? -1 : 1;
	}

	return selected.join("");
}

export function placeholderFor(observation: Observation): string {
	const headBudget = Math.floor(PLACEHOLDER_EXCERPT_BYTES / 2);
	const tailBudget = PLACEHOLDER_EXCERPT_BYTES - headBudget;
	const head = completeLineExcerpt(observation.text, headBudget, false);
	const tail = completeLineExcerpt(observation.text, tailBudget, true);
	return [
		`[large tool result replaced after its first ${FULL_SENDS} provider requests]`,
		`id: ${observation.id}`,
		`tool: ${observation.toolName}`,
		`path: ${observation.filePath}`,
		`original_bytes: ${observation.bytes}`,
		`original_lines: ${observation.lines}`,
		`estimated_tokens: ${observation.tokens}`,
		`retrieve: call obs_recall with {"id":"${observation.id}","offset":0} to page from the start (continue with the returned next_offset), {"id":"${observation.id}","filter":"<regex>"} for matching lines, or {"id":"${observation.id}","tail":N} for the last N lines; the file above can also be grepped directly`,
		`[first complete lines, up to ${headBudget} bytes]`,
		head,
		`[middle omitted; last complete lines, up to ${tailBudget} bytes]`,
		tail,
		`[${observation.bytes} original bytes omitted]`,
	].join("\n");
}

export interface RecallChunk {
	readonly text: string;
	readonly bytes: number;
	readonly lines: number;
	readonly nextOffset: number;
	readonly eof: boolean;
}

function trimUtf8End(buffer: Buffer, limit: number): number {
	let end = limit;
	while (end > 0 && end < buffer.length && ((buffer[end] ?? 0) & 0xc0) === 0x80) end -= 1;
	return end;
}

export const SELECTION_MAX_BYTES = 8 * 1024 * 1024;
export const RECALL_DEFAULT_CONTEXT = 2;

export interface RecallSelection {
	readonly offset: number;
	readonly filter?: string;
	readonly context?: number;
	readonly tail?: number;
}

export interface SelectedRecall extends RecallChunk {
	readonly selection: string;
	readonly matchedLines?: number;
	readonly totalLines?: number;
}

export class RecallSelectionError extends Error {}

function pageText(text: string, offset: number, limits: { readonly maxBytes: number; readonly maxLines: number }): RecallChunk {
	const buffer = Buffer.from(text, "utf8");
	if (offset > buffer.length) throw new RecallSelectionError(`Offset ${offset} exceeds selection size ${buffer.length}`);
	let end = Math.min(buffer.length, offset + limits.maxBytes);
	let newlineCount = 0;
	for (let index = offset; index < end; index += 1) {
		if (buffer[index] !== 0x0a) continue;
		newlineCount += 1;
		if (newlineCount === limits.maxLines) {
			end = index + 1;
			break;
		}
	}
	end = trimUtf8End(buffer, end);
	const chunk = buffer.subarray(offset, end);
	const nextOffset = end;
	return { text: chunk.toString("utf8"), bytes: chunk.length, lines: countBufferLines(chunk), nextOffset, eof: nextOffset >= buffer.length };
}

export async function readRecallSelected(
	path: string,
	selection: RecallSelection,
	limits: { readonly maxBytes: number; readonly maxLines: number },
): Promise<SelectedRecall> {
	const handle = await open(path, READ_OBJECT_FLAGS);
	let text: string;
	try {
		const fileStats = await handle.stat();
		if (!fileStats.isFile()) throw new Error("Stored observation is not a regular file");
		if (fileStats.size > SELECTION_MAX_BYTES) {
			throw new RecallSelectionError(`selection needs the whole object (${fileStats.size} bytes > ${SELECTION_MAX_BYTES}); page with offset instead`);
		}
		text = await handle.readFile("utf8");
	} finally {
		await handle.close();
	}
	const lines = text.split("\n");
	if (lines.at(-1) === "") lines.pop();

	let selected: string[];
	let selectionHeader: string;
	let matchedLines: number | undefined;
	if (selection.tail !== undefined) {
		const tail = Math.floor(selection.tail);
		if (!Number.isFinite(tail) || tail < 1) throw new RecallSelectionError("tail must be a positive integer");
		const from = Math.max(0, lines.length - tail);
		selected = lines.slice(from).map((line, index) => `${from + index + 1}: ${line}`);
		selectionHeader = `[selection: tail=${tail} of ${lines.length} lines]`;
	} else {
		let regex: RegExp;
		try {
			regex = new RegExp(selection.filter ?? "");
		} catch (error) {
			throw new RecallSelectionError(`invalid regex: ${error instanceof Error ? error.message : String(error)}`);
		}
		const context = Math.max(0, Math.floor(selection.context ?? RECALL_DEFAULT_CONTEXT));
		const matched = new Set<number>();
		lines.forEach((line, index) => {
			if (regex.test(line)) matched.add(index);
		});
		const keep = new Set<number>();
		for (const index of matched) {
			for (let j = index - context; j <= index + context; j += 1) if (j >= 0 && j < lines.length) keep.add(j);
		}
		selected = [...keep]
			.sort((a, b) => a - b)
			.map((index) => `${index + 1}${matched.has(index) ? ": " : "  "}${lines[index]}`);
		matchedLines = matched.size;
		selectionHeader = `[selection: filter=${JSON.stringify(selection.filter ?? "")} context=${context} matched=${matched.size} of ${lines.length} lines]`;
	}
	const body = selected.length === 0 ? "" : `${selected.join("\n")}\n`;
	const chunk = pageText(body, selection.offset, limits);
	return { ...chunk, selection: selectionHeader, matchedLines, totalLines: lines.length };
}

export async function readRecallChunk(
	path: string,
	offset: number,
	limits: { readonly maxBytes: number; readonly maxLines: number },
): Promise<RecallChunk> {
	const handle = await open(path, READ_OBJECT_FLAGS);
	try {
		const fileStats = await handle.stat();
		if (!fileStats.isFile()) throw new Error("Stored observation is not a regular file");
		if (offset > fileStats.size) throw new Error(`Offset ${offset} exceeds observation size ${fileStats.size}`);

		const available = Math.max(0, fileStats.size - offset);
		const buffer = Buffer.alloc(Math.min(available, limits.maxBytes + 4));
		const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
		let end = Math.min(bytesRead, limits.maxBytes);
		let newlineCount = 0;

		for (let index = 0; index < end; index += 1) {
			if (buffer[index] !== 0x0a) continue;
			newlineCount += 1;
			if (newlineCount === limits.maxLines) {
				end = index + 1;
				break;
			}
		}

		end = trimUtf8End(buffer, end);
		const chunk = buffer.subarray(0, end);
		const nextOffset = offset + chunk.length;
		return {
			text: chunk.toString("utf8"),
			bytes: chunk.length,
			lines: countBufferLines(chunk),
			nextOffset,
			eof: nextOffset >= fileStats.size,
		};
	} finally {
		await handle.close();
	}
}
