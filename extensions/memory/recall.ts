/**
 * memory/recall.ts — the recall v2 deep module
 * (spec 2026-10-02-memory-recall-v2, R1; replaces selection.ts +
 * recall-session.ts wholesale).
 *
 * TWO entries (the only ways in):
 *   onUserMessage(text, history, waitMs) — per real user message. Hygiene,
 *     history-derived exclusions, selector race against waitMs. Returns the
 *     block when the selector answers in time (prompt path returns it from
 *     before_agent_start as a persisted custom message), else null and the
 *     result parks in a held slot.
 *   abort() — run boundary (agent_end): abort in-flight, discard held,
 *     clear run-scoped dedup.
 *
 * ALL session state is DERIVED from the projection history on every call
 * (D9 — no closure state can go stale across driver quirks):
 *   RV-06 hard dedup — keys in pi-memory-recall details since the last
 *     compactionSummary never re-enter a manifest, plus run-scoped keys.
 *   RV-07 read suppression — read toolCalls hitting a memory file (path
 *     resolved against cwd) exclude it.
 *   RV-08 budget — session bytes are the sum of past details.bytes;
 *     per-file bodies truncate at RECALL_FILE_MAX_BYTES with a path note.
 *   RV-13 recentTools — tools with ≥1 success and 0 failure since the last
 *     real user message.
 *
 * Zero pi imports: pure over injected ports (Selector + file provider),
 * node-testable directly; the wiring owns every pi type.
 */

import { isAbsolute, resolve as resolvePath } from "node:path";

import {
	RECALL_FILE_MAX_BYTES,
	RECALL_MAX_FILES,
	RECALL_QUERY_MAX_CHARS,
	RECALL_QUERY_MIN_CHARS,
	RECALL_SESSION_MAX_BYTES,
} from "../../lib/context-budget.ts";
import type { SelectionCandidate, Selector, SelectorOutcome } from "./selector.ts";

export const RECALL_CUSTOM_TYPE = "pi-memory-recall";

/** Frozen details v1 field set — pinned by the contract suite (P0-CT-08). */
export const RECALL_DETAILS_FIELDS = ["v", "delivery", "model", "files", "bytes", "elapsedMs"] as const;

export interface RecallDetailsV1 {
	v: 1;
	delivery: "immediate" | "deferred";
	/** "provider/id" of the selector model. */
	model: string;
	files: Array<{ key: string; bytes: number; truncated: boolean }>;
	/** Whole rendered block bytes — the session budget unit (RV-08). */
	bytes: number;
	/** Selector wall time — real-world input for R2 waitMs calibration. */
	elapsedMs: number;
}

/** A candidate with its full content (frontmatter + body) — the machine
 * renders bodies; the selector never sees them. */
export type RecallFile = SelectionCandidate & { body: string };

export interface RecallBlock {
	customType: typeof RECALL_CUSTOM_TYPE;
	text: string;
	details: RecallDetailsV1;
}

export interface RecallStats {
	selections: number;
	empties: number;
	failures: number;
	lastReason: string | null;
	deliveries: number;
}

export interface RecallMachine {
	/** history is a THUNK: the machine calls it only when it actually needs
	 * a snapshot (onTurnEnd with nothing held never touches it). */
	onUserMessage(text: string, history: () => readonly unknown[], waitMs: number): Promise<RecallBlock | null>;
	abort(): void;
	readonly stats: RecallStats;
}

/** RV-02: strip pi's skill wrapper — the SKILL BODY is reference material
 * for the model, not the user's intent, and recall keys off intent.
 * Loop-tolerant (multiple blocks) and whitespace-trimmed. */
export function stripSkillWrapper(text: string): string {
	let out = text;
	for (;;) {
		const next = out.replace(/^<skill [^>]*>[\s\S]*?\n<\/skill>[^\S\n]*/, "");
		if (next === out) return out.trim();
		out = next.trim();
	}
}

/** Byte-safe head cut on a UTF-8 budget (never splits a code point). */
export function truncateUtf8(text: string, maxBytes: number): { text: string; truncated: boolean } {
	if (Buffer.byteLength(text, "utf8") <= maxBytes) return { text, truncated: false };
	let out = "";
	for (const ch of text) {
		if (Buffer.byteLength(out + ch, "utf8") > maxBytes) break;
		out += ch;
	}
	return { text: out, truncated: true };
}

/** Freshness header (AD2/OPT-3, migrated from selection.ts): graded age;
 * only genuinely stale memories carry the verify hint. */
export function freshnessHeader(mtimeMs: number, now = Date.now()): string | null {
	const ageDays = Math.floor((now - mtimeMs) / (24 * 60 * 60 * 1000));
	if (ageDays < 1) return null;
	if (ageDays <= 7) return `[${ageDays} day${ageDays === 1 ? "" : "s"} ago]`;
	return `[${ageDays} days ago — verify before relying on it]`;
}

