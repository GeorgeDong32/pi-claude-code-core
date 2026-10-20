/**
 * modes/loop-guard.test.ts — D1/D1b unit pins (spec
 * docs/en/tool-call-loop-guard.md §6, cases 1-10). The FakePi integration
 * cases (11: stopReason=length interop, 12: blocked-first follower) live
 * in index.test.ts.
 */
import { describe, expect, it } from "vitest";

import {
	batchDupReason,
	checkBatchDup,
	createParentLoopBreaker,
	duplicateKey,
	indexBatchDupes,
	parentLoopKey,
} from "./loop-guard.ts";

interface Part {
	type: string;
	id: string;
	name: string;
	arguments: Record<string, unknown>;
}
function assistantMessage(parts: Part[]): { role: string; content: unknown } {
	return { role: "assistant", content: parts };
}
function call(id: string, name = "bash", args: Record<string, unknown> = { command: "bun run contracts" }): Part {
	return { type: "toolCall", id, name, arguments: args };
}

describe("D1 same-batch duplicate suppression", () => {
	it("1: three identical calls in one batch — first passes, followers block with the duplicate reason", () => {
		const index = indexBatchDupes(assistantMessage([call("t1"), call("t2"), call("t3")]))!;
		expect(checkBatchDup(index, "t1")).toBeUndefined();
		expect(checkBatchDup(index, "t2")).toMatch(/byte-identical duplicate/);
		expect(checkBatchDup(index, "t3")).toMatch(/byte-identical duplicate/);
	});

	it("2: two identical + one different-args call — only the follower blocks", () => {
		const index = indexBatchDupes(
			assistantMessage([call("t1"), call("t2"), call("t3", "bash", { command: "ls" })]),
		)!;
		expect(checkBatchDup(index, "t1")).toBeUndefined();
		expect(checkBatchDup(index, "t2")).toBeDefined();
		expect(checkBatchDup(index, "t3")).toBeUndefined();
	});

	it("3: cross-turn repetition passes — a fresh batch index never marks the same call duplicate", () => {
		const first = indexBatchDupes(assistantMessage([call("t1")]))!;
		expect(checkBatchDup(first, "t1")).toBeUndefined();
		const next = indexBatchDupes(assistantMessage([call("t9", "bash", { command: "bun run contracts" })]))!;
		expect(checkBatchDup(next, "t9")).toBeUndefined();
	});

	it("7: fail-open — an id missing from the index passes", () => {
		const index = indexBatchDupes(assistantMessage([call("t1"), call("t2")]))!;
		expect(checkBatchDup(index, "unknown-id")).toBeUndefined();
		expect(checkBatchDup(undefined, "t2")).toBeUndefined();
	});

	it("P3-3: non-assistant messages and empty shapes return null (load-bearing role filter)", () => {
		expect(indexBatchDupes({ role: "user", content: [call("t1")] })).toBeNull();
		expect(indexBatchDupes({ role: "assistant", content: "not-an-array" })).toBeNull();
		expect(indexBatchDupes({ role: "assistant", content: [{ type: "text", text: "hi" }] })).toBeNull();
	});

	it("10a: the reason names the first id and the processed-not-ran wording (guide-to-heal)", () => {
		const index = indexBatchDupes(assistantMessage([call("first-id"), call("second")]))!;
		const reason = checkBatchDup(index, "second")!;
		expect(reason).toContain("first-id");
		expect(reason).toContain("already been processed (executed or blocked)");
		expect(reason).toContain("next turn with a fresh call");
		expect(batchDupReason("x")).toContain("byte-identical duplicate");
	});

	it("key order in arguments does not split a group (canonical stringify)", () => {
		const index = indexBatchDupes(
			assistantMessage([
				{ type: "toolCall", id: "a", name: "bash", arguments: { command: "x", timeout: 5 } },
				{ type: "toolCall", id: "b", name: "bash", arguments: { timeout: 5, command: "x" } },
			]),
		)!;
		expect(checkBatchDup(index, "b")).toBeDefined();
	});
});

describe("D1b parent-level circuit breaker", () => {
	it("4: 25 identical nested calls — first 20 pass, 21st+ blocks with the loop reason", () => {
		const breaker = createParentLoopBreaker(20);
		const key = parentLoopKey("bash", { command: "poll" });
		for (let i = 0; i < 20; i++) expect(breaker.check("p1", key)).toBeUndefined();
		for (let i = 20; i < 25; i++) expect(breaker.check("p1", key)).toMatch(/codemode script/);
	});

	it("5: exactly 20 identical — all pass (maxIdentical = passes allowed)", () => {
		const breaker = createParentLoopBreaker(20);
		const key = parentLoopKey("bash", { command: "x" });
		for (let i = 0; i < 20; i++) expect(breaker.check("p", key)).toBeUndefined();
	});

	it("6: 30 different-args calls under one parent — all pass (keys differ)", () => {
		const breaker = createParentLoopBreaker(20, 256, 64);
		for (let i = 0; i < 30; i++) {
			expect(breaker.check("p", parentLoopKey("bash", { command: `cmd-${i}` }))).toBeUndefined();
		}
	});

	it("9: two parents each 10 identical — all pass (counters independent)", () => {
		const breaker = createParentLoopBreaker(20);
		const key = parentLoopKey("read", { path: "/a" });
		for (let i = 0; i < 10; i++) {
			expect(breaker.check("p1", key)).toBeUndefined();
			expect(breaker.check("p2", key)).toBeUndefined();
		}
	});

	it("P2-2: a parent over its key budget passes NEW keys unrecorded; the stuck few keys still trip", () => {
		const breaker = createParentLoopBreaker(3, 256, 4);
		// fill the parent's key budget with distinct keys
		for (let i = 0; i < 4; i++) breaker.check("p", parentLoopKey("bash", { command: `k${i}` }));
		// a brand-new key passes and is NOT recorded (no growth)
		expect(breaker.check("p", parentLoopKey("bash", { command: "fresh" }))).toBeUndefined();
		// the existing loop key still counts to the cap
		const loopKey = parentLoopKey("bash", { command: "k0" });
		expect(breaker.check("p", loopKey)).toBeUndefined(); // 2nd
		expect(breaker.check("p", loopKey)).toBeUndefined(); // 3rd
		expect(breaker.check("p", loopKey)).toMatch(/codemode script/); // 4th ≥ maxIdentical
	});

	it("P3-5: parents FIFO-evict at maxParents — the oldest parent's counters reset silently", () => {
		const breaker = createParentLoopBreaker(2, 2);
		const key = parentLoopKey("bash", { command: "x" });
		breaker.check("p1", key);
		breaker.check("p2", key);
		breaker.check("p3", key); // evicts p1
		expect(breaker.check("p1", key)).toBeUndefined(); // p1 re-admitted fresh
	});

	it("10b: duplicateKey stability across shapes", () => {
		expect(duplicateKey("bash", { a: 1 })).toBe(duplicateKey("bash", { a: 1 }));
		expect(duplicateKey("bash", { a: 1 })).not.toBe(duplicateKey("bash", { a: 2 }));
		expect(duplicateKey("bash", { a: 1 })).not.toBe(duplicateKey("edit", { a: 1 }));
	});
});
