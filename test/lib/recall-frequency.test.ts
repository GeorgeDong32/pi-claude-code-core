/**
 * test/lib/recall-frequency.test.ts — B pins (spec
 * docs/en/recall-frequency-tuning.md §5). These exercise the REAL gates;
 * the legacy recall.test.ts runs with the cooldown env seam disabled.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createRecall, type RecallBlock, type RecallFile } from "../../extensions/memory/recall.ts";
import type { Selector, SelectorRequest } from "../../extensions/memory/selector.ts";

const SAVE_WARMUP = process.env.PI_CORE_RECALL_WARMUP_TURNS;
const SAVE_COOLDOWN = process.env.PI_CORE_RECALL_COOLDOWN_TURNS;

beforeEach(() => {
	delete process.env.PI_CORE_RECALL_WARMUP_TURNS;
	delete process.env.PI_CORE_RECALL_COOLDOWN_TURNS;
});
afterEach(() => {
	if (SAVE_WARMUP !== undefined) process.env.PI_CORE_RECALL_WARMUP_TURNS = SAVE_WARMUP;
	else delete process.env.PI_CORE_RECALL_WARMUP_TURNS;
	if (SAVE_COOLDOWN !== undefined) process.env.PI_CORE_RECALL_COOLDOWN_TURNS = SAVE_COOLDOWN;
	else delete process.env.PI_CORE_RECALL_COOLDOWN_TURNS;
});

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

function machine(opts: { initialUserTurns?: number; selector: Selector; delivered: RecallBlock[] }) {
	return createRecall({
		selector: opts.selector,
		modelLabel: "t/sel",
		files: () => [file("memory/a.md"), file("memory/b.md")],
		cwd: "/w",
		deliver: (b) => opts.delivered.push(b),
		initialUserTurns: opts.initialUserTurns,
	});
}

const HIST = (): readonly unknown[] => [];

describe("B warmup + cooldown (recall-frequency-tuning spec §5)", () => {
	it("1: fresh session — first 3 turns run no selector; lastReason 'warmup'", async () => {
		const { selector, calls } = recordingSelector();
		const delivered: RecallBlock[] = [];
		const m = machine({ selector, delivered });
		for (const text of ["plan the feature", "look at recall.ts", "now the tests"]) {
			const block = await m.onUserMessage(text, HIST, 0);
			expect(block).toBeNull();
		}
		expect(calls).toHaveLength(0);
		expect(m.stats.lastReason).toBe("warmup");
		expect(delivered).toHaveLength(0);
	});

	it("2: 4th turn runs the selector (warmup passed)", async () => {
		const { selector, calls } = recordingSelector();
		const m = machine({ selector, delivered: [] });
		for (let i = 0; i < 3; i++) await m.onUserMessage(`msg ${i}`, HIST, 0);
		await m.onUserMessage("fourth real message", HIST, 0);
		expect(calls).toHaveLength(1);
	});

	it("3: run at turn 4; turns 5-6 cooldown-skip; turn 7 eligible (interval = cooldown + 1)", async () => {
		const { selector, calls } = recordingSelector();
		const m = machine({ selector, delivered: [] });
		for (let i = 0; i < 3; i++) await m.onUserMessage(`msg ${i}`, HIST, 0);
		await m.onUserMessage("run here: message long enough for the query gate", HIST, 0);
		expect(calls).toHaveLength(1);
		const fifth = await m.onUserMessage("fifth message still under cooldown with words", HIST, 0);
		expect(fifth).toBeNull();
		expect(m.stats.lastReason).toBe("cooldown");
		await m.onUserMessage("sixth message still under cooldown with words", HIST, 0);
		expect(calls).toHaveLength(1); // still cooling
		await m.onUserMessage("seventh message now eligible again with words", HIST, 0);
		expect(calls).toHaveLength(2); // eligible again
	});

	it("4: resume seed initialUserTurns=7 — first turn runs immediately", async () => {
		const { selector, calls } = recordingSelector();
		const m = machine({ selector, delivered: [], initialUserTurns: 7 });
		await m.onUserMessage("continuing the conversation with enough words to query", HIST, 0);
		expect(calls).toHaveLength(1);
	});

	it("5: short resume seed=2 — first turn is warmup turn 3, second runs", async () => {
		const { selector, calls } = recordingSelector();
		const m = machine({ selector, delivered: [], initialUserTurns: 2 });
		const first = await m.onUserMessage("resuming a short session with a long message", HIST, 0);
		expect(first).toBeNull();
		expect(m.stats.lastReason).toBe("warmup");
		await m.onUserMessage("next message long enough for the query gate", HIST, 0);
		expect(calls).toHaveLength(1);
	});

	it("6: an eligible turn suppressed by empty candidates increments (no reset); the next eligible turn still runs", async () => {
		const { selector, calls } = recordingSelector();
		let empty = false;
		const delivered: RecallBlock[] = [];
		const m = createRecall({
			selector,
			modelLabel: "t/sel",
			files: () => (empty ? [] : [file("memory/a.md"), file("memory/b.md")]),
			cwd: "/w",
			deliver: (b) => delivered.push(b),
			initialUserTurns: 3,
		});
		await m.onUserMessage("first run message with plenty of words", HIST, 0); // run → resets to 0
		expect(calls).toHaveLength(1);
		await m.onUserMessage("cooldown turn after the first run", HIST, 0); // +1 (cooldown)
		expect(m.stats.lastReason).toBe("cooldown");
		empty = true;
		await m.onUserMessage("eligible but suppressed: no candidates here", HIST, 0); // 1 < 2 → cooldown-skipped, increments to 2
		expect(calls).toHaveLength(1);
		empty = false;
		await m.onUserMessage("next eligible turn with candidates again", HIST, 0); // 2 ≥ 2 → runs
		expect(calls).toHaveLength(2);
	});

	it("6b: a suppressed turn that was ELIGIBLE (turnsSinceRun ≥ threshold) does not gate the next turn", async () => {
		const { selector, calls } = recordingSelector();
		let empty = false;
		const m = createRecall({
			selector,
			modelLabel: "t/sel",
			files: () => (empty ? [] : [file("memory/a.md"), file("memory/b.md")]),
			cwd: "/w",
			deliver: () => {},
			initialUserTurns: 3,
		});
		await m.onUserMessage("first run to reset the cooldown clock", HIST, 0); // run → 0
		await m.onUserMessage("cooldown increment turn number one", HIST, 0); // 1
		await m.onUserMessage("cooldown increment turn number two", HIST, 0); // 2
		empty = true;
		await m.onUserMessage("eligible turn suppressed by empty corpus", HIST, 0); // eligible → pipeline → +1 = 3
		expect(m.stats.empties).toBe(1);
		expect(calls).toHaveLength(1);
		empty = false;
		await m.onUserMessage("immediately after suppression, still eligible", HIST, 0); // 3 ≥ 2 → runs
		expect(calls).toHaveLength(2);
	});

	it("7: abort() mid-warmup preserves the turn counters", async () => {
		const { selector, calls } = recordingSelector();
		const m = machine({ selector, delivered: [] });
		await m.onUserMessage("one: a message long enough for the query gate", HIST, 0);
		await m.onUserMessage("two: another message long enough for the query", HIST, 0);
		m.abort(); // clears request state, not turn counters
		const third = await m.onUserMessage("three: still a warmup turn with enough words", HIST, 0);
		expect(third).toBeNull();
		expect(m.stats.lastReason).toBe("warmup");
		await m.onUserMessage("fourth message now long enough to pass the query gate", HIST, 0);
		expect(calls).toHaveLength(1);
	});

	it("9: the steer path (waitMs=0) shares the machine's counters", async () => {
		const { selector, calls } = recordingSelector();
		const m = machine({ selector, delivered: [] });
		for (let i = 0; i < 3; i++) await m.onUserMessage(`msg ${i}`, HIST, 50);
		await m.onUserMessage("a steer style message with enough words", HIST, 0); // steer-flavored call, same machine
		expect(calls).toHaveLength(1);
		const steered = await m.onUserMessage("steer during cooldown with a sufficiently long text", HIST, 0);
		expect(steered).toBeNull();
		expect(m.stats.lastReason).toBe("cooldown");
	});

	it("env seam: cooldown=0 allows back-to-back runs (legacy-mode parity check)", async () => {
		process.env.PI_CORE_RECALL_COOLDOWN_TURNS = "0";
		const { selector, calls } = recordingSelector();
		const m = createRecall({
			selector,
			modelLabel: "t/sel",
			files: () => [file("memory/a.md"), file("memory/b.md")],
			cwd: "/w",
			deliver: () => {},
			initialUserTurns: 3,
		});
		await m.onUserMessage("first message long enough for the query", HIST, 0);
		await m.onUserMessage("second message immediately after, also long", HIST, 0);
		// With the default cooldown the second run would be skipped; the seam
		// must let both through. (A third run would starve on RV-06 surfaced
		// keys — both files delivered — so two runs is the parity signal.)
		expect(calls).toHaveLength(2);
		expect(m.stats.lastReason).not.toBe("cooldown");
	});
});
