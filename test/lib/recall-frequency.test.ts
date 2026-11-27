import { describe, expect, it } from "vitest";

import { RECALL_BOUNDARY_TURNS, createRecall, type RecallFile } from "../../extensions/memory/recall.ts";
import type { Selector, SelectorRequest } from "../../extensions/memory/selector.ts";

function file(key: string): RecallFile {
	return {
		key,
		file: key.slice(key.indexOf("/") + 1),
		title: key,
		description: "d",
		type: "reference",
		layer: "project",
		mtimeMs: Date.now(),
		absPath: `/m/${key}`,
		body: "body",
	};
}

function recordingSelector(): { selector: Selector; calls: Array<{ query: string; n: number }> } {
	const calls: Array<{ query: string; n: number }> = [];
	return {
		calls,
		selector: {
			async select(req: SelectorRequest) {
				calls.push({ query: req.query, n: req.candidates.length });
				return { kind: "selected", keys: [req.candidates[0]!.key], elapsedMs: 1 };
			},
		},
	};
}

function machine(selector: Selector) {
	return createRecall({
		selector,
		modelLabel: "t/sel",
		files: () => [file("memory/a.md"), file("memory/b.md")],
		cwd: "/w",
	});
}

const userMsg = (text: string): unknown => ({ role: "user", content: text });
const compact = (): unknown => ({ role: "compactionSummary", content: "summary" });

describe("task-boundary recall gate", () => {
	it("1: the first two real user messages run the selector; the third does not", async () => {
		const { selector, calls } = recordingSelector();
		const m = machine(selector);
		expect(await m.onUserMessage("first boundary message", () => [], 50)).not.toBeNull();
		expect(await m.onUserMessage("second boundary message", () => [userMsg("first boundary message")], 50)).not.toBeNull();
		const twoPrior = [userMsg("first boundary message"), userMsg("second boundary message")];
		expect(await m.onUserMessage("third message", () => twoPrior, 50)).toBeNull();
		expect(await m.onUserMessage("fourth message", () => [...twoPrior, userMsg("third message")], 50)).toBeNull();
		expect(calls).toHaveLength(2);
		expect(m.stats.lastReason).toBe("boundary");
	});

	it("2: a compaction resets the boundary — the next two messages run again", async () => {
		const { selector, calls } = recordingSelector();
		const m = machine(selector);
		const spent = [userMsg("one"), userMsg("two"), userMsg("three")];
		expect(await m.onUserMessage("out of boundary", () => spent, 50)).toBeNull();
		expect(calls).toHaveLength(0);
		const afterCompact = [userMsg("one"), userMsg("two"), userMsg("three"), compact()];
		expect(await m.onUserMessage("first after compaction", () => afterCompact, 50)).not.toBeNull();
		expect(await m.onUserMessage("second after compaction", () => [...afterCompact, userMsg("first after compaction")], 50)).not.toBeNull();
		expect(calls).toHaveLength(2);
	});

	it("3: only ONE compaction reset — the gate does not re-open per message after it", async () => {
		const { selector, calls } = recordingSelector();
		const m = machine(selector);
		const base = [userMsg("one"), userMsg("two"), compact()];
		expect(await m.onUserMessage("boundary 1", () => base, 50)).not.toBeNull();
		expect(await m.onUserMessage("boundary 2", () => [...base, userMsg("boundary 1")], 50)).not.toBeNull();
		expect(await m.onUserMessage("boundary 3", () => [...base, userMsg("boundary 1"), userMsg("boundary 2")], 50)).toBeNull();
		expect(calls).toHaveLength(2);
	});

	it("4: a resumed session with >boundary prior messages does not re-recall (surfaced blocks replay in the transcript)", async () => {
		const { selector, calls } = recordingSelector();
		const m = machine(selector);
		const resumed = [userMsg("old one"), userMsg("old two"), userMsg("old three")];
		expect(await m.onUserMessage("first message after resume", () => resumed, 50)).toBeNull();
		expect(calls).toHaveLength(0);
	});

	it("5: custom-type user messages never consume boundary slots nor feed lastUserText", async () => {
		const { selector, calls } = recordingSelector();
		const m = machine(selector);
		const history = [
			{ role: "user", customType: "pi-memory-consolidate", content: "(project layer) consolidate" },
			{ role: "user", customType: "pi-memory-recall", content: "recall block" },
		];
		expect(await m.onUserMessage("still the first real message", () => history, 50)).not.toBeNull();
		expect(calls).toHaveLength(1);
	});

	it("6: the boundary width pins RECALL_BOUNDARY_TURNS = 2", () => {
		expect(RECALL_BOUNDARY_TURNS).toBe(2);
	});
});
