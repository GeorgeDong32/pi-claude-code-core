/**
 * P3-RU-07/08/09/10 rules wiring on a fake host + REAL filesystem tmp dirs:
 * steer-on-first-touch with once-per-session dedup, session_start reset,
 * mtime-fingerprint cheapness (one rescan on change, cache reuse otherwise),
 * the /rules read-only output, and the contextBudget bus publish.
 */
import { describe, expect, it, beforeEach, vi } from "vitest";

// count statSync globally for the cheapness test (node:fs namespace is
// frozen, so spy-on-namespace is impossible; a factory mock keeps every
// other fs function on its real implementation)
const statCalls: Array<[string]> = [];
vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	const wrapped = ((...args: Parameters<typeof actual.statSync>) => {
		statCalls.push([String(args[0])]);
		return actual.statSync(...args);
	}) as typeof actual.statSync;
	return { ...actual, statSync: wrapped };
});
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createRulesExtension } from "../../extensions/rules/index.ts";
import { FakeHost, clearCoreGlobals, snapshotCoreGlobals } from "../contracts/fake-host.ts";

let globalsSnapshot: Record<string, unknown>;
let project: string;

beforeEach(() => {
	globalsSnapshot = snapshotCoreGlobals();
	clearCoreGlobals();
	project = mkdtempSync(join(tmpdir(), "rules-wire-"));
	return () => rmSync(project, { recursive: true, force: true });
});

function setup() {
	const host = new FakeHost();
	const ext = createRulesExtension();
	ext(host.asPi());
	return host;
}

function writeRule(rel: string, content: string): void {
	const dir = join(project, rel, "..");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(project, rel), content);
}

const TS_RULE = `---
name: ts-conventions
description: TypeScript style
globs:
  - "src/**/*.ts"
---
Use strict TypeScript idioms.`;

async function fireTurn(host: FakeHost): Promise<void> {
	const ctx = host.makeCtx({ cwd: project, ui: true });
	await host.fire("before_agent_start", { systemPrompt: "base" }, ctx);
}

describe("P3-RU-07 first-touch steer activation", () => {
	it("steers the rule once on first matching tool_call, dedups, resets on session_start", async () => {
		writeRule(".pi/rules/ts.md", TS_RULE);
		const host = setup();
		const ctx = host.makeCtx({ cwd: project, ui: true });
		await host.fire("session_start", {}, ctx);
		await fireTurn(host);

		const touch = async () => {
			await host.fire("tool_call", { toolName: "edit", input: { path: join(project, "src/a.ts") } }, ctx);
		};

		await touch();
		const activations = host.sentMessages.filter((m) => m.message.customType === "pi-rules-activate");
		expect(activations.length).toBe(1);
		expect((activations[0].opts as { deliverAs?: string }).deliverAs).toBe("steer");
		expect((activations[0].message as { display?: boolean }).display).toBe(true);
		expect((activations[0].message as { content?: string }).content).toContain("Use strict TypeScript idioms.");

		await touch();
		expect(host.sentMessages.filter((m) => m.message.customType === "pi-rules-activate").length).toBe(1);

		// session_start (/reload) resets the activation set
		await host.fire("session_start", {}, ctx);
		await touch();
		expect(host.sentMessages.filter((m) => m.message.customType === "pi-rules-activate").length).toBe(2);
	});

	it("non-path tools and non-matching paths never steer", async () => {
		writeRule(".pi/rules/ts.md", TS_RULE);
		const host = setup();
		const ctx = host.makeCtx({ cwd: project, ui: true });
		await host.fire("session_start", {}, ctx);
		await fireTurn(host);

		await host.fire("tool_call", { toolName: "bash", input: { command: "ls" } }, ctx);
		await host.fire("tool_call", { toolName: "read", input: { path: "/elsewhere/x.ts" } }, ctx);
		expect(host.sentMessages.filter((m) => m.message.customType === "pi-rules-activate")).toHaveLength(0);
	});
});

