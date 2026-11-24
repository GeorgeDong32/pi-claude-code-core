/*
 * recall.test.ts — the recall v2 deep module (spec 2026-10-02-memory-recall-v2
 * §8 cases 1–11, revised by the memory-policy spec: task-boundary recall,
 * discard-on-timeout) over the Recall machine + fake Selector + synthetic
 * projection histories. Pure unit seam: no pi, no fs (candidates are
 * injected; only RV-08's truncation note touches a plausible absPath).
 *
 * Rewritten cases vs the deferred-delivery era: the parked-selection tests
 * (old 3/C7/4, RC-T01, RC-T06, RC-T07) encoded "a timed-out selection still
 * delivers late". Task-boundary recall discards on timeout instead — the
 * replacements pin the new contract: null on timeout, abort signal fired,
 * late completions mutate nothing.
 */
import { describe, expect, it } from "vitest";

import { RECALL_FILE_MAX_BYTES, RECALL_SESSION_MAX_BYTES } from "../../lib/context-budget.ts";
import {
	RECALL_BOUNDARY_TURNS,
	createRecall,
	deriveHistory,
	recallQuery,
	stripSkillWrapper,
	truncateUtf8,
	type RecallBlock,
	type RecallFile,
} from "../../extensions/memory/recall.ts";
import type { Selector, SelectorRequest, SelectorOutcome } from "../../extensions/memory/selector.ts";

const NOW = 1_800_000_000_000;

function file(key: string, over: Partial<RecallFile> = {}): RecallFile {
	const [layer, name] = key.startsWith("user-memory/") ? (["user", key.slice("user-memory/".length)] as const) : (["project", key.slice("memory/".length)] as const);
	return {
		key,
		file: name,
		title: name.replace(/\.md$/, ""),
		description: `desc of ${name}`,
		type: "project",
		layer,
		mtimeMs: NOW - 1000,
		absPath: `/tmp/mem/${layer}/${name}`,
		body: `---\nname: ${name}\ndescription: d\n---\n\nbody of ${name}`,
		...over,
	};
}

function fakeSelector(
	behavior: (req: SelectorRequest) => Promise<SelectorOutcome>,
	log: SelectorRequest[] = [],
): Selector {
	return {
		async select(req) {
			log.push(req);
			return behavior(req);
		},
	};
}

const instant = (keys: string[]): ((req: SelectorRequest) => Promise<SelectorOutcome>) =>
	async () => ({ kind: "selected", keys, elapsedMs: 3 });

function machine(selector: Selector, files: RecallFile[], cwd = "/w") {
	return { m: createRecall({ selector, modelLabel: "test/selector-1", files: () => files, cwd }) };
}

/** C7: like machine(), but counts deps.files() invocations. */
function countingMachine(selector: Selector, files: RecallFile[]) {
	let calls = 0;
	const m = createRecall({
		selector,
		modelLabel: "test/selector-1",
		files: () => {
			calls += 1;
			return files;
		},
		cwd: "/w",
	});
	return { m, filesCalls: () => calls };
}

