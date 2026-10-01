/**
 * memory/recall-session.ts — the per-turn recall state machine
 * (arch B8, carved out of the memory/index.ts wiring closure).
 *
 * Owns the four recall bindings that used to be factory-closure state
 * (pinnedTurn / surfacedKeys / readMemoryKeys / sessionBytesUsed). The
 * wiring layer scans the two layers and extracts the query snapshot; this
 * module owns every MR-01..09 invariant:
 *
 *   MR-01  one selection per turn — every remaining request re-projects the
 *          SAME text, byte-identical (cache discipline MR-09)
 *   MR-02  compact resets budget + read + billing state
 *   MR-03  the query snapshot is the LAST real user message (wiring extracts)
 *   MR-05  billing-only dedup: a paid file stays re-projectable, charged once
 *   MR-08  files read via tool are excluded from selection entirely (AD1)
 *
 * Pure over injected inputs — no fs, no pi, no gate: node-testable directly
 * (the pi-event wiring keeps its FakeHost pins in test/lib/memory.test.ts,
 * unchanged).
 */
import {
	byteLength,
	DEFAULT_SELECTION,
	freshnessHeader,
	selectForTurn,
	type SelectableMemory,
} from "./selection.ts";

/** Canonical recall-block key for a memory file (header form). */
export function whereKey(layer: "user" | "project", file: string): string {
	return layer === "user" ? `user-memory/${file}` : `memory/${file}`;
}

export interface RecallProjectInput {
	/** MR-03 query snapshot — null pins the empty decision (symmetry, v3.2 F5). */
	prompt: string | null;
	/** The scanned candidate set (both layers), wiring-owned freshness. */
	memories: readonly SelectableMemory[];
}

export interface RecallProjectResult {
	/** The pinned projection text; null = pinned "selected, nothing to inject". */
	readonly text: string | null;
}

export interface RecallSession {
	/** MR-01 turn boundary: drop the pin so the turn's first request selects fresh. */
	turnStart(): void;
	/** MR-02: budget + read + billing reset (compaction rebuilds the context). */
	compact(): void;
	/** AD1: a tool read into either layer marks the file as seen (excluded next turns). */
	markRead(layer: "user" | "project", file: string): void;
	/** Select once, bill once, pin — then re-project the same text all turn. */
	project(input: RecallProjectInput): RecallProjectResult;
	/** Session budget consumed so far (diagnostics). */
	readonly bytesUsed: number;
	/** Files charged this session (diagnostics). */
	readonly surfacedCount: number;
}

export function createRecallSession(): RecallSession {
	let sessionBytesUsed = 0;
	const readMemoryKeys = new Set<string>();
	const surfacedKeys = new Set<string>();
	let pinnedTurn: { text: string | null } | null = null;

	function renderBlocks(files: readonly SelectableMemory[]): string {
		const blocks: string[] = ["<memory-recall>"];
		for (const file of files) {
			const header = freshnessHeader(file.mtimeMs);
			const where = file.layer === "user" ? `user-memory/${file.file}` : `memory/${file.file}`;
			const block = `## ${file.title} (${where})${header ? `\n${header}` : ""}\n\n${file.body}`;
			// MR-05 + F7: charge each file ONCE per session, AFTER the block
			// string exists — a mid-render throw must not mark an uninjected
			// file as paid
			const key = whereKey(file.layer ?? "project", file.file);
			if (!surfacedKeys.has(key)) {
				surfacedKeys.add(key);
				sessionBytesUsed += byteLength(block);
			}
			blocks.push(block);
		}
		blocks.push("</memory-recall>");
		return blocks.join("\n\n");
	}

	return {
		turnStart() {
			pinnedTurn = null;
		},
		compact() {
			sessionBytesUsed = 0;
			readMemoryKeys.clear();
			surfacedKeys.clear();
			pinnedTurn = null;
		},
		markRead(layer, file) {
			readMemoryKeys.add(whereKey(layer, file));
		},
		project(input) {
			// MR-01: within the turn, re-project the pinned block verbatim — no
			// re-selection (which drifted on tool output between requests) and
			// no re-billing.
			if (pinnedTurn) return { text: pinnedTurn.text };

			if (input.prompt === null) {
				// MR-03 symmetry (v3.2, review F5): a turn whose first request has
				// no real user text pins the empty decision, exactly like an
				// empty selection — both paths behave alike
				pinnedTurn = { text: null };
				return { text: null };
			}

			// MR-08: files read via tool are excluded from selection entirely;
			// surfaced (paid) files stay selectable — billing-only dedup (MR-05)
			const fresh = input.memories.filter((m) => !readMemoryKeys.has(whereKey(m.layer ?? "project", m.file)));
			const { files } = selectForTurn(
				input.prompt,
				fresh,
				sessionBytesUsed,
				DEFAULT_SELECTION,
				(m) => surfacedKeys.has(whereKey(m.layer ?? "project", m.file)),
			);
			if (files.length === 0) {
				// pin the empty decision too — later requests in this turn must
				// not re-select against a changed message list either
				pinnedTurn = { text: null };
				return { text: null };
			}

			const text = renderBlocks(files);
			pinnedTurn = { text };
			return { text };
		},
		get bytesUsed() {
			return sessionBytesUsed;
		},
		get surfacedCount() {
			return surfacedKeys.size;
		},
	};
}
