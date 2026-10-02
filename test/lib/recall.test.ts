/*
 * recall.test.ts — the recall v2 deep module (spec 2026-10-02-memory-recall-v2
 * §8 cases 1–11) over the Recall machine + fake Selector + synthetic
 * projection histories. Pure unit seam: no pi, no fs (candidates are
 * injected; only RV-08's truncation note touches a plausible absPath).
 */
import { describe, expect, it } from "vitest";

import { RECALL_FILE_MAX_BYTES, RECALL_SESSION_MAX_BYTES } from "../../lib/context-budget.ts";
import {
	createRecall,
	deriveHistory,
	recallQuery,
	stripSkillWrapper,
	truncateUtf8,
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
	return createRecall({ selector, modelLabel: "test/selector-1", files: () => files, cwd });
}

describe("RV recall machine (spec §8)", () => {
	it("1 RV-02: skill wrapper stripped; skill-only and <6 chars skip; >4000 chars truncated", async () => {
		const log: SelectorRequest[] = [];
		const m = machine(fakeSelector(instant(["memory/a.md"]), log), [file("memory/a.md")]);
		const skill = `<skill name="diagnosing-bugs" location="/x">\nSkill body with lots of tokens test session bash grep\n</skill>\n\nFix the login bug`;
		const block = await m.onUserMessage(skill, () => [], 50);
		expect(block).not.toBeNull();
		expect(log[0]!.query).toBe("Fix the login bug");

		await m.onUserMessage(`<skill name="x" location="/y">\nonly skill body\n</skill>\n\n`, () => [], 50);
		expect(log.length).toBe(1); // skill-only residue empty → no selector call
		await m.onUserMessage("hi", () => [], 50);
		expect(log.length).toBe(1); // <6 chars → skip

		const longLog: SelectorRequest[] = [];
		const mLong = machine(fakeSelector(instant(["memory/a.md"]), longLog), [file("memory/a.md")]);
		await mLong.onUserMessage("x".repeat(5000), () => [], 50);
		expect(longLog[0]!.query.length).toBe(4000);
		expect(stripSkillWrapper("  plain  ")).toBe("plain");
		expect(recallQuery("继续")).toBeNull();
	});

	it("2 RV-03: instant selector → immediate block with correct details", async () => {
		const m = machine(fakeSelector(instant(["user-memory/u.md", "memory/p.md"])), [file("user-memory/u.md"), file("memory/p.md")]);
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

	it("3 RV-04: slow selector → deferred delivery at first continues=true turn_end, once only", async () => {
		let release: (() => void) | null = null;
		const slow = fakeSelector(async () => {
			await new Promise<void>((r) => {
				release = r;
			});
			return { kind: "selected", keys: ["memory/a.md"], elapsedMs: 9 };
		});
		const m = machine(slow, [file("memory/a.md")]);
		const immediate = await m.onUserMessage("show me the convention", () => [], 10);
		expect(immediate).toBeNull(); // timed out, parked
		expect(m.onTurnEnd(true, () => [])).toBeNull(); // selection still pending
		release!();
		await new Promise((r) => setTimeout(r, 5));
		const deferred = m.onTurnEnd(true, () => []);
		expect(deferred).not.toBeNull();
		expect(deferred!.details.delivery).toBe("deferred");
		expect(m.onTurnEnd(true, () => [])).toBeNull(); // consumed exactly once
		// nothing held → history thunk untouched
		let calls = 0;
		expect(m.onTurnEnd(true, () => (calls++, []))).toBeNull();
		expect(calls).toBe(0);
		// run over without a continuing turn_end → discarded
		const m2 = machine(slow, [file("memory/a.md")]);
		await m2.onUserMessage("show me the convention", () => [], 10);
		release!();
		await new Promise((r) => setTimeout(r, 5));
		expect(m2.onTurnEnd(false, () => [])).toBeNull();
	});

	it("4 RV-04 re-filter: files read after selection drop out of the deferred block; all read → null", async () => {
		let release: (() => void) | null = null;
		const slow = fakeSelector(async () => {
			await new Promise<void>((r) => {
				release = r;
			});
			return { kind: "selected", keys: ["memory/a.md", "memory/b.md"], elapsedMs: 9 };
		});
		const a = file("memory/a.md");
		const b = file("memory/b.md");
		const m = machine(slow, [a, b]);
		await m.onUserMessage("conventions please", () => [], 10);
		release!();
		await new Promise((r) => setTimeout(r, 5));
		const readA = [{ role: "assistant", content: [{ type: "toolCall", name: "read", arguments: { path: a.absPath } }] }];
		const block = m.onTurnEnd(true, () => readA);
		expect(block).not.toBeNull();
		expect(block!.details.files.map((f) => f.key)).toEqual(["memory/b.md"]);

		const m2 = machine(slow, [a, b]);
		await m2.onUserMessage("conventions please", () => [], 10);
		release!();
		await new Promise((r) => setTimeout(r, 5));
		const readBoth = [
			{ role: "assistant", content: [{ type: "toolCall", name: "read", arguments: { path: a.absPath } }] },
			{ role: "assistant", content: [{ type: "toolCall", name: "read", arguments: { path: b.absPath } }] },
		];
		expect(m2.onTurnEnd(true, () => readBoth)).toBeNull();
	});

	it("5 RV-04/05: abort() kills the pending deferred block and aborts the in-flight signal; waitMs 0 never returns immediately", async () => {
		const log: SelectorRequest[] = [];
		let release: (() => void) | null = null;
		const slow = fakeSelector(
			async (req) => {
				await new Promise<void>((r) => {
					release = r;
				});
				return { kind: "selected", keys: ["memory/a.md"], elapsedMs: 9 };
			},
			log,
		);
		const m = machine(slow, [file("memory/a.md")]);
		const zero = await m.onUserMessage("zero wait path", () => [], 0);
		expect(zero).toBeNull(); // waitMs 0 always parks, never immediate
		const aborted = new Promise<boolean>((r) => log[0]!.signal!.addEventListener("abort", () => r(true)));
		m.abort();
		release!();
		await new Promise((r) => setTimeout(r, 5));
		expect(await aborted).toBe(true); // in-flight selection aborted
		expect(m.onTurnEnd(true, () => [])).toBeNull(); // parked result discarded (signal aborted)
	});

	it("6 RV-05: a newer user message supersedes the older selection and aborts its signal", async () => {
		const log: SelectorRequest[] = [];
		const firstSignalAborted = new Promise<boolean>((r) => {
			// attach on next select call
			setTimeout(() => r(false), 50);
		});
		const slow = fakeSelector(
			async (req) => {
				await new Promise<void>(() => {});
				return { kind: "selected", keys: ["memory/a.md"], elapsedMs: 9 };
			},
			log,
		);
		const m = machine(slow, [file("memory/a.md")]);
		void m.onUserMessage("first message", () => [], 5);
		const s1 = log[0]!.signal!;
		const abortedPromise = new Promise<boolean>((r) => s1.addEventListener("abort", () => r(true)));
		const second = await m.onUserMessage("second message supersedes", () => [], 5);
		expect(second).toBeNull(); // second also parks (selector never resolves)
		expect(await abortedPromise).toBe(true);
		void firstSignalAborted;
	});

	it("7 RV-06: surfaced keys (history + this run) never re-enter the manifest", async () => {
		const log: SelectorRequest[] = [];
		const echoFirst = fakeSelector(async (req) => ({ kind: "selected", keys: [req.candidates[0]!.key], elapsedMs: 3 }), log);
		const m = machine(echoFirst, [file("memory/a.md"), file("memory/b.md")]);
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
		const m = machine(fakeSelector(instant(["memory/b.md"]), log), [a, file("memory/b.md")]);
		const history = [
			{ role: "assistant", content: [{ type: "toolCall", name: "read", arguments: { path: a.absPath } }] },
			{ role: "assistant", content: [{ type: "toolCall", name: "read", arguments: { path: `.${a.absPath}` } }] },
		];
		// absolute (as-is) and relative-to-cwd form: use cwd prefix resolution
		const relHistory = [
			{ role: "assistant", content: [{ type: "toolCall", name: "read", arguments: { path: a.absPath.replace("/tmp/mem", "rel/sub") } }] },
		];
		const m2 = machine(fakeSelector(instant(["memory/b.md"]), log), [a, file("memory/b.md")], "/tmp/mem");
		await m.onUserMessage("message long enough here", () => history, 50);
		expect(log[0]!.candidates.map((c) => c.key)).toEqual(["memory/b.md"]);
		// relative resolution: cwd /tmp/mem + rel/sub/project/a.md == /tmp/mem/rel/sub/... — no match for this layout,
		// so exercise the resolver directly:
		const derived = deriveHistory(
			[{ role: "assistant", content: [{ type: "toolCall", name: "read", arguments: { path: "proj/a.md" } }] }],
			"/tmp/mem",
		);
		expect([...derived.read]).toEqual(["/tmp/mem/proj/a.md"]);
		void relHistory;
		void m2;
	});

	it("9 RV-08: truncation + path note; CJK byte-safe; budget skip; >5 keys capped; unknown keys dropped", async () => {
		const big = file("memory/big.md", { body: "汉".repeat(3000) }); // 9000 bytes > 4KB
		const m = machine(fakeSelector(instant(["memory/big.md"])), [big]);
		const block = await m.onUserMessage("give me the big file", () => [], 50);
		expect(block).not.toBeNull();
		const bodyStart = block!.text.indexOf("body of");
		void bodyStart;
		expect(block!.text).toContain(`> truncated at 4KB — read the full file: ${big.absPath}`);
		expect(block!.details.files[0]!.truncated).toBe(true);
		// CJK truncation never splits a code point
		const cut = truncateUtf8("汉".repeat(100), 101);
		expect(cut.text).toBe("汉".repeat(33)); // 33×3=99 ≤ 101, next would be 102
		expect(cut.truncated).toBe(true);

		// session budget exhausted → selector never called
		const log: SelectorRequest[] = [];
		const m2 = machine(fakeSelector(instant(["memory/a.md"]), log), [file("memory/a.md")]);
		const spent = [
			{ role: "custom", customType: "pi-memory-recall", details: { v: 1, delivery: "immediate", model: "x", files: [], bytes: RECALL_SESSION_MAX_BYTES, elapsedMs: 1 } },
		];
		expect(await m2.onUserMessage("budget should block me now", () => spent, 50)).toBeNull();
		expect(log.length).toBe(0);

		// >5 keys capped; unknown keys dropped
		const files = Array.from({ length: 7 }, (_, i) => file(`memory/f${i}.md`));
		const m3 = machine(fakeSelector(instant(files.map((f) => f.key).concat("memory/ghost.md"))), files);
		const b3 = await m3.onUserMessage("many files selected here", () => [], 50);
		expect(b3!.details.files.length).toBe(5);
		expect(b3!.details.files.some((f) => f.key === "memory/ghost.md")).toBe(false);
		expect(RECALL_FILE_MAX_BYTES).toBe(4096);
	});

	it("10 RV-10: a rejecting selector resolves to null, never throws", async () => {
		const bomb = fakeSelector(async () => {
			throw new Error("selector exploded");
		});
		const m = machine(bomb, [file("memory/a.md")]);
		await expect(m.onUserMessage("make it explode please", () => [], 50)).resolves.toBeNull();
		expect(m.stats.failures).toBe(1);
	});

	it("11 RV-13: recentTools = tools succeeded since the last user message, failures excluded", async () => {
		const log: SelectorRequest[] = [];
		const m = machine(fakeSelector(instant(["memory/a.md"]), log), [file("memory/a.md")]);
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
});