describe("RV recall machine (spec §8, boundary revision)", () => {
	it("1 RV-02: skill wrapper stripped; skill-only and <6 chars skip; >4000 chars truncated", async () => {
		const log: SelectorRequest[] = [];
		const { m } = machine(fakeSelector(instant(["memory/a.md"]), log), [file("memory/a.md")]);
		const skill = `<skill name="diagnosing-bugs" location="/x">\nSkill body with lots of tokens test session bash grep\n</skill>\n\nFix the login bug`;
		const block = await m.onUserMessage(skill, () => [], 50);
		expect(block).not.toBeNull();
		expect(log[0]!.query).toBe("Fix the login bug");

		await m.onUserMessage(`<skill name="x" location="/y">\nonly skill body\n</skill>\n\n`, () => [], 50);
		expect(log.length).toBe(1); // skill-only residue empty → no selector call
		await m.onUserMessage("hi", () => [], 50);
		expect(log.length).toBe(1); // <6 chars → skip

		const longLog: SelectorRequest[] = [];
		const { m: mLong } = machine(fakeSelector(instant(["memory/a.md"]), longLog), [file("memory/a.md")]);
		await mLong.onUserMessage("x".repeat(5000), () => [], 50);
		expect(longLog[0]!.query.length).toBe(4000);
		expect(stripSkillWrapper("  plain  ")).toBe("plain");
		expect(recallQuery("继续")).toBeNull();
	});

	it("2 RV-03: instant selector → immediate block with correct details", async () => {
		const { m } = machine(fakeSelector(instant(["user-memory/u.md", "memory/p.md"])), [file("user-memory/u.md"), file("memory/p.md")]);
		const block = await m.onUserMessage("告诉我用户偏好和项目约定", () => [], 100);
		expect(block).not.toBeNull();
		expect(block!.customType).toBe("pi-memory-recall");
		expect(block!.details.v).toBe(1);
		expect(block!.details.delivery).toBe("immediate");
		expect(block!.details.model).toBe("test/selector-1");
		expect(block!.details.files.map((f) => f.key)).toEqual(["user-memory/u.md", "memory/p.md"]);
		expect(block!.details.bytes).toBe(Buffer.byteLength(block!.text, "utf8"));
		expect(block!.text).toContain("## u (user-memory/u.md)");
		expect(block!.text).toContain("## p (memory/p.md)");
		expect(block!.text.startsWith("<memory-recall>")).toBe(true);
	});

	it("3 boundary revision: a timed-out selection is aborted and DISCARDED — no late delivery, stats.late counts it", async () => {
		let release: (() => void) | null = null;
		let aborted = false;
		const slow = fakeSelector(async (req) => {
			req.signal?.addEventListener("abort", () => {
				aborted = true;
			});
			await new Promise<void>((r) => {
				release = r;
			});
			return { kind: "selected", keys: ["memory/a.md"], elapsedMs: 9 };
		});
		const { m } = machine(slow, [file("memory/a.md")]);
		const immediate = await m.onUserMessage("show me the convention", () => [], 10);
		expect(immediate).toBeNull(); // timed out → discarded
		expect(m.stats.late).toBe(1);
		expect(m.stats.deliveries).toBe(0);
		expect(aborted).toBe(true); // the selector's signal was aborted
		// the late completion finds no observer: no delivery, no stats churn
		release!();
		await new Promise((r) => setTimeout(r, 5));
		expect(m.stats.deliveries).toBe(0);
		expect(m.stats.late).toBe(1);
		expect(m.stats.selections).toBe(0);
		// zero-wait is an instant timeout — also discarded, never delivered
		const { m: m0 } = machine(slow, [file("memory/a.md")]);
		const zero = await m0.onUserMessage("zero wait discards as well", () => [], 0);
		expect(zero).toBeNull();
		expect(m0.stats.late).toBe(1);
		expect(m0.stats.deliveries).toBe(0);
	});

	it("C7: the entry pool is reused for assembly — deps.files() runs exactly once per selection", async () => {
		const files = [file("memory/a.md"), file("memory/b.md")];
		const { m, filesCalls } = countingMachine(fakeSelector(instant(["memory/a.md"])), files);
		const block = await m.onUserMessage("show me the convention", () => [], 50);
		expect(block).not.toBeNull();
		expect(block!.details.files.map((f: { key: string }) => f.key)).toEqual(["memory/a.md"]);
		expect(filesCalls()).toBe(1);
	});

	it("4 boundary revision: a selector completing within the wait delivers the ENTRY-pool filtered set", async () => {
		const a = file("memory/a.md");
		const b = file("memory/b.md");
		const history = [{ role: "assistant", content: [{ type: "toolCall", name: "read", arguments: { path: a.absPath } }] }];
		const log: SelectorRequest[] = [];
		const { m } = machine(fakeSelector(instant(["memory/a.md", "memory/b.md"]), log), [a, b]);
		const block = await m.onUserMessage("conventions please", () => history, 50);
		// a.md was already read → dropped at entry; b.md delivered
		expect(log[0]!.candidates.map((c) => c.key)).toEqual(["memory/b.md"]);
		expect(block!.details.files.map((f) => f.key)).toEqual(["memory/b.md"]);
		expect(m.stats.deliveries).toBe(1);
	});

	it("5 abort() kills the in-flight selection (signal aborted, prompt path resolves null)", async () => {
		const log: SelectorRequest[] = [];
		let release: (() => void) | null = null;
		const slow = fakeSelector(
			async () => {
				await new Promise<void>((r) => {
					release = r;
				});
				return { kind: "selected", keys: ["memory/a.md"], elapsedMs: 9 };
			},
			log,
		);
		const { m } = machine(slow, [file("memory/a.md")]);
		const p = m.onUserMessage("mid-wait abort", () => [], 5000);
		const aborted = new Promise<boolean>((r) => log[0]!.signal!.addEventListener("abort", () => r(true)));
		await new Promise((r) => setTimeout(r, 5));
		m.abort(); // a newer user message supersedes
		await expect(p).resolves.toBeNull();
		expect(await aborted).toBe(true);
		release!();
		await new Promise((r) => setTimeout(r, 5));
		expect(m.stats.deliveries).toBe(0);
	});

	it("6 RV-05: a newer user message supersedes the older selection and aborts its signal", async () => {
		const log: SelectorRequest[] = [];
		const slow = fakeSelector(
			async () => {
				await new Promise<void>(() => {});
				return { kind: "selected", keys: ["memory/a.md"], elapsedMs: 9 };
			},
			log,
		);
		const { m } = machine(slow, [file("memory/a.md")]);
		void m.onUserMessage("first message", () => [], 5);
		const s1 = log[0]!.signal!;
		const abortedPromise = new Promise<boolean>((r) => s1.addEventListener("abort", () => r(true)));
		const second = await m.onUserMessage("second message supersedes", () => [], 5);
		expect(second).toBeNull(); // second also times out and is discarded
		expect(await abortedPromise).toBe(true);
	});

	it("7 RV-06: surfaced keys (history + this run) never re-enter the manifest", async () => {
		const log: SelectorRequest[] = [];
		const echoFirst = fakeSelector(async (req) => ({ kind: "selected", keys: [req.candidates[0]!.key], elapsedMs: 3 }), log);
		const { m } = machine(echoFirst, [file("memory/a.md"), file("memory/b.md")]);
		const prior = [
			{ role: "custom", customType: "pi-memory-recall", details: { v: 1, delivery: "immediate", model: "x", files: [{ key: "memory/a.md", bytes: 10, truncated: false }], bytes: 20, elapsedMs: 1 } },
		];
		await m.onUserMessage("some real user message", () => prior, 50);
		// history-level dedup: a.md excluded → only b.md reaches the selector
		expect(log[0]!.candidates.map((c) => c.key)).toEqual(["memory/b.md"]);
		expect(m.stats.deliveries).toBe(1); // b.md delivered this run
		// run-scoped dedup: fresh history, b.md is still excluded (delivered
		// this run) → only a.md reaches the selector now
		await m.onUserMessage("another real user message", () => [], 50);
		expect(log[1]!.candidates.map((c) => c.key)).toEqual(["memory/a.md"]);
		expect(m.stats.deliveries).toBe(2);
	});

	it("8 RV-07: read toolCalls exclude candidates (absolute AND cwd-relative paths)", async () => {
		const a = file("memory/a.md");
		const log: SelectorRequest[] = [];
		const { m } = machine(fakeSelector(instant(["memory/b.md"]), log), [a, file("memory/b.md")]);
		const history = [
			{ role: "assistant", content: [{ type: "toolCall", name: "read", arguments: { path: a.absPath } }] },
			{ role: "assistant", content: [{ type: "toolCall", name: "read", arguments: { path: `.${a.absPath}` } }] },
		];
		const { m: m2 } = machine(fakeSelector(instant(["memory/b.md"]), log), [a, file("memory/b.md")], "/tmp/mem");
		await m.onUserMessage("message long enough here", () => history, 50);
		expect(log[0]!.candidates.map((c) => c.key)).toEqual(["memory/b.md"]);
		// relative resolution: cwd /tmp/mem + rel/sub/project/a.md == /tmp/mem/rel/sub/... — no match for this layout,
		// so exercise the resolver directly:
		const derived = deriveHistory(
			[{ role: "assistant", content: [{ type: "toolCall", name: "read", arguments: { path: "proj/a.md" } }] }],
			"/tmp/mem",
		);
		expect([...derived.read]).toEqual(["/tmp/mem/proj/a.md"]);
		void m2;
	});

	it("9 RV-08: truncation + path note; CJK byte-safe; budget skip; keys capped at RECALL_MAX_FILES; unknown keys dropped", async () => {
		const big = file("memory/big.md", { body: "汉".repeat(3000) }); // 9000 bytes > 4KB
		const { m } = machine(fakeSelector(instant(["memory/big.md"])), [big]);
		const block = await m.onUserMessage("give me the big file", () => [], 50);
		expect(block).not.toBeNull();
		expect(block!.text).toContain(`> truncated at 4KB — read the full file: ${big.absPath}`);
		expect(block!.details.files[0]!.truncated).toBe(true);
		// CJK truncation never splits a code point
		const cut = truncateUtf8("汉".repeat(100), 101);
		expect(cut.text).toBe("汉".repeat(33)); // 33×3=99 ≤ 101, next would be 102
		expect(cut.truncated).toBe(true);

		// session budget exhausted → selector never called
		const log: SelectorRequest[] = [];
		const { m: m2 } = machine(fakeSelector(instant(["memory/a.md"]), log), [file("memory/a.md")]);
		const spent = [
			{ role: "custom", customType: "pi-memory-recall", details: { v: 1, delivery: "immediate", model: "x", files: [], bytes: RECALL_SESSION_MAX_BYTES, elapsedMs: 1 } },
		];
		expect(await m2.onUserMessage("budget should block me now", () => spent, 50)).toBeNull();
		expect(log.length).toBe(0);

		// selected keys cap at RECALL_MAX_FILES (3); unknown keys dropped
		const files = Array.from({ length: 7 }, (_, i) => file(`memory/f${i}.md`));
		const { m: m3 } = machine(fakeSelector(instant(files.map((f) => f.key).concat("memory/ghost.md"))), files);
		const b3 = await m3.onUserMessage("many files selected here", () => [], 50);
		expect(b3!.details.files.length).toBe(3);
		expect(b3!.details.files.some((f) => f.key === "memory/ghost.md")).toBe(false);
		expect(RECALL_FILE_MAX_BYTES).toBe(4096);
	});

	it("10 RV-10: a rejecting selector resolves to null, never throws", async () => {
		const bomb = fakeSelector(async () => {
			throw new Error("selector exploded");
		});
		const { m } = machine(bomb, [file("memory/a.md")]);
		await expect(m.onUserMessage("make it explode please", () => [], 50)).resolves.toBeNull();
		expect(m.stats.failures).toBe(1);
	});

	it("11 RV-13: recentTools = tools succeeded since the last user message, failures excluded", async () => {
		const log: SelectorRequest[] = [];
		const { m } = machine(fakeSelector(instant(["memory/a.md"]), log), [file("memory/a.md")]);
		const history = [
			{ role: "user", content: [{ type: "text", text: "previous turn message" }] },
			{ role: "toolResult", toolName: "bash", isError: false },
			{ role: "toolResult", toolName: "edit", isError: true },
			{ role: "toolResult", toolName: "read", isError: false },
			{ role: "toolResult", toolName: "read", isError: true },
		];
		await m.onUserMessage("next message after tools", () => history, 50);
		expect(log[0]!.recentTools).toEqual(["bash"]); // edit failed once, read has a failure
	});

	it("12 boundary: the selector runs on the first RECALL_BOUNDARY_TURNS user messages, then stops", async () => {
		const log: SelectorRequest[] = [];
		// three files so each in-boundary turn still has an undelivered
		// candidate (one machine never delivers the same file twice)
		const files = [file("memory/a.md"), file("memory/b.md"), file("memory/c.md")];
		const byCall = [["memory/a.md"], ["memory/b.md"], ["memory/c.md"]];
		let call = 0;
		const { m } = machine(
			fakeSelector(async () => ({ kind: "selected" as const, keys: byCall[Math.min(call++, 2)]!, elapsedMs: 3 }), log),
			files,
		);
		// 1st message: no prior user messages → boundary OK
		expect(await m.onUserMessage("first boundary message", () => [], 50)).not.toBeNull();
		// 2nd: one prior → boundary OK
		expect(await m.onUserMessage("second boundary message", () => [{ role: "user", content: "first boundary message" }], 50)).not.toBeNull();
		// 3rd: two priors → out of boundary, selector never called
		const prior2 = [
			{ role: "user", content: "first boundary message" },
			{ role: "user", content: "second boundary message" },
		];
		expect(await m.onUserMessage("third message is out of boundary", () => prior2, 50)).toBeNull();
		expect(log.length).toBe(2);
		expect(m.stats.lastReason).toBe("boundary");
		// and a compaction resets the boundary (counter counts only messages
		// AFTER the last compactionSummary → zero priors → in-boundary again)
		const afterCompact = [
			{ role: "user", content: "pre-compaction message" },
			{ role: "user", content: "another pre-compaction message" },
			{ role: "compactionSummary", content: "summary" },
		];
		expect(await m.onUserMessage("first message after compaction", () => afterCompact, 50)).not.toBeNull();
		expect(log.length).toBe(3);
	});

	it("13 boundary: the selector query carries the previous real user message (≤1000 chars)", async () => {
		const log: SelectorRequest[] = [];
		const { m } = machine(fakeSelector(instant(["memory/a.md"]), log), [file("memory/a.md")]);
		const long = "长".repeat(1500);
		await m.onUserMessage("short follow-up", () => [{ role: "user", content: long }], 50);
		expect(log[0]!.previousUserMessage).toHaveLength(1000);
		// no prior message → absent
		const log2: SelectorRequest[] = [];
		const { m: m2 } = machine(fakeSelector(instant(["memory/a.md"]), log2), [file("memory/a.md")]);
		await m2.onUserMessage("first message has no previous", () => [], 50);
		expect(log2[0]!.previousUserMessage).toBeUndefined();
		// custom-type user messages (recall blocks, directives) do not count
		const log3: SelectorRequest[] = [];
		const { m: m3 } = machine(fakeSelector(instant(["memory/a.md"]), log3), [file("memory/a.md")]);
		await m3.onUserMessage("custom entries are ignored", () => [{ role: "user", customType: "pi-memory-recall", content: "custom text" }], 50);
		expect(log3[0]!.previousUserMessage).toBeUndefined();
	});
});

