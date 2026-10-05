/**
 * memory/recall.ts — the recall v2 deep module
 * (spec 2026-10-02-memory-recall-v2, R1; AR1005-RC 2026-10-05: request
 * lifecycle, cancellation and error convergence).
 *
 * THREE entries (the only ways in):
 *   onUserMessage(text, history, waitMs) — per real user message. Hygiene,
 *     history-derived exclusions, selector race against waitMs. Returns the
 *     block when the selector answers in time (prompt path returns it from
 *     before_agent_start as a persisted custom message), else null and the
 *     selection keeps running, delivering the moment it completes (v1.2:
 *     sendMessage(triggerTurn:false) rides pi's pending-custom-message
 *     queue — never parked in a slot, never discarded).
 *     TOTAL PROMISE SEMANTICS (AR1005-RC-02): this method never rejects —
 *     every entry-stage and deferred-stage throw converges to null plus at
 *     most one diagnostic per failed request, so `void onUserMessage(...)`
 *     in the steer wiring cannot produce an unhandled rejection.
 *   abort() — reusable reset (run boundary / supersede intent): cancel the
 *     current request, clear the run-scoped dedup; later messages accepted.
 *   dispose() — AR1005-RC-01: terminal, idempotent. Invalidate the current
 *     request, cancel waits, clear state; subsequent onUserMessage calls
 *     return null WITHOUT touching the selector.
 *
 * Request lifecycle (AR1005-RC-01): every request owns a private generation
 * + AbortController + wait timer + a "cancelled" resolver. A new user
 * message, abort, dispose or machine replacement bumps the generation and
 * resolves the old request's cancelled promise — an in-flight `await`
 * returns null immediately (bounded, never hangs on a selector that ignores
 * the signal), and a LATE completion (adapter ignored the AbortSignal) is
 * dropped without reading history, delivering, or mutating the new
 * request's state. Validity is re-checked after EVERY await, before
 * reading history, before returning an immediate block, before deliver —
 * including the positive-waitMs immediate branch.
 *
 * Delivery accounting (AR1005-RC-03): deferred requests update
 * runDelivered/deliveries ONLY after deliver() returns synchronously; a
 * throwing deliver leaves the file eligible (no permanent false marking).
 * Immediate keeps the "returning the block counts as delivered" convention.
 * This is in-module delivery bookkeeping, not a cross-process
 * exactly-once claim.
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
	 * a snapshot (a parked selection completing after disposal never
	 * touches it). Total promise: never rejects (AR1005-RC-02). */
	onUserMessage(text: string, history: () => readonly unknown[], waitMs: number): Promise<RecallBlock | null>;
	/** Reusable reset: cancel the current request, clear the run-scoped
	 * dedup; later messages are accepted. */
	abort(): void;
	/** Terminal teardown (AR1005-RC-01): idempotent and irreversible —
	 * invalidates the current request, cancels waits, clears state;
	 * subsequent onUserMessage calls return null without a selector call. */
	dispose(): void;
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
 * call from the wiring. `diagnose` (AR1005-RC-02) receives at most one
 * controlled line per FAILED request — cancellations and supersedes stay
 * silent. */
