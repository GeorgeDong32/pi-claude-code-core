/**
 * B8 (arch): the recall session state machine, driven directly — the
 * MR-01..09/AD1 invariants were previously assertable only through the
 * FakeHost-driven pi-event wiring (test/lib/memory.test.ts keeps those
 * end-to-end pins, zero changes). The session takes scanned memories and
 * the extracted query snapshot; selection, pinning and billing are its own.
 */
import { describe, expect, it } from "vitest";

import { createRecallSession } from "../../extensions/memory/recall-session.ts";
import type { SelectableMemory } from "../../extensions/memory/selection.ts";

function mem(overrides: Partial<SelectableMemory> = {}): SelectableMemory {
	return {
		file: "a.md",
		title: "release flow deploy steps",
		description: "deploy steps for releases",
		type: "project",
		pinned: false,
		body: "release flow deploy details",
		mtimeMs: Date.now(),
		layer: "project",
		...overrides,
	} as SelectableMemory;
}

describe("recall session (MR-01..09, B8)", () => {
	it("MR-01: within a turn, projection is selected once and re-projected byte-identical", () => {
		const s = createRecallSession();
		const first = s.project({ prompt: "release flow deploy", memories: [mem()] });
		expect(first.text).toBeTruthy();
		const second = s.project({ prompt: "something else entirely", memories: [] });
		// same turn: the pin wins — no re-selection against changed input
		expect(second.text).toBe(first!.text);
	});

	it("MR-01: turnStart drops the pin so the next turn selects fresh", () => {
		const s = createRecallSession();
		const first = s.project({ prompt: "release flow", memories: [mem()] });
		s.turnStart();
		const second = s.project({ prompt: "nothing matching", memories: [mem()] });
		expect(second.text).toBeNull();
	});

	it("MR-03 symmetry: a null prompt pins the empty decision for the whole turn", () => {
		const s = createRecallSession();
		expect(s.project({ prompt: null, memories: [mem()] }).text).toBeNull();
		// later requests in the same turn stay pinned-empty even with memories
		expect(s.project({ prompt: "release flow", memories: [mem()] }).text).toBeNull();
	});

	it("MR-05: billing is once per session — a paid file stays re-projectable without re-charging", () => {
		const s = createRecallSession();
		const first = s.project({ prompt: "release flow deploy", memories: [mem()] });
		expect(s.bytesUsed).toBeGreaterThan(0);
		const charged = s.bytesUsed;
		s.turnStart();
		const second = s.project({ prompt: "release flow deploy", memories: [mem()] });
		expect(second.text).toBeTruthy();
		expect(s.bytesUsed).toBe(charged);
		expect(s.surfacedCount).toBe(1);
	});

	it("AD1/MR-08: a tool-read file is excluded from selection entirely", () => {
		const s = createRecallSession();
		s.markRead("project", "a.md");
		const r = s.project({ prompt: "release flow deploy", memories: [mem()] });
		expect(r.text).toBeNull();
	});

	it("MR-02: compact resets budget, billing AND read marks", () => {
		const s = createRecallSession();
		s.project({ prompt: "release flow deploy", memories: [mem()] });
		s.markRead("project", "a.md");
		s.compact();
		expect(s.bytesUsed).toBe(0);
		expect(s.surfacedCount).toBe(0);
		// read marks cleared too — the file is selectable again
		expect(s.project({ prompt: "release flow deploy", memories: [mem()] }).text).toBeTruthy();
	});

	it("empty selection pins null for the rest of the turn", () => {
		const s = createRecallSession();
		expect(s.project({ prompt: "quantum llama physics", memories: [mem()] }).text).toBeNull();
		expect(s.project({ prompt: "release flow deploy", memories: [mem()] }).text).toBeNull();
	});
});