// ── AR1005-RC (spec 2026-10-05 §4): request lifecycle, cancellation and
// error convergence. Behavioral defect pins were confirmed RED at baseline
// (76e933a + JS commit; neither touches memory) before the fix landed. ──

/** Selector whose completion is gated by an external deferred. */
function gatedSelector(log: SelectorRequest[] = []) {
	let release: ((outcome: SelectorOutcome) => void) | null = null;
	const selector: Selector = {
		select(req) {
			log.push(req);
			return new Promise<SelectorOutcome>((resolve) => {
				release = resolve;
			});
		},
	};
	return {
		selector,
		complete: (outcome: SelectorOutcome) => release?.(outcome),
	};
}

describe("AR1005-RC recall lifecycle", () => {
	it("RC-T01 boundary revision: waitMs=0 discards immediately; a later completion mutates nothing", async () => {
		const gate = gatedSelector();
		const m = createRecall({
			selector: gate.selector,
			modelLabel: "t/1",
			files: () => [file("memory/a.md")],
			cwd: "/w",
		});
		await m.onUserMessage("hello first question", () => [], 0); // instant timeout
		expect(m.stats.late).toBe(1);
		expect(m.stats.deliveries).toBe(0);
		gate.complete({ kind: "selected", keys: ["memory/a.md"], elapsedMs: 2 });
		await new Promise((r) => setTimeout(r, 5));
		expect(m.stats.deliveries).toBe(0);
		expect(m.stats.late).toBe(1);
		expect(m.stats.selections).toBe(0);
	});

	it("RC-T02 RED PIN (supersede during positive wait): the older request must NOT return a stale block (selector resolves after supersede)", async () => {
		let calls = 0;
		const slowThenEmpty: Selector = {
			select(req) {
				calls++;
				if (calls === 1) return new Promise<SelectorOutcome>((resolve) => setTimeout(() => resolve({ kind: "selected", keys: ["memory/slow.md"], elapsedMs: 5 }), 15));
				return Promise.resolve<SelectorOutcome>({ kind: "empty", elapsedMs: 0 });
			},
		};
		const m = createRecall({ selector: slowThenEmpty, modelLabel: "t/1", files: () => [file("memory/slow.md"), file("memory/b.md")], cwd: "/w" });
		const p1 = m.onUserMessage("first slow question", () => [], 200);
		await new Promise((r) => setTimeout(r, 2));
		const p2 = m.onUserMessage("second quick question", () => [], 0); // supersedes p1 mid-wait
		const [r1, r2] = await Promise.all([p1, p2]);
		expect(r2).toBeNull();
		// RED at baseline: r1 returned the stale selected block for the SUPERSEDED message
		expect(r1).toBeNull();
		expect(m.stats.deliveries).toBe(0);
	});

	it("RC-T02: dispose drops a discarded-on-timeout selection even when the selector ignores abort — zero history reads, zero delivers", async () => {
		const historyReads: number[] = [];
		const gate = gatedSelector();
		const m = createRecall({
			selector: gate.selector,
			modelLabel: "t/1",
			files: () => [file("memory/c.md")],
			cwd: "/w",
		});
		const hist = () => {
			historyReads.push(1);
			return [];
		};
		await m.onUserMessage("question that times out", hist, 0);
		expect(historyReads).toHaveLength(1); // entry-time read only
		m.dispose(); // session shutdown — synchronous, no model wait
		gate.complete({ kind: "selected", keys: ["memory/c.md"], elapsedMs: 1 }); // late, ignores abort
		await new Promise((r) => setTimeout(r, 5));
		expect(m.stats.deliveries).toBe(0);
		expect(historyReads).toHaveLength(1); // NO read for the late completion
	});

	it("RC-T04: dispose during a positive wait resolves the in-flight call promptly (bounded, no stale block)", async () => {
		const never: Selector = { select: () => new Promise<SelectorOutcome>(() => {}) }; // ignores abort forever
		const m = createRecall({ selector: never, modelLabel: "t/1", files: () => [file("memory/d.md")], cwd: "/w" });
		const t0 = Date.now();
		const p = m.onUserMessage("waiting question", () => [], 5000);
		await new Promise((r) => setTimeout(r, 10));
		m.dispose();
		const block = await p;
		expect(block).toBeNull();
		expect(Date.now() - t0).toBeLessThan(500); // immediate, not bounded by waitMs
		expect(m.stats.deliveries).toBe(0);
	});

	it("RC-T05 RED PIN (total promise): entry-stage throws (history/files/selector sync+async) converge to null, never reject", async () => {
		const diags: string[] = [];
		const boom = () => {
			throw new Error("stale ctx");
		};
		const syncThrowSelector: Selector = { select: () => { throw new Error("sync boom"); } } as never;
		const asyncRejectSelector: Selector = { select: () => Promise.reject(new Error("async boom")) };
		// history throws
		const m1 = createRecall({ selector: syncThrowSelector, modelLabel: "t/1", files: () => [file("memory/e.md")], cwd: "/w", diagnose: (d) => diags.push(d) });
		await expect(m1.onUserMessage("history throws here", boom, 0)).resolves.toBeNull();
		// files throws
		const m2 = createRecall({ selector: syncThrowSelector, modelLabel: "t/1", files: boom as never, cwd: "/w", diagnose: (d) => diags.push(d) });
		await expect(m2.onUserMessage("files throw here", () => [], 0)).resolves.toBeNull();
		// selector throws synchronously
		const m3 = createRecall({ selector: syncThrowSelector, modelLabel: "t/1", files: () => [file("memory/e.md")], cwd: "/w", diagnose: (d) => diags.push(d) });
		await expect(m3.onUserMessage("selector sync throws", () => [], 50)).resolves.toBeNull();
		// selector rejects asynchronously
		const m4 = createRecall({ selector: asyncRejectSelector, modelLabel: "t/1", files: () => [file("memory/e.md")], cwd: "/w", diagnose: (d) => diags.push(d) });
		await expect(m4.onUserMessage("selector async rejects", () => [], 50)).resolves.toBeNull();
		expect(m4.stats.failures).toBeGreaterThanOrEqual(1);
		expect(m4.stats.lastReason).toBe("selector_throw");
	});

	it("RC-T07 boundary revision: after timeout-discards, a late completion leaves no dedup pollution", async () => {
		// first two calls hang (the late-completion scenario), the third is
		// instant — a real in-boundary selection after the discards
		let release: ((outcome: SelectorOutcome) => void) | null = null;
		let calls = 0;
		const selector: Selector = {
			select(req) {
				calls++;
				if (calls <= 2) {
					return new Promise<SelectorOutcome>((resolve) => {
						release = resolve;
					});
				}
				return Promise.resolve({ kind: "selected", keys: ["memory/h.md"], elapsedMs: 1 });
			},
		};
		const m = createRecall({ selector, modelLabel: "t/1", files: () => [file("memory/h.md")], cwd: "/w" });
		await m.onUserMessage("old message times out", () => [], 0);
		await m.onUserMessage("new message times out", () => [], 0); // supersedes the old request
		// the resolver was captured inside select()'s promise executor — CFA
		// can't see the assignment, hence the cast
		(release as ((outcome: SelectorOutcome) => void) | null)?.({ kind: "selected", keys: ["memory/h.md"], elapsedMs: 1 });
		await new Promise((r) => setTimeout(r, 5));
		expect(m.stats.late).toBe(2);
		expect(m.stats.deliveries).toBe(0);
		expect(m.stats.selections).toBe(0);
		// the file was never committed as delivered → still eligible for a
		// real in-boundary selection
		const block = await m.onUserMessage("third message, instant selector", () => [], 50);
		expect(block).not.toBeNull();
		expect(m.stats.selections).toBe(1);
	});

	it("RC-T08: dispose is idempotent; post-dispose calls return null without invoking the selector; a fresh machine works", async () => {
		const log: SelectorRequest[] = [];
		const gate = gatedSelector(log);
		const m = createRecall({ selector: gate.selector, modelLabel: "t/1", files: () => [file("memory/i.md")], cwd: "/w" });
		m.dispose();
		m.dispose();
		await expect(m.onUserMessage("after dispose", () => [], 0)).resolves.toBeNull();
		expect(log).toHaveLength(0); // no selector invocation
		const m2 = createRecall({ selector: fakeSelector(instant(["memory/i.md"])), modelLabel: "t/1", files: () => [file("memory/i.md")], cwd: "/w" });
		const block = await m2.onUserMessage("fresh machine", () => [], 0);
		expect(block).toBeNull(); // waitMs=0 → discarded
		expect(m2.stats.late).toBe(1);
	});

	it("RC-T10: abort during a positive wait also resolves promptly and clears the wait timer (no stale block)", async () => {
		const never: Selector = { select: () => new Promise<SelectorOutcome>(() => {}) };
		const m = createRecall({ selector: never, modelLabel: "t/1", files: () => [file("memory/j.md")], cwd: "/w" });
		const t0 = Date.now();
		const p = m.onUserMessage("will be aborted", () => [], 5000);
		await new Promise((r) => setTimeout(r, 10));
		m.abort(); // before_agent_start supersede path
		await expect(p).resolves.toBeNull();
		expect(Date.now() - t0).toBeLessThan(500);
	});
});

describe("deriveHistory boundary inputs", () => {
	it("counts real user messages since the last compactionSummary and captures the latest text", () => {
		const history = [
			{ role: "user", content: "old message one" },
			{ role: "user", content: "old message two" },
			{ role: "compactionSummary", content: "summary" },
			{ role: "user", content: "post-compact message" },
			{ role: "assistant", content: [{ type: "text", text: "reply" }] },
		];
		const derived = deriveHistory(history, "/w");
		expect(derived.userTurns).toBe(1); // only post-compact messages count
		expect(derived.lastUserText).toBe("post-compact message");
	});

	it("a long previous message is truncated to 1000 chars; custom-type user messages are ignored", () => {
		const derived = deriveHistory(
			[
				{ role: "user", customType: "pi-memory-recall", content: "custom block text" },
				{ role: "user", content: "x".repeat(1200) },
			],
			"/w",
		);
		expect(derived.userTurns).toBe(1);
		expect(derived.lastUserText).toHaveLength(1000);
	});

	it("RECALL_BOUNDARY_TURNS pins the boundary width", () => {
		expect(RECALL_BOUNDARY_TURNS).toBe(2);
	});
});