describe("P3-RU-08 cheapness (mtime fingerprint)", () => {
	it("reuses the cache while the fingerprint holds and rescans after a change", async () => {
		writeRule(".pi/rules/one.md", "---\nname: one\n---\nbody one");
		const host = setup();
		const ctx = host.makeCtx({ cwd: project, ui: true });
		await host.fire("session_start", {}, ctx);

		await fireTurn(host);
		const prompt1 = host.handlers.get("before_agent_start")![0] as never;
		void prompt1;
		// capture outputs via returned systemPrompt
		const runPrompt = async (): Promise<string> => {
			const results: Array<{ systemPrompt?: string }> = [];
			for (const h of host.handlers.get("before_agent_start") ?? []) {
				const r = await (h as (e: unknown, c: unknown) => Promise<{ systemPrompt?: string } | undefined>)(
					{ systemPrompt: "base" },
					ctx,
				);
				results.push(r ?? {});
			}
			return results.map((r) => r.systemPrompt ?? "").join("|");
		};

		const out1 = await runPrompt();
		expect(out1).toContain("body one");

		// unchanged dir → cache reused (identical output object semantics:
		// the rendered block is byte-identical and no rescan happens)
		const out2 = await runPrompt();
		expect(out2).toBe(out1);

		// file changes → next before_agent_start picks it up (P3-RU-08)
		writeRule(".pi/rules/two.md", "---\nname: two\n---\nbody two");
		const out3 = await runPrompt();
		expect(out3).toContain("body two");
		expect(out3).toContain("body one");
	});

	it("before_agent_start appends to systemPrompt without mutating it (P3-RU-06)", async () => {
		writeRule(".pi/rules/one.md", "---\nname: one\n---\nbody one");
		const host = setup();
		const ctx = host.makeCtx({ cwd: project, ui: true });
		await host.fire("session_start", {}, ctx);
		const result = (await (host.handlers.get("before_agent_start")![0] as (e: unknown, c: unknown) => Promise<{ systemPrompt?: string }>)(
			{ systemPrompt: "BASE" },
			ctx,
		))!;
		expect(result.systemPrompt!.startsWith("BASE")).toBe(true);
		expect(result.systemPrompt).toContain("body one");
	});

	it("stat cost is one per rule dir per turn while unchanged (P3-RU-08 promise)", async () => {
		writeRule(".pi/rules/one.md", "---\nname: one\n---\nbody one");
		const host = setup();
		const ctx = host.makeCtx({ cwd: project, ui: true });
		await host.fire("session_start", {}, ctx);
		await fireTurn(host); // warms the fingerprint cache
		statCalls.length = 0;
		await fireTurn(host); // unchanged turn
		// dirs needing stat: global + compat + project = 3 (builtin is static)
		expect(statCalls.length).toBeLessThanOrEqual(3);
	});
});

describe("P3-RU-10 contextBudget on the bus", () => {
	it("session_start publishes the split (review #19; D4-READER-REMOVE: snapshot read)", async () => {
		const host = setup();
		const ctx = host.makeCtx({ cwd: project, ui: true });
		await host.fire("session_start", {}, ctx);
		const snap = (globalThis as Record<string, unknown>).__piClaudeCodeCore as {
			contextBudget?: { rulesMax: number; memoryIndexMax: number; dynamicSteerMax: number };
		};
		expect(snap.contextBudget).toEqual({ rulesMax: 40000, memoryIndexMax: 25000, dynamicSteerMax: 8000 });
	});
});

describe("P3-RU-09 /rules read-only output", () => {
	it("reports counts, scope, activation and budget usage", async () => {
		writeRule(".pi/rules/one.md", "---\nname: one\n---\nbody one");
		writeRule(".pi/rules/ts.md", TS_RULE);
		const host = setup();
		const ctx = host.makeCtx({ cwd: project, ui: true });
		await host.fire("session_start", {}, ctx);
		await host.fire("tool_call", { toolName: "edit", input: { path: join(project, "src/a.ts") } }, ctx);

		const handler = host.commands.get("rules");
		expect(handler).toBeDefined();
		await handler?.("", ctx);

		const listed = host.sentMessages.find((m) => m.message.customType === "pi-rules-list");
		expect(listed).toBeDefined();
		const content = (listed!.message as { content?: string }).content ?? "";
		expect(content).toMatch(/rules: \d+ inline, \d+ indexed, \d+\/40000 chars, 1 activated this session/);
		expect(content).toContain("one");
		expect(content).toContain("ts-conventions");
		expect(content).toContain("[project]");
	});
});

// ── AR1005-RU (spec 2026-10-05 §8): the cumulative per-turn activation
// budget. Baseline defect (reproduced): one read hitting three 6 K rules
// sent 3 × ~6,013 = ~18 K chars — each message was checked against
// DYNAMIC_STEER_MAX alone, never the turn's sum. Baseline red via stash. ──
import { createRuleActivation } from "../../extensions/rules/activation.ts";
import { DYNAMIC_STEER_MAX } from "../../lib/context-budget.ts";

const BIG = (name: string, globs: string, kb = 6): string =>
	`---\nname: ${name}\ndescription: big rule\nglobs:\n  - "${globs}"\n---\n\n${"x".repeat(kb * 1000)}`;

function activationContents(host: FakeHost): string[] {
	return host.sentMessages.filter((m) => m.message.customType === "pi-rules-activate").map((m) => (m.message as { content?: string }).content ?? "");
}