/** Budgets are byte-denominated everywhere (CJK .length undercounts ~3×). */
export function byteLength(text: string): number {
	return Buffer.byteLength(text, "utf8");
}

/** RV-02 hygiene: skill-strip → trim → min/max length. null = skip recall. */
export function recallQuery(text: string): string | null {
	const stripped = stripSkillWrapper(text);
	if (stripped.length < RECALL_QUERY_MIN_CHARS) return null;
	return stripped.length > RECALL_QUERY_MAX_CHARS ? stripped.slice(0, RECALL_QUERY_MAX_CHARS) : stripped;
}

interface ProjectionMessageLike {
	role?: string;
	customType?: string;
	content?: unknown;
	details?: unknown;
	toolName?: string;
	isError?: boolean;
}

interface ToolCallPartLike {
	type?: string;
	name?: string;
	arguments?: { path?: unknown };
}

interface DerivedHistory {
	/** RV-06: keys already delivered since the last compaction. */
	surfaced: Set<string>;
	/** RV-07: absolute memory-file paths read via the read tool. */
	read: Set<string>;
	/** RV-08: session bytes already spent (sum of past details.bytes). */
	bytesUsed: number;
	/** RV-13: tools with ≥1 success and 0 failure since the last real user message. */
	recentTools: string[];
}

function messageText(message: ProjectionMessageLike): string {
	const c = message.content;
	if (typeof c === "string") return c;
	if (!Array.isArray(c)) return "";
	return (c as Array<{ type?: string; text?: string }>)
		.filter((p) => p?.type === "text" && typeof p.text === "string")
		.map((p) => p.text!)
		.join("\n");
}

/** Derive dedup/read/budget/tool state from the projection (D9). One
 * backward pass; surfaced/read/bytes scan back to the last
 * compactionSummary, tool tracking stops at the last real user message. */
export function deriveHistory(messages: readonly unknown[], cwd: string): DerivedHistory {
	const surfaced = new Set<string>();
	const read = new Set<string>();
	let bytesUsed = 0;
	const toolState = new Map<string, { success: boolean; failure: boolean }>();
	let toolsClosed = false;
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i] as ProjectionMessageLike | null;
		if (!m || typeof m !== "object") continue;
		if (m.role === "compactionSummary") break; // RV-06 window boundary
		if (m.customType === RECALL_CUSTOM_TYPE) {
			const details = m.details as Partial<RecallDetailsV1> | undefined;
			if (details && details.v === 1) {
				if (typeof details.bytes === "number") bytesUsed += details.bytes;
				for (const f of details.files ?? []) if (typeof f?.key === "string") surfaced.add(f.key);
			}
			continue;
		}
		if (m.role === "user" && !m.customType) {
			toolsClosed = true; // RV-13 window boundary — keep scanning dedup state
			continue;
		}
		if (m.role === "toolResult" && typeof m.toolName === "string" && !toolsClosed) {
			const st = toolState.get(m.toolName) ?? { success: false, failure: false };
			if (m.isError) st.failure = true;
			else st.success = true;
			toolState.set(m.toolName, st);
			continue;
		}
		if (m.role === "assistant" && Array.isArray(m.content)) {
			for (const part of m.content as ToolCallPartLike[]) {
				if (part?.type !== "toolCall" || typeof part.name !== "string") continue;
				if (part.name === "read" && typeof part.arguments?.path === "string") {
					const raw = part.arguments.path;
					const abs = isAbsolute(raw) ? raw : resolvePath(cwd, raw);
					read.add(abs);
				}
			}
		}
	}
	const recentTools = [...toolState.entries()]
		.filter(([, st]) => st.success && !st.failure)
		.map(([name]) => name)
		.sort();
	return { surfaced, read, bytesUsed, recentTools };
}

/** Render the delivered block (RV-11): one `## title (key)` section per
 * file, freshness line when stale, byte-truncated body with a path note. */
export function renderRecallBlock(
	files: RecallFile[],
	opts: { delivery: "immediate" | "deferred"; model: string; elapsedMs: number; remainingSessionBytes: number },
	now = Date.now(),
): RecallBlock | null {
	const sections: string[] = [];
	const detailFiles: RecallDetailsV1["files"] = [];
	let used = 0;
	for (const file of files) {
		if (sections.length >= RECALL_MAX_FILES) break;
		const freshness = freshnessHeader(file.mtimeMs, now);
		const cut = truncateUtf8(file.body, RECALL_FILE_MAX_BYTES);
		const note = cut.truncated ? `\n\n> truncated at 4KB — read the full file: ${file.absPath}` : "";
		const section = `## ${file.title} (${file.key})${freshness ? `\n${freshness}` : ""}\n\n${cut.text}${note}`;
		const sectionBytes = byteLength(section);
		if (used + sectionBytes > opts.remainingSessionBytes) break; // RV-08: never bust the session lane
		used += sectionBytes;
		sections.push(section);
		detailFiles.push({ key: file.key, bytes: sectionBytes, truncated: cut.truncated });
	}
	if (sections.length === 0) return null;
	const text = `<memory-recall>\n\n${sections.join("\n\n")}\n\n</memory-recall>`;
	return {
		customType: RECALL_CUSTOM_TYPE,
		text,
		details: {
			v: 1,
			delivery: opts.delivery,
			model: opts.model,
			files: detailFiles,
			bytes: byteLength(text),
			elapsedMs: opts.elapsedMs,
		},
	};
}