export function createRecall(deps: {
	selector: Selector;
	modelLabel: string;
	files: () => RecallFile[];
	cwd: string;
	deliver: (block: RecallBlock) => void;
	diagnose?: (message: string) => void;
}): RecallMachine {
	const stats: RecallStats = { selections: 0, empties: 0, failures: 0, lastReason: null, deliveries: 0 };
	const runDelivered = new Set<string>();
	const diagnose = deps.diagnose ?? (() => {});
	let disposed = false;
	let generation = 0;

	/** Per-request lifecycle record (AR1005-RC-01). */
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

	/** Build the block WITHOUT touching delivery bookkeeping (AR1005-RC-03:
	 * the caller commits only after its delivery rule succeeds). */
	function assemble(
		outcome: Extract<SelectorOutcome, { kind: "selected" }>,
		history: DerivedHistory,
		delivery: "immediate" | "deferred",
		// C7 (arch review 2026-10-03): the entry-time candidate pool — reuse it
		// instead of a second deps.files() pass. The real selector can only
		// return keys from the pool it was shown, so byKey loses nothing.
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
			delivery,
			model: deps.modelLabel,
			elapsedMs: outcome.elapsedMs,
			remainingSessionBytes: RECALL_SESSION_MAX_BYTES - history.bytesUsed,
		});
	}

	/** Commit the run-scoped dedup + delivery counter (AR1005-RC-03). */
	function commitDelivery(block: RecallBlock): void {
		for (const f of block.details.files) runDelivered.add(f.key);
		stats.deliveries++;
	}

	function describeError(err: unknown): string {
		return err instanceof Error ? `${err.message}` : String(err);
	}

	/** Invalidate the current request (new message / abort / dispose /
	 * replacement): bump the generation, abort the controller, clear the
	 * wait timer AND resolve the request's cancelled promise so an
	 * in-flight await never hangs on an abort-ignoring selector. */
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
			// RV-05/D8: a newer user message always wins
			invalidateCurrent();
			const myGen = generation;
			const isCurrent = () => !disposed && generation === myGen;

			try {
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
				let resolveCancelled: (v: "cancelled") => void = () => {};
				const cancelled = new Promise<"cancelled">((r) => {
					resolveCancelled = r;
				});
				const req: RequestState = { controller, timer: null, cancel: () => resolveCancelled("cancelled") };
				current = req;

				// AR1005-RC-02: a selector that throws SYNCHRONOUSLY (runtime
				// violating the declared Promise) must not escape either —
				// Promise.resolve(...) keeps an already-settled native promise's
				// identity (no extra tick) and normalizes everything else.
				let selection: Promise<SelectorOutcome>;
				try {
					selection = Promise.resolve(
						deps.selector.select({ query, candidates, recentTools: derived.recentTools, signal: controller.signal }),
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

				if (bounded === "cancelled") return null; // superseded/aborted/disposed mid-wait: silent, no stale block
				if (bounded === "timeout" && timedOut) {
					// spec v1.2: the selection keeps running and DELIVERS THE MOMENT IT
					// COMPLETES — the wiring's sendMessage(triggerTurn:false) rides pi's
					// pending-custom-message queue, flushed at the next turn_end (the
					// first assistant message's end at the earliest). Never parked, never
					// discarded; a newer user message aborts it (latest-wins).
					void selection
						.then((outcome) => {
							try {
								// AR1005-RC-01/02: validity FIRST — a late result (adapter
								// ignored the AbortSignal, session replaced/disposed) reads
								// no history, delivers nothing, mutates nothing.
								if (!isCurrent()) {
									if (current === req) current = null;
									return;
								}
								if (current === req) current = null;
								if (outcome.kind === "selected") {
									stats.selections++;
									// C7 disclosure: the deferred pass re-derives history (mandatory —
									// RV-07 drops files read during the selection) but reuses the
									// ENTRY-TIME pool: files written or deleted by automation between
									// entry and delivery deliver their entry-time body (stale by
									// seconds); keys outside the pool (only a non-conforming Selector
									// could produce them) are dropped.
									const block = assemble(outcome, deriveHistory(history(), deps.cwd), "deferred", candidates);
									if (block) {
										deps.deliver(block); // AR1005-RC-03: commit only on sync success
										commitDelivery(block);
									} else stats.empties++;
								} else if (outcome.kind === "empty") stats.empties++;
								else {
									stats.failures++;
									stats.lastReason = outcome.reason;
								}
							} catch (err) {
								// AR1005-RC-02/03: history/assemble/deliver throws — ONE
								// diagnostic, no false deliveries, no unhandled rejection.
								stats.failures++;
								stats.lastReason = "deliver_error";
								diagnose(`deferred delivery failed: ${describeError(err)}`);
							}
						})
						.catch((err: unknown) => {
							// Defense-in-depth: the chain above cannot reject (selection
							// is pre-catch'd and the callback is fully try/caught), but
							// every chain keeps an explicit rejection handler (RC-02).
							diagnose(`deferred chain rejected: ${describeError(err)}`);
						});
					return null;
				}
				// selection won the race (or settled first at waitMs=0)
				if (req.timer !== null) clearTimeout(req.timer); // AR1005-RC-02: timer cleanup at race end
				if (current === req) current = null;
				if (!isCurrent()) return null; // abort/dispose/new message during the wait — no stale block
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
				const block = assemble(outcome, derived, "immediate", candidates);
				if (block) commitDelivery(block); // immediate: returning the block counts as delivered (existing convention)
				else stats.empties++;
				return block;
			} catch (err) {
				// AR1005-RC-02: entry-stage throws (files/history/derive) converge
				// to null + ONE diagnostic — total promise, no unhandled rejection.
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
