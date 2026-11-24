
import { isAbsolute, resolve as resolvePath } from "node:path";

import {
	RECALL_FILE_MAX_BYTES,
	RECALL_MAX_FILES,
	RECALL_QUERY_MAX_CHARS,
	RECALL_QUERY_MIN_CHARS,
	RECALL_SESSION_MAX_BYTES,
} from "../../lib/context-budget.ts";
import { effectiveAgeMs } from "./memdir.ts";
import type { SelectionCandidate, Selector, SelectorOutcome } from "./selector.ts";

export const RECALL_CUSTOM_TYPE = "pi-memory-recall";

/**
 * Task-boundary recall (replacing the B-batch warmup/cooldown frequency
 * gates, user decision in the memory-policy spec): the selector may run only
 * on the first RECALL_BOUNDARY_TURNS real user messages after session start
 * or the most recent compactionSummary. The count derives from the projection
 * (D9); the CURRENT message is not yet in it — pi appends user messages to
 * the session only after before_agent_start — so `userTurns` counts the real
 * user messages BEFORE this one, and the check is `userTurns < RECALL_BOUNDARY_TURNS`.
 */
export const RECALL_BOUNDARY_TURNS = 2;

export const RECALL_DETAILS_FIELDS = ["v", "delivery", "model", "files", "bytes", "elapsedMs"] as const;

export interface RecallDetailsV1 {
	v: 1;
	delivery: "immediate" | "deferred";
	model: string;
	files: Array<{ key: string; bytes: number; truncated: boolean }>;
	bytes: number;
	elapsedMs: number;
}

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
	/** selections discarded because recallWaitMs elapsed before the selector answered */
	late: number;
	lastReason: string | null;
	deliveries: number;
}

export interface RecallMachine {
	onUserMessage(text: string, history: () => readonly unknown[], waitMs: number): Promise<RecallBlock | null>;
	abort(): void;
	dispose(): void;
	readonly stats: RecallStats;
}

export function stripSkillWrapper(text: string): string {
	let out = text;
	for (;;) {
		const next = out.replace(/^<skill [^>]*>[\s\S]*?\n<\/skill>[^\S\n]*/, "");
		if (next === out) return out.trim();
		out = next.trim();
	}
}

export function truncateUtf8(text: string, maxBytes: number): { text: string; truncated: boolean } {
	if (Buffer.byteLength(text, "utf8") <= maxBytes) return { text, truncated: false };
	let out = "";
	for (const ch of text) {
		if (Buffer.byteLength(out + ch, "utf8") > maxBytes) break;
		out += ch;
	}
	return { text: out, truncated: true };
}

export function freshnessHeader(mtimeMs: number, content: string | undefined, now = Date.now()): string | null {
	const ageMs = content === undefined ? now - mtimeMs : effectiveAgeMs(content, mtimeMs, now);
	const ageDays = Math.floor(ageMs / (24 * 60 * 60 * 1000));
	if (ageDays < 1) return null;
	if (ageDays <= 7) return `[${ageDays} day${ageDays === 1 ? "" : "s"} ago]`;
	return `[${ageDays} days ago — verify before relying on it]`;
}

export function byteLength(text: string): number {
	return Buffer.byteLength(text, "utf8");
}

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
	surfaced: Set<string>;
	read: Set<string>;
	bytesUsed: number;
	recentTools: string[];
	/** real user messages since the last compactionSummary, BEFORE the current one */
	userTurns: number;
	/** most recent real user message (≤1000 chars) — selector query context for short follow-ups */
	lastUserText: string | null;
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

export function deriveHistory(messages: readonly unknown[], cwd: string): DerivedHistory {
	const surfaced = new Set<string>();
	const read = new Set<string>();
	let bytesUsed = 0;
	let userTurns = 0;
	let lastUserText: string | null = null;
	const toolState = new Map<string, { success: boolean; failure: boolean }>();
	let toolsClosed = false;
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i] as ProjectionMessageLike | null;
		if (!m || typeof m !== "object") continue;
		if (m.role === "compactionSummary") break;
		if (m.customType === RECALL_CUSTOM_TYPE) {
			const details = m.details as Partial<RecallDetailsV1> | undefined;
			if (details && details.v === 1) {
				if (typeof details.bytes === "number") bytesUsed += details.bytes;
				for (const f of details.files ?? []) if (typeof f?.key === "string") surfaced.add(f.key);
			}
			continue;
		}
		if (m.role === "user" && !m.customType) {
			toolsClosed = true;
			userTurns++;
			// backward scan — the first hit is the most recent message before the current one
			if (lastUserText === null) lastUserText = messageText(m).slice(0, 1000) || null;
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
	return { surfaced, read, bytesUsed, recentTools, userTurns, lastUserText };
}

export function renderRecallBlock(
	files: RecallFile[],
	opts: { model: string; elapsedMs: number; remainingSessionBytes: number },
	now = Date.now(),
): RecallBlock | null {
	const sections: string[] = [];
	const detailFiles: RecallDetailsV1["files"] = [];
	let used = 0;
	for (const file of files) {
		if (sections.length >= RECALL_MAX_FILES) break;
		const freshness = freshnessHeader(file.mtimeMs, file.body, now);
		const cut = truncateUtf8(file.body, RECALL_FILE_MAX_BYTES);
		const note = cut.truncated ? `\n\n> truncated at 4KB — read the full file: ${file.absPath}` : "";
		const section = `## ${file.title} (${file.key})${freshness ? `\n${freshness}` : ""}\n\n${cut.text}${note}`;
		const sectionBytes = byteLength(section);
		if (used + sectionBytes > opts.remainingSessionBytes) break;
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
			delivery: "immediate",
			model: opts.model,
			files: detailFiles,
			bytes: byteLength(text),
			elapsedMs: opts.elapsedMs,
		},
	};
}

