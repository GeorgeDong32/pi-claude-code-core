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
	it("session_start publishes the split; readCoreStatus exposes it (review #19)", async () => {
		const host = setup();
		const ctx = host.makeCtx({ cwd: project, ui: true });
		await host.fire("session_start", {}, ctx);
		const snap = (globalThis as Record<string, unknown>).__piClaudeCodeCore as {
			contextBudget?: { rulesMax: number; memoryIndexMax: number; dynamicSteerMax: number };
		};
		expect(snap.contextBudget).toEqual({ rulesMax: 40000, memoryIndexMax: 25000, dynamicSteerMax: 8000 });
		const { readCoreStatus } = await import("../../types/core-status.mjs");
		expect(readCoreStatus(globalThis).contextBudget?.rulesMax).toBe(40000);
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
