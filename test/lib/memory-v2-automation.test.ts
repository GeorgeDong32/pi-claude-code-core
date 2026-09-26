/**
 * V2-A (DESIGN-MEMORY-V2 §4) — side-channel LLM + automation hooks.
 *
 * Covers: strict-JSON ops extraction (fences / trailing object / garbage /
 * empty), prompt guardrail (no parseable example), timeout + abort paths,
 * auth resolution failure, correction regex gate (EN + CJK + negative),
 * correction throttle (1 per 3 turns), review thresholds + warmup +
 * directive-turn exclusion, flush on compact/shutdown, reload skip, and
 * yielded silence. The LLM is always the injected fake — no network.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FakeHost, clearCoreGlobals, snapshotCoreGlobals } from "../contracts/fake-host.ts";
import { resetCoreBusForTests } from "../../extensions/bus.ts";
import memoryExtension from "../../extensions/memory/index.ts";
import { parseOperations, completeMemoryOps } from "../../extensions/memory/llm.ts";
import { isCorrection, loadMemorySettings, resolveSideChannelModel, setupAutomation, type AutomationState } from "../../extensions/memory/automation.ts";
import { ConsolidationTrigger } from "../../extensions/memory/consolidate.ts";
import { resolveMemoryPaths } from "../../extensions/memory/paths.ts";

let globalsSnapshot: Record<string, unknown>;
let home: string;
let project: string;
let prevHome: string | undefined;
let dir: string;
let udir: string;

beforeEach(() => {
	globalsSnapshot = snapshotCoreGlobals();
	clearCoreGlobals();
	resetCoreBusForTests();
	prevHome = process.env.HOME;
	home = mkdtempSync(join(tmpdir(), "memv2a-home-"));
	project = mkdtempSync(join(tmpdir(), "memv2a-proj-"));
	process.env.HOME = home;
	const p = resolveMemoryPaths(project, home);
	dir = p.memoryDir;
	udir = p.userMemoryDir;
});

afterEach(() => {
	if (prevHome === undefined) delete process.env.HOME;
	else process.env.HOME = prevHome;
	rmSync(home, { recursive: true, force: true });
	rmSync(project, { recursive: true, force: true });
});

// ─── llm.ts extraction ───

describe("V2-A parseOperations", () => {
	it("parses a plain JSON object", () => {
		const ops = parseOperations(`{"operations":[{"action":"add","layer":"user","name":"x","description":"d","body":"b"}]}`);
		expect(ops).not.toBeNull();
		expect(ops!).toHaveLength(1);
		expect(ops![0]).toMatchObject({ action: "add", layer: "user" });
	});

	it("parses the LAST fenced block (answer trails preamble)", () => {
		const text = '```json\n{"operations":[]}\n```\nsome prose\n```json\n{"operations":[{"action":"remove","layer":"project","file":"a.md"}]}\n```';
		expect(parseOperations(text)![0]!.action).toBe("remove");
	});

	it("parses a trailing balanced object out of surrounding prose", () => {
		const text = `Here is what I would save: {"operations":[{"action":"add","layer":"project","name":"y","description":"d","body":"b"}]} — done.`;
		expect(parseOperations(text)).not.toBeNull();
	});

	it("tolerates hermes-style target field as layer", () => {
		const ops = parseOperations(`{"operations":[{"action":"add","target":"user","name":"x","description":"d","body":"b"}]}`);
		expect(ops![0]!.layer).toBe("user");
	});

	it("garbage / arrays / missing operations → null (parse_error)", () => {
		expect(parseOperations("no json here at all")).toBeNull();
		expect(parseOperations('{"foo": 1}')).toBeNull();
		expect(parseOperations("[1,2,3]")).toBeNull();
	});

	it("drops malformed items, keeps valid ones; empty array parses (not null)", () => {
		const ops = parseOperations(`{"operations":[{"action":"add","layer":"bogus"},{"action":"remove","layer":"project","file":"a.md"},42]}`);
		expect(ops!).toHaveLength(1);
		expect(parseOperations('{"operations":[]}')).toEqual([]);
	});

	it("balanced spans are string-aware: braces inside strings do not confuse the scan", () => {
		const text = `{"operations":[{"action":"add","layer":"user","name":"x","description":"has } brace","body":"also { brace"}]}`;
		expect(parseOperations(text)).not.toBeNull();
	});
});

// ─── llm.ts completion (fake transport) ───

const fakeModel = { provider: "fake", id: "m1", reasoning: false } as never;
const fakeRegistry = {
	getApiKeyAndHeaders: async () => ({ ok: true as const, apiKey: "k", headers: {}, env: {} }),
};

function fakeComplete(text: string) {
	return async () => ({ stopReason: "stop", errorMessage: undefined, content: [{ type: "text", text }] });
}

describe("V2-A completeMemoryOps", () => {
	it("happy path: ops extracted from the response text", async () => {
		const r = await completeMemoryOps(fakeModel, fakeRegistry, { systemPrompt: "s", userPrompt: "u" }, { complete: fakeComplete('{"operations":[{"action":"add","layer":"user","name":"x","description":"d","body":"b"}]}') as never });
		expect(r.ok).toBe(true);
		expect(r.ops).toHaveLength(1);
	});

	it("timeout: a hanging completion aborts (never blocks the hook)", async () => {
		const r = await completeMemoryOps(
			fakeModel,
			fakeRegistry,
			{ systemPrompt: "s", userPrompt: "u", timeoutMs: 20 },
			{
				complete: (_m: unknown, _c: unknown, opts: { signal?: AbortSignal }) =>
					new Promise((_resolve, reject) => {
						opts.signal?.addEventListener("abort", () => reject(new Error("aborted")));
					}),
			} as never,
		);
		expect(r.ok).toBe(false);
		expect(r.reason).toBe("aborted");
	});

	it("empty response text → empty_response (skip, no subprocess fallback by design)", async () => {
		const r = await completeMemoryOps(fakeModel, fakeRegistry, { systemPrompt: "s", userPrompt: "u" }, { complete: fakeComplete("   ") as never });
		expect(r.reason).toBe("empty_response");
	});

	it("provider error stopReason surfaces as provider_error", async () => {
		const r = await completeMemoryOps(fakeModel, fakeRegistry, { systemPrompt: "s", userPrompt: "u" }, { complete: (async () => ({ stopReason: "error", errorMessage: "boom", content: [] })) as never });
		expect(r.reason).toBe("provider_error");
		expect(r.error).toBe("boom");
	});

	it("no model / no auth fail fast without calling the provider", async () => {
		expect((await completeMemoryOps(undefined, fakeRegistry, { systemPrompt: "s", userPrompt: "u" })).reason).toBe("no_model");
		const noAuth = { getApiKeyAndHeaders: async () => ({ ok: false as const, error: "no key" }) };
		expect((await completeMemoryOps(fakeModel, noAuth, { systemPrompt: "s", userPrompt: "u" })).reason).toBe("no_auth");
	});
});

// ─── automation hooks (wired through setupAutomation with fake LLM) ───

interface Harness {
	host: FakeHost;
	ctx: Record<string, unknown>;
	state: AutomationState;
	calls: string[];
}

function harness(llmText: string, opts: { yielded?: boolean; sessionEntries?: unknown[]; complete?: () => Promise<unknown> } = {}): Harness {
	const host = new FakeHost();
	const state: AutomationState = { enabled: true, reviews: 0, corrections: 0, flushes: 0, opsApplied: 0 };
	const calls: string[] = [];
	const trigger = new ConsolidationTrigger({ sendDirective: () => {} });
	const complete = opts.complete ?? (async () => ({ stopReason: "stop", errorMessage: undefined, content: [{ type: "text", text: llmText }] }));
	setupAutomation(host.asPi(), {
		gate: { state: { yielded: opts.yielded ?? false } },
		dirs: () => ({ project: dir, user: udir }),
		trigger,
		settings: () => ({ automation: true }),
		state,
		deps: { complete: (() => { calls.push(llmText); return complete(); }) as never },
	});
	const ctx = host.makeCtx({ cwd: project, ui: true, sessionEntries: opts.sessionEntries ?? [] });
	ctx.model = fakeModel;
	ctx.modelRegistry = fakeRegistry;
	return { host, ctx, state, calls };
}

async function until(cond: () => boolean, ms = 2000): Promise<void> {
	const deadline = Date.now() + ms;
	while (!cond()) {
		if (Date.now() > deadline) throw new Error("condition not reached in time");
		await new Promise((r) => setTimeout(r, 10));
	}
}

const OPS_JSON = JSON.stringify({
	operations: [{ action: "add", layer: "project", name: "correction-foo", description: "[correction] use pnpm not npm", type: "feedback", body: "Use pnpm, not npm." }],
});

describe("V2-A correction gate", () => {
	it("EN strong/weak/negative + CJK patterns behave", () => {
		expect(isCorrection("don't do that, use pnpm")).toBe(true);
		expect(isCorrection("That's not what I asked for")).toBe(true);
		expect(isCorrection("no, use the other file")).toBe(true); // weak + directive
		expect(isCorrection("no worries")).toBe(false);
		expect(isCorrection("actually looks great")).toBe(false);
		expect(isCorrection("不对，应该用 pnpm")).toBe(true);
		expect(isCorrection("不是这样，我说过要中文回复")).toBe(true);
		expect(isCorrection("别再自动提交了")).toBe(true);
		expect(isCorrection("以后都先跑测试")).toBe(true);
		expect(isCorrection("没问题，继续")).toBe(false);
		expect(isCorrection("今天天气不错")).toBe(false);
	});
});

describe("V2-A correction automation", () => {
	it("user correction → turn_end fires the side-channel → ops applied + notify + counter", async () => {
		const h = harness(OPS_JSON);
		await h.host.fire("message_end", { message: { role: "user", content: [{ type: "text", text: "不对，应该用 pnpm 而不是 npm" }] } }, h.ctx);
		await h.host.fire("turn_end", { turnIndex: 0, message: { role: "assistant" }, toolResults: [] }, h.ctx);
		await until(() => h.state.corrections === 1);
		expect(existsSync(join(dir, "correction-foo.md"))).toBe(true);
		expect(h.host.notifications.some((n) => n.includes("correction captured"))).toBe(true);
		expect(h.state.opsApplied).toBe(1);
	});

	it("throttled to 1 per 3 turns: an immediate second correction waits", async () => {
		const h = harness(OPS_JSON);
		for (let i = 0; i < 2; i++) {
			await h.host.fire("message_end", { message: { role: "user", content: [{ type: "text", text: "不对，再来一次 " + i }] } }, h.ctx);
			await h.host.fire("turn_end", { turnIndex: i, message: { role: "assistant" }, toolResults: [] }, h.ctx);
		}
		await until(() => h.calls.length >= 1);
		expect(h.calls.length).toBe(1); // second correction is in cooldown
	});

	it("yielded (hermes present) ⇒ no side-channel at all", async () => {
		const h = harness(OPS_JSON, { yielded: true });
		await h.host.fire("message_end", { message: { role: "user", content: [{ type: "text", text: "don't do that" }] } }, h.ctx);
		await h.host.fire("turn_end", { turnIndex: 0, message: { role: "assistant" }, toolResults: [] }, h.ctx);
		await new Promise((r) => setTimeout(r, 50));
		expect(h.calls.length).toBe(0);
	});
});

describe("V2-A background review", () => {
	it("fires after 10 turns with ≥3 user turns; ops applied to the right layer", async () => {
		const h = harness(JSON.stringify({ operations: [{ action: "add", layer: "user", name: "pref-language", description: "replies in chinese", type: "user", body: "所有回复默认中文" }] }));
		for (let i = 0; i < 3; i++) await h.host.fire("message_end", { message: { role: "user", content: [{ type: "text", text: `hello ${i}` }] } }, h.ctx);
		for (let i = 0; i < 10; i++) await h.host.fire("turn_end", { turnIndex: i, message: { role: "assistant" }, toolResults: [] }, h.ctx);
		await until(() => h.state.reviews === 1);
		expect(existsSync(join(udir, "pref-language.md"))).toBe(true);
	});

	it("tool-call threshold (15) fires before the turn threshold", async () => {
		const h = harness(OPS_JSON);
		for (let i = 0; i < 3; i++) await h.host.fire("message_end", { message: { role: "user", content: [{ type: "text", text: `hi ${i}` }] } }, h.ctx);
		// 3 turns × 5 toolCall blocks = 15
		for (let i = 0; i < 3; i++) {
			await h.host.fire("turn_end", { turnIndex: i, message: { role: "assistant", content: [{ type: "text", text: "t" }, ...Array.from({ length: 5 }, () => ({ type: "toolCall", name: "read" }))] }, toolResults: [] }, h.ctx);
		}
		await until(() => h.state.reviews === 1);
		expect(h.state.reviews).toBe(1);
	});

	it("warmup: fewer than 3 user turns → never fires", async () => {
		const h = harness(OPS_JSON);
		for (let i = 0; i < 2; i++) await h.host.fire("message_end", { message: { role: "user", content: [{ type: "text", text: `x ${i}` }] } }, h.ctx);
		for (let i = 0; i < 12; i++) await h.host.fire("turn_end", { turnIndex: i, message: { role: "assistant" }, toolResults: [] }, h.ctx);
		await new Promise((r) => setTimeout(r, 50));
		expect(h.state.reviews).toBe(0);
	});

	it("directive-driven consolidation turns are excluded from accounting", async () => {
		const h = harness(OPS_JSON);
		// simulate an active consolidation directive turn: 20 turns must NOT review
		const trigger = new ConsolidationTrigger({ sendDirective: () => {} });
		trigger.directiveTurnActive = true;
		// rewire: easiest is a second harness whose dirs match and a shared trigger —
		// instead verify via the real wiring: memoryExtension sets this on send.
		const host = new FakeHost();
		const state: AutomationState = { enabled: true, reviews: 0, corrections: 0, flushes: 0, opsApplied: 0 };
		const sharedTrigger = new ConsolidationTrigger({ sendDirective: () => {} });
		sharedTrigger.directiveTurnActive = true;
		const calls: string[] = [];
		setupAutomation(host.asPi(), {
			gate: { state: { yielded: false } },
			dirs: () => ({ project: dir, user: udir }),
			trigger: sharedTrigger,
			settings: () => ({ automation: true }),
			state,
			deps: { complete: (() => { calls.push("x"); return Promise.resolve({ stopReason: "stop", content: [{ type: "text", text: OPS_JSON }] }); }) as never },
		});
		const ctx = host.makeCtx({ cwd: project, ui: true });
		ctx.model = fakeModel;
		ctx.modelRegistry = fakeRegistry;
		for (let i = 0; i < 3; i++) await host.fire("message_end", { message: { role: "user", content: [{ type: "text", text: `y ${i}` }] } }, ctx);
		for (let i = 0; i < 15; i++) await host.fire("turn_end", { turnIndex: i, message: { role: "assistant" }, toolResults: [] }, ctx);
		await new Promise((r) => setTimeout(r, 50));
		expect(calls.length).toBe(0);
	});
});

describe("V2-A flush", () => {
	it("session_before_compact awaits a flush and records it", async () => {
		const entries = [
			{ type: "message", message: { role: "user", content: "关于构建流程" } },
			{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "bun run check" }] } },
		];
		const h = harness(OPS_JSON, { sessionEntries: entries });
		for (let i = 0; i < 3; i++) await h.host.fire("message_end", { message: { role: "user", content: [{ type: "text", text: `z ${i}` }] } }, h.ctx);
		await h.host.fire("session_before_compact", { reason: "manual", signal: new AbortController().signal }, h.ctx);
		expect(h.state.flushes).toBe(1);
		expect(h.state.lastFlush).toContain("compact");
	});

	it("session_shutdown: reload skips, quit flushes", async () => {
		const h = harness(OPS_JSON, { sessionEntries: [{ type: "message", message: { role: "user", content: "x" } }] });
		for (let i = 0; i < 3; i++) await h.host.fire("message_end", { message: { role: "user", content: [{ type: "text", text: `w ${i}` }] } }, h.ctx);
		await h.host.fire("session_shutdown", { reason: "reload" }, h.ctx);
		expect(h.state.flushes).toBe(0);
		const h2 = harness(OPS_JSON, { sessionEntries: [{ type: "message", message: { role: "user", content: "x" } }] });
		for (let i = 0; i < 3; i++) await h2.host.fire("message_end", { message: { role: "user", content: [{ type: "text", text: `w ${i}` }] } }, h2.ctx);
		await h2.host.fire("session_shutdown", { reason: "quit" }, h2.ctx);
		expect(h2.state.flushes).toBe(1);
		expect(h2.state.lastFlush).toContain("shutdown");
	});

	it("a failed flush never throws into the compact handler", async () => {
		const h = harness("", {
			complete: (async () => ({ stopReason: "error", errorMessage: "provider down", content: [] })) as never,
			sessionEntries: [{ type: "message", message: { role: "user", content: "x" } }],
		});
		for (let i = 0; i < 3; i++) await h.host.fire("message_end", { message: { role: "user", content: [{ type: "text", text: `v ${i}` }] } }, h.ctx);
		await expect(h.host.fire("session_before_compact", { reason: "manual", signal: new AbortController().signal }, h.ctx)).resolves.toBeUndefined();
		expect(h.state.lastError).toContain("flush");
	});
});

describe("V2-A settings", () => {
	it("loads the two knobs with defaults", () => {
		expect(loadMemorySettings(join(home, "nowhere"))).toEqual({ automation: true });
		mkdirSync(join(home, ".pi", "agent"), { recursive: true });
		writeFileSync(join(home, ".pi", "agent", "settings.json"), JSON.stringify({ memory: { automation: false, model: "anthropic/claude-sonnet-4" } }));
		expect(loadMemorySettings(join(home, ".pi", "agent"))).toEqual({ automation: false, model: "anthropic/claude-sonnet-4" });
	});

	it("automation:false disables every hook path", async () => {
		const host = new FakeHost();
		const state: AutomationState = { enabled: false, reviews: 0, corrections: 0, flushes: 0, opsApplied: 0 };
		const calls: string[] = [];
		setupAutomation(host.asPi(), {
			gate: { state: { yielded: false } },
			dirs: () => ({ project: dir, user: udir }),
			trigger: new ConsolidationTrigger({ sendDirective: () => {} }),
			settings: () => ({ automation: false }),
			state,
			deps: { complete: (() => { calls.push("x"); return Promise.resolve({ stopReason: "stop", content: [{ type: "text", text: OPS_JSON }] }); }) as never },
		});
		const ctx = host.makeCtx({ cwd: project, ui: true });
		ctx.model = fakeModel;
		ctx.modelRegistry = fakeRegistry;
		await host.fire("message_end", { message: { role: "user", content: [{ type: "text", text: "don't do that" }] } }, ctx);
		await host.fire("turn_end", { turnIndex: 0, message: { role: "assistant" }, toolResults: [] }, ctx);
		await new Promise((r) => setTimeout(r, 30));
		expect(calls.length).toBe(0);
	});

	it("side-channel model resolves the settings override (single exact match) or falls back", () => {
		const registry = { getAll: () => [{ provider: "p1", id: "m" }, { provider: "p2", id: "m" }] } as never;
		const exact = resolveSideChannelModel({ automation: true, model: "p1/m" }, undefined, registry);
		expect((exact as { id: string }).id).toBe("m");
		expect((exact as { provider: string }).provider).toBe("p1");
		const ambiguous = resolveSideChannelModel({ automation: true, model: "m" }, undefined, registry);
		expect(ambiguous).toBeUndefined();
		const fallback = { id: "session" } as never;
		expect(resolveSideChannelModel({ automation: true }, fallback, undefined)).toBe(fallback);
	});
});

describe("V2-A prompt guardrails", () => {
	it("automation prompts describe the schema in prose only (no parseable example)", async () => {
		// indirect: fire a correction and capture the systemPrompt handed to the fake
		let seenSystem = "";
		const host = new FakeHost();
		const state: AutomationState = { enabled: true, reviews: 0, corrections: 0, flushes: 0, opsApplied: 0 };
		setupAutomation(host.asPi(), {
			gate: { state: { yielded: false } },
			dirs: () => ({ project: dir, user: udir }),
			trigger: new ConsolidationTrigger({ sendDirective: () => {} }),
			settings: () => ({ automation: true }),
			state,
			deps: {
				complete: ((_m: unknown, ctx: { systemPrompt: string }) => {
					seenSystem = ctx.systemPrompt;
					return Promise.resolve({ stopReason: "stop", content: [{ type: "text", text: '{"operations":[]}' }] });
				}) as never,
			},
		});
		const ctx = host.makeCtx({ cwd: project, ui: true });
		ctx.model = fakeModel;
		ctx.modelRegistry = fakeRegistry;
		await host.fire("message_end", { message: { role: "user", content: [{ type: "text", text: "don't do that" }] } }, ctx);
		await host.fire("turn_end", { turnIndex: 0, message: { role: "assistant" }, toolResults: [] }, ctx);
		await until(() => seenSystem !== "");
		expect(seenSystem).not.toMatch(/"operations"\s*:\s*\[/); // no literal example
		expect(seenSystem).toContain("operations");
	});
});

describe("V2-A full wiring smoke (memoryExtension registers the hooks)", () => {
	it("turn_end from the real extension reaches automation (correction path, fake model via ctx mutation)", async () => {
		const host = new FakeHost();
		memoryExtension(host.asPi());
		const ctx = host.makeCtx({ cwd: project, ui: true });
		ctx.model = fakeModel;
		ctx.modelRegistry = fakeRegistry;
		await host.fire("session_start", {}, ctx);
		// automation uses the REAL complete (no seam here) — assert only that the
		// hooks are registered and nothing throws on a no-auth fake registry path
		await expect(
			host.fire("message_end", { message: { role: "user", content: [{ type: "text", text: "不对" }] } }, ctx),
		).resolves.toBeUndefined();
		await expect(
			host.fire("turn_end", { turnIndex: 0, message: { role: "assistant" }, toolResults: [] }, ctx),
		).resolves.toBeUndefined();
	});
});

describe("V2 Phase 2 (B3) — settle timing", () => {
	it("tool_result settle keeps the turn directive-owned (no review counting); agent_settled re-opens accounting", async () => {
		const host = new FakeHost();
		memoryExtension(host.asPi());
		const ctx = host.makeCtx({ cwd: project, ui: true });
		ctx.model = fakeModel;
		ctx.modelRegistry = fakeRegistry;
		await host.fire("session_start", {}, ctx);
		for (let i = 0; i < 3; i++) await host.fire("message_end", { message: { role: "user", content: [{ type: "text", text: `u ${i}` }] } }, ctx);
		mkdirSync(dir, { recursive: true });
		for (let i = 0; i < 205; i++) {
			writeFileSync(join(dir, `m${String(i).padStart(3, "0")}.md`), `---\nname: m${i}\ndescription: d\nmetadata:\n  type: project\n---\n\nfact ${i}`);
		}
		const reviewsOf = async (): Promise<number> => {
			host.sentMessages.length = 0;
			await host.commands.get("memory")?.("", ctx);
			const msg = host.sentMessages.find((m) => m.message.customType === "pi-memory-status");
			const m = /reviews (\d+)/.exec((msg!.message as { content?: string }).content ?? "");
			return Number(m?.[1] ?? -1);
		};
		// over-budget store → directive fires; its turn is directive-owned
		await host.fire("turn_end", { turnIndex: 0, message: { role: "assistant" }, toolResults: [] }, ctx);
		expect(host.sentMessages.some((m) => m.message.customType === "pi-memory-consolidate")).toBe(true);
		// tool returns mid-turn (B3: settles in-flight ONLY, turn stays owned)
		await host.fire("tool_result", { toolName: "memory_consolidate", content: [], isError: false }, ctx);
		// 11 turn_ends past the review threshold — still the directive's turn:
		// the hook early-returns, review never ticks
		for (let i = 1; i <= 11; i++) await host.fire("turn_end", { turnIndex: i, message: { role: "assistant" }, toolResults: [] }, ctx);
		expect(await reviewsOf()).toBe(0);
		// turn fully settles → accounting re-opens; 10 fresh turns → one review
		await host.fire("agent_settled", {}, ctx);
		for (let i = 12; i <= 21; i++) await host.fire("turn_end", { turnIndex: i, message: { role: "assistant" }, toolResults: [] }, ctx);
		await new Promise((r) => setTimeout(r, 80));
		expect(await reviewsOf()).toBe(1);
	});
});

describe("V2 Phase 3 (AD5) — extraction cursor + model-wrote mutex", () => {
	it("second review processes only messages beyond the cursor (no window overlap)", async () => {
		const entries: Array<{ type: string; message: { role: string; content: Array<{ type: string; text: string }> } }> =
			Array.from({ length: 8 }, (_, i) => ({
				type: "message",
				message: { role: i % 2 ? "assistant" : "user", content: [{ type: "text", text: `window-one message ${i}` }] },
			}));
		const prompts: string[] = [];
		const host = new FakeHost();
		const state: AutomationState = { enabled: true, reviews: 0, corrections: 0, flushes: 0, opsApplied: 0 };
		setupAutomation(host.asPi(), {
			gate: { state: { yielded: false } },
			dirs: () => ({ project: dir, user: udir }),
			trigger: new ConsolidationTrigger({ sendDirective: () => {} }),
			settings: () => ({ automation: true }),
			state,
			deps: { complete: ((_m: unknown, req: { messages: Array<{ content: Array<{ text?: string }> }> }) => {
				prompts.push(req.messages[0]!.content.map((c) => c.text ?? "").join(" "));
				return Promise.resolve({ stopReason: "stop", content: [{ type: "text", text: '{"operations":[]}' }] });
			}) as never },
		});
		const ctx = host.makeCtx({ cwd: project, ui: true, sessionEntries: entries });
		ctx.model = fakeModel;
		ctx.modelRegistry = fakeRegistry;
		// first review: full window
		for (let i = 0; i < 3; i++) await host.fire("message_end", { message: { role: "user", content: [{ type: "text", text: `u${i}` }] } }, ctx);
		for (let i = 0; i < 10; i++) await host.fire("turn_end", { turnIndex: i, message: { role: "assistant" }, toolResults: [] }, ctx);
		await until(() => state.reviews === 1);
		expect(prompts.length).toBe(1);
		expect(prompts[0]).toContain("window-one message 0");
		// branch grows; second review must see ONLY the new messages
		entries.push(
			...Array.from({ length: 6 }, (_, i) => ({
				type: "message",
				message: { role: i % 2 ? "assistant" : "user", content: [{ type: "text", text: `window-two message ${i}` }] },
			})),
		);
		for (let i = 10; i < 20; i++) await host.fire("turn_end", { turnIndex: i, message: { role: "assistant" }, toolResults: [] }, ctx);
		await until(() => state.reviews === 2);
		expect(prompts.length).toBe(2);
		expect(prompts[1]).not.toContain("window-one message 0");
		expect(prompts[1]).toContain("window-two message 0");
	});

	it("model writing a memory file suppresses the review LLM pass (cursor still advances)", async () => {
		const calls: string[] = [];
		const host = new FakeHost();
		const state: AutomationState = { enabled: true, reviews: 0, corrections: 0, flushes: 0, opsApplied: 0 };
		setupAutomation(host.asPi(), {
			gate: { state: { yielded: false } },
			dirs: () => ({ project: dir, user: udir }),
			trigger: new ConsolidationTrigger({ sendDirective: () => {} }),
			settings: () => ({ automation: true }),
			state,
			deps: { complete: (() => { calls.push("x"); return Promise.resolve({ stopReason: "stop", content: [{ type: "text", text: '{"operations":[]}' }] }); }) as never },
		});
		const ctx = host.makeCtx({ cwd: project, ui: true, sessionEntries: [] });
		ctx.model = fakeModel;
		ctx.modelRegistry = fakeRegistry;
		for (let i = 0; i < 3; i++) await host.fire("message_end", { message: { role: "user", content: [{ type: "text", text: `u${i}` }] } }, ctx);
		// the model writes into a memory layer → mutex arms
		await host.fire("tool_call", { toolName: "write", input: { path: join(udir, "self.md"), content: "---\nname: s\ndescription: d\nmetadata:\n  type: user\n---\n\nb" } }, ctx);
		for (let i = 0; i < 10; i++) await host.fire("turn_end", { turnIndex: i, message: { role: "assistant" }, toolResults: [] }, ctx);
		await until(() => state.reviews === 1);
		expect(calls.length).toBe(0); // no LLM pass
		expect(state.lastReview).toContain("model wrote memory");
		// next window without writes resumes LLM reviews
		for (let i = 10; i < 20; i++) await host.fire("turn_end", { turnIndex: i, message: { role: "assistant" }, toolResults: [] }, ctx);
		await until(() => calls.length === 1);
	});
});