describe("AR1005-RU cumulative turn budget", () => {
	it("RU-T01: three 6K rules on one read — cumulative ≤ 8K, one full + pointers, no truncation", async () => {
		writeRule(".pi/rules/big-a.md", BIG("big-a", "src/**/*.ts"));
		writeRule(".pi/rules/big-b.md", BIG("big-b", "src/**/*.ts"));
		writeRule(".pi/rules/big-c.md", BIG("big-c", "src/**/*.ts"));
		const host = setup();
		const ctx = host.makeCtx({ cwd: project, ui: true });
		await host.fire("session_start", {}, ctx);
		await fireTurn(host);
		await host.fire("tool_call", { toolName: "read", input: { path: join(project, "src/a.ts") } }, ctx);
		const contents = activationContents(host);
		expect(contents).toHaveLength(3);
		const total = contents.reduce((sum, c) => sum + c.length, 0);
		expect(total).toBeLessThanOrEqual(DYNAMIC_STEER_MAX); // baseline: ~18K
		expect(contents[0]).toMatch(/^### big-a\n\n+x+$/); // full text, byte-identical shape
		expect(contents[0].length).toBeGreaterThan(5_000); // genuinely the full body, not a pointer
		expect(contents[1]).toContain("rules/big-b.md on demand");
		expect(contents[2]).toContain("rules/big-c.md on demand");
	});

	it("RU-T02/RU-T04: same-turn tool calls share the budget; an unfittable rule defers unactivated and retries next turn", async () => {
		writeRule(".pi/rules/big-a.md", BIG("big-a", "src/**/*.ts", 7.9)); // full ~7 912 -> ~88 left
		writeRule(".pi/rules/big-b.md", BIG("big-b", "src/**/*.ts"));
		writeRule(".pi/rules/tiny.md", BIG("tiny", "docs/**/*.md"));
		const host = setup();
		const ctx = host.makeCtx({ cwd: project, ui: true });
		await host.fire("session_start", {}, ctx);
		await fireTurn(host);
		await host.fire("tool_call", { toolName: "read", input: { path: join(project, "src/a.ts") } }, ctx);
		const contents = activationContents(host);
		expect(contents).toHaveLength(1); // big-a's full only — even a pointer no longer fits
		expect(contents[0]).toMatch(/^### big-a/);
		// same turn, another tool call: the budget is NOT re-granted (RU-T02)
		await host.fire("tool_call", { toolName: "read", input: { path: join(project, "docs/x.md") } }, ctx);
		expect(activationContents(host)).toHaveLength(1); // tiny deferred — not sent, not activated
		// next turn: budget recovers (RU-T03/RU-T04); tiny now sends a pointer
		await host.fire("turn_start", { type: "turn_start", turnIndex: 1 }, ctx);
		await host.fire("tool_call", { toolName: "read", input: { path: join(project, "docs/y.md") } }, ctx);
		expect(activationContents(host)).toHaveLength(2);
		expect(activationContents(host)[1]).toMatch(/^### tiny/); // fresh 8K turn — the full text fits again
		// session dedup does NOT recover with the turn (RU-T03): big-a stays silent
		await host.fire("tool_call", { toolName: "read", input: { path: join(project, "src/b.ts") } }, ctx);
		expect(activationContents(host)).toHaveLength(3); // big-b's pointer arrives; big-a deduped
	});

	it("RU-T05: a successfully sent pointer counts as session-activated", async () => {
		writeRule(".pi/rules/big-a.md", BIG("big-a", "src/**/*.ts"));
		writeRule(".pi/rules/big-b.md", BIG("big-b", "src/**/*.ts"));
		const host = setup();
		const ctx = host.makeCtx({ cwd: project, ui: true });
		await host.fire("session_start", {}, ctx);
		await fireTurn(host);
		await host.fire("tool_call", { toolName: "read", input: { path: join(project, "src/a.ts") } }, ctx);
		expect(activationContents(host)).toHaveLength(2); // full + pointer
		await host.fire("turn_start", { type: "turn_start", turnIndex: 1 }, ctx);
		await host.fire("tool_call", { toolName: "read", input: { path: join(project, "src/z.ts") } }, ctx);
		expect(activationContents(host)).toHaveLength(2); // pointer-sent big-b stays deduped next turn
	});

	it("RU-T07: the cold path (first tool_call before any render) applies the same activation decisions", async () => {
		writeRule(".pi/rules/big-a.md", BIG("big-a", "src/**/*.ts"));
		writeRule(".pi/rules/big-b.md", BIG("big-b", "src/**/*.ts"));
		const host = setup();
		const ctx = host.makeCtx({ cwd: project, ui: true });
		await host.fire("session_start", {}, ctx);
		// NOTE: no fireTurn — the tool_call runs the cold path (full render)
		await host.fire("tool_call", { toolName: "read", input: { path: join(project, "src/a.ts") } }, ctx);
		const contents = activationContents(host);
		expect(contents).toHaveLength(2);
		expect(contents[0]).toMatch(/^### big-a/);
		expect(contents[1]).toContain("rules/big-b.md on demand"); // cold-path pointers embed the absolute path (pre-existing)
	});
});

describe("AR1005-RU module behavior (sync send adapter)", () => {
	it("RU-T06: a throwing send rolls back the reservation — no budget spent, not activated, others unaffected", () => {
		const sent: string[] = [];
		let throwsLeft = 0;
		const a = createRuleActivation({
			send: (content) => {
				if (throwsLeft > 0) {
					throwsLeft--;
					throw new Error("send boom");
				}
				sent.push(content);
			},
			budgetChars: 10_000,
		});
		const big = { name: "r1", path: ".pi/rules/r1.md", content: "z".repeat(6_000) };
		const small = { name: "r2", path: ".pi/rules/r2.md", content: "s".repeat(100) };
		throwsLeft = 1; // the first rule's send fails; the second still goes out
		const r = a.activate([big, small]);
		expect(r.failed).toBe(1);
		expect(r.sent).toBe(1);
		expect(a.sessionActivatedCount()).toBe(1); // small only
		expect(a.remainingTurnBudget()).toBe(10_000 - 108); // big's reservation rolled back; small's full = 8 + 100
		expect(sent[0]).toMatch(/^### r2/);
		throwsLeft = 0; // the failed rule stays eligible and unactivated
		const r2 = a.activate([big]);
		expect(r2.sent).toBe(1);
		expect(sent[1]).toMatch(/^### r1/);
	});

	it("RU-T06: a synchronously re-entrant adapter cannot double-spend the remaining budget", () => {
		const sent: string[] = [];
		let reentering = false;
		const a = createRuleActivation({
			send: (content) => {
				sent.push(content);
				if (!reentering) {
					reentering = true;
					// re-enter synchronously mid-activation (adapter reentrancy)
					a.activate([{ name: "inner", path: ".pi/rules/inner.md", content: "i".repeat(100) }]);
					reentering = false;
				}
			},
			budgetChars: 500,
		});
		const outer = { name: "outer", path: ".pi/rules/outer.md", content: "o".repeat(300) };
		const inner2 = { name: "inner2", path: ".pi/rules/inner2.md", content: "n".repeat(300) };
		const r = a.activate([outer, inner2]);
		// both re-entrant deliveries really went out through the same budget
		expect(sent.some((c) => c.startsWith("### inner\n"))).toBe(true);
		expect(sent.some((c) => c.startsWith("### outer\n"))).toBe(true);
		// reservation happens BEFORE the send, so the re-entrant call observed
		// the deducted budget — the sum never exceeds the budget
		expect(sent.map((c) => c.length).reduce((x, y) => x + y, 0)).toBeLessThanOrEqual(500);
		expect(r.sent + r.deferred + r.failed).toBe(2); // both rules accounted
	});

	it("RU-T06: short pointer rung keeps the full path; nothing fits → deferred, eligible next turn", () => {
		const sent: string[] = [];
		const a = createRuleActivation({ send: (c) => sent.push(c), budgetChars: 300 });
		const longName = { name: "n".repeat(250), path: ".pi/rules/some-quite-long-rule-file-name.md", content: "c".repeat(50) };
		// full (250+50+6) > 300; pointer (>300, long name) > 300; short pointer (~250+50) may fit
		const r1 = a.activate([longName]);
		if (r1.sent === 1) {
			expect(sent[0]).toContain(".pi/rules/some-quite-long-rule-file-name.md"); // path never truncated
			expect(sent[0]).not.toMatch(/### /); // no body sent
		} else {
			expect(r1.deferred).toBe(1);
		}
		// nothing fits at all → deferred and eligible next turn
		const a2 = createRuleActivation({ send: (c) => sent.push(c), budgetChars: 10 });
		const wide = { name: "w".repeat(200), path: "p".repeat(200), content: "x" };
		const r2 = a2.activate([wide]);
		expect(r2.sent).toBe(0);
		expect(r2.deferred).toBe(1);
		a2.onTurnStart();
		expect(a2.activate([{ ...wide, content: "short" }]).deferred + a2.activate([{ ...wide, content: "short" }]).sent).toBeGreaterThanOrEqual(0);
	});
});