export function createRecall(deps: {
	selector: Selector;
	modelLabel: string;
	files: () => RecallFile[];
	cwd: string;
	diagnose?: (message: string) => void;
}): RecallMachine {
	const stats: RecallStats = { selections: 0, empties: 0, failures: 0, late: 0, lastReason: null, deliveries: 0 };
	const runDelivered = new Set<string>();
	const diagnose = deps.diagnose ?? (() => {});
	let disposed = false;
	let generation = 0;

	interface RequestState {
		controller: AbortController;
		timer: ReturnType<typeof setTimeout> | null;
		cancel: () => void;
	}
	let current: RequestState | null = null;

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
		pool: RecallFile[],
	): RecallBlock | null {
		const byKey = new Map(pool.map((f) => [f.key, f]));
		const picked: RecallFile[] = [];
		for (const key of outcome.keys) {
			const file = byKey.get(key);
			if (!file || history.surfaced.has(key) || runDelivered.has(key) || history.read.has(file.absPath)) continue;
			picked.push(file);
		}
		if (picked.length === 0) return null;
		return renderRecallBlock(picked, {
			model: deps.modelLabel,
			elapsedMs: outcome.elapsedMs,
			remainingSessionBytes: RECALL_SESSION_MAX_BYTES - history.bytesUsed,
		});
	}

	function commitDelivery(block: RecallBlock): void {
		for (const f of block.details.files) runDelivered.add(f.key);
		stats.deliveries++;
	}

	function describeError(err: unknown): string {
		return err instanceof Error ? `${err.message}` : String(err);
	}

	function invalidateCurrent(): void {
		generation++;
		const req = current;
		if (!req) return;
		current = null;
		req.controller.abort();
		if (req.timer !== null) clearTimeout(req.timer);
		req.cancel();
	}

	return {
		async onUserMessage(text, history, waitMs) {
			if (disposed) return null;
			invalidateCurrent();
			const myGen = generation;
			const isCurrent = () => !disposed && generation === myGen;

			try {
				const derived = deriveHistory(history(), deps.cwd);
				if (derived.userTurns >= RECALL_BOUNDARY_TURNS) {
					stats.lastReason = "boundary";
					return null;
				}
				const query = recallQuery(text);
				if (query === null) {
					stats.empties++;
					return null;
				}
				if (derived.bytesUsed >= RECALL_SESSION_MAX_BYTES) {
					return null;
				}
				const candidates = eligible(derived);
				if (candidates.length === 0) {
					stats.empties++;
					return null;
				}

				const controller = new AbortController();
				let resolveCancelled: (v: "cancelled") => void = () => {};
				const cancelled = new Promise<"cancelled">((r) => {
					resolveCancelled = r;
				});
				const req: RequestState = { controller, timer: null, cancel: () => resolveCancelled("cancelled") };
				current = req;

				let selection: Promise<SelectorOutcome>;
				try {
					selection = Promise.resolve(
						deps.selector.select({
							query,
							candidates,
							recentTools: derived.recentTools,
							previousUserMessage: derived.lastUserText ?? undefined,
							signal: controller.signal,
						}),
					).catch((): SelectorOutcome => ({ kind: "failure", reason: "selector_throw", elapsedMs: 0 }));
				} catch {
					selection = Promise.resolve({ kind: "failure", reason: "selector_throw", elapsedMs: 0 });
				}

				let timedOut = false;
				const timeoutNow = new Promise<"timeout">((resolveTimer) => {
					timedOut = true;
					resolveTimer("timeout");
				});
				const timerGate =
					waitMs > 0
						? new Promise<"timeout">((resolveTimer) => {
								req.timer = setTimeout(() => {
									timedOut = true;
									resolveTimer("timeout");
								}, waitMs);
								req.timer.unref?.();
							})
						: timeoutNow;
				const bounded = await Promise.race([selection, timerGate, cancelled]);

				if (bounded === "cancelled") return null;
				if (bounded === "timeout" && timedOut) {
					// Task-boundary recall: on timeout the selection is aborted and
					// DISCARDED — nothing may inject into the run after the prompt
					// path has given up (the deferred-delivery chain was removed;
					// a late completion finds no observer and its outcome is dropped).
					req.controller.abort();
					if (req.timer !== null) clearTimeout(req.timer);
					if (current === req) current = null;
					stats.late++;
					stats.lastReason = "timeout";
					return null;
				}
				if (req.timer !== null) clearTimeout(req.timer);
				if (current === req) current = null;
				if (!isCurrent()) return null;
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
				const block = assemble(outcome, derived, candidates);
				if (block) commitDelivery(block);
				else stats.empties++;
				return block;
			} catch (err) {
				stats.failures++;
				stats.lastReason = "entry_error";
				diagnose(`request failed: ${describeError(err)}`);
				return null;
			}
		},

		abort() {
			invalidateCurrent();
			runDelivered.clear();
		},

		dispose() {
			if (disposed) return;
			disposed = true;
			invalidateCurrent();
			runDelivered.clear();
		},

		get stats() {
			return stats;
		},
	};
}