/** Build the machine over injected ports. `files` is re-read per message
 * (the corpus may change between turns); `history` snapshots arrive per
 * call from the wiring. */
export function createRecall(deps: {
	selector: Selector;
	modelLabel: string;
	files: () => RecallFile[];
	cwd: string;
	deliver: (block: RecallBlock) => void;
}): RecallMachine {
	const stats: RecallStats = { selections: 0, empties: 0, failures: 0, lastReason: null, deliveries: 0 };
	const runDelivered = new Set<string>();
	let inFlight: AbortController | null = null;

	function eligible(history: DerivedHistory): RecallFile[] {
		return deps
			.files()
			.filter(
				(f) =>
					!history.surfaced.has(f.key) &&
					!runDelivered.has(f.key) &&
					![...history.read].some((p) => p === f.absPath),
			);
	}

	function assemble(
		outcome: Extract<SelectorOutcome, { kind: "selected" }>,
		history: DerivedHistory,
		delivery: "immediate" | "deferred",
	): RecallBlock | null {
		const byKey = new Map(deps.files().map((f) => [f.key, f]));
		const picked: RecallFile[] = [];
		for (const key of outcome.keys) {
			const file = byKey.get(key);
			if (!file || history.surfaced.has(key) || runDelivered.has(key) || history.read.has(file.absPath)) continue;
			picked.push(file);
		}
		if (picked.length === 0) return null;
		const block = renderRecallBlock(picked, {
			delivery,
			model: deps.modelLabel,
			elapsedMs: outcome.elapsedMs,
			remainingSessionBytes: RECALL_SESSION_MAX_BYTES - history.bytesUsed,
		});
		if (!block) return null;
		for (const f of block.details.files) runDelivered.add(f.key);
		stats.deliveries++;
		return block;
	}

	function abortInFlight(): void {
		inFlight?.abort();
		inFlight = null;
	}

	return {
		async onUserMessage(text, history, waitMs) {
			// RV-05/D8: a newer user message always wins
			abortInFlight();

			const query = recallQuery(text);
			if (query === null) {
				stats.empties++;
				return null;
			}
			const derived = deriveHistory(history(), deps.cwd);
			if (derived.bytesUsed >= RECALL_SESSION_MAX_BYTES) return null; // RV-08: silent, no selector call
			const candidates = eligible(derived);
			if (candidates.length === 0) {
				stats.empties++;
				return null;
			}

			const controller = new AbortController();
			inFlight = controller;
			const selection = deps.selector
				.select({ query, candidates, recentTools: derived.recentTools, signal: controller.signal })
				.catch((): SelectorOutcome => ({ kind: "failure", reason: "selector_throw", elapsedMs: 0 }));

			let timedOut = false;
			const timeoutNow = new Promise<"timeout">((resolveTimer) => {
				timedOut = true;
				resolveTimer("timeout");
			});
			const bounded = await (waitMs > 0
				? Promise.race([
						selection,
						new Promise<"timeout">((resolveTimer) => {
							const timer = setTimeout(() => {
								timedOut = true;
								resolveTimer("timeout");
							}, waitMs);
							timer.unref?.();
						}),
					])
				: Promise.race([selection, timeoutNow]));

			if (bounded === "timeout" && timedOut) {
				// spec v1.2: the selection keeps running and DELIVERS THE MOMENT IT
				// COMPLETES — the wiring's sendMessage(triggerTurn:false) rides pi's
				// pending-custom-message queue, flushed at the next turn_end (the
				// first assistant message's end at the earliest). Never parked, never
				// discarded; a newer user message aborts it (latest-wins).
				void selection.then((outcome) => {
					if (controller.signal.aborted) return;
					if (outcome.kind === "selected") {
						stats.selections++;
						const block = assemble(outcome, deriveHistory(history(), deps.cwd), "deferred");
						if (block) deps.deliver(block);
						else stats.empties++;
					} else if (outcome.kind === "empty") stats.empties++;
					else {
						stats.failures++;
						stats.lastReason = outcome.reason;
					}
					if (inFlight === controller) inFlight = null;
				});
				return null;
			}
			if (inFlight === controller) inFlight = null;
			const outcome = bounded as SelectorOutcome;
			if (outcome.kind === "empty") {
				stats.empties++;
				return null;
			}
			if (outcome.kind === "failure") {
				stats.failures++;
				stats.lastReason = outcome.reason;
				return null;
			}
			stats.selections++;
			return assemble(outcome, derived, "immediate");
		},

		abort() {
			abortInFlight();
			runDelivered.clear();
		},

		get stats() {
			return stats;
		},
	};
}
