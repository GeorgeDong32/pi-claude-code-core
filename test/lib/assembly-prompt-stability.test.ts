/*
 * P1-3: the assembled core's system prompt is session-stable.
 *
 * A prompt-cache miss costs the whole prefix again, and a per-turn
 * instability multiplies over thousands of turns (Luke Alvoeiro, AI Engineer
 * 2026). memory made its policy block stable at session start / compaction
 * (2026-11-24 batch, M-4); rules caches its block per directory state. What
 * was missing is the assembled view: EVERY module's `before_agent_start`
 * contribution together, across real turn boundaries (turn_end / agent_end /
 * agent_settled), across a custom-message run, and across the clock.
 *
 * Chaining mirrors pi: each handler's returned fields replace the event
 * fields before the next handler runs. The assertion is deliberately
 * content-blind (byte-identical) plus one content check so an assembly that
 * injects nothing cannot pass vacuously.
 *
 * Known, declared move (found by this test on 2026-11-24): modes arms the
 * ask-mode reminder at session_start and consumes it on the first run, so the
 * FIRST run differs from every later one by exactly that block. Pinned below
 * by name; anything else that moves fails the test.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import coreExtension from "../../extensions/index.ts";
import { FakeHost, type Handler } from "../contracts/fake-host.ts";

let home: string;
let cwd: string;
let prevHome: string | undefined;

beforeAll(() => {
	prevHome = process.env.HOME;
	home = mkdtempSync(join(tmpdir(), "prompt-stability-home-"));
	cwd = mkdtempSync(join(tmpdir(), "prompt-stability-cwd-"));
	process.env.HOME = home;
});

afterAll(() => {
	if (prevHome === undefined) delete process.env.HOME;
	else process.env.HOME = prevHome;
	rmSync(home, { recursive: true, force: true });
	rmSync(cwd, { recursive: true, force: true });
});

type BeforeAgentStart = { messageType?: string; systemPrompt?: string; prompt?: string; message?: unknown };

/** Run every before_agent_start handler the way pi does: chained. */
async function chainedBeforeAgentStart(host: FakeHost, payload: BeforeAgentStart, ctx: Record<string, unknown>): Promise<BeforeAgentStart> {
	let event: BeforeAgentStart = { ...payload };
	for (const handler of host.handlers.get("before_agent_start") ?? ([] as Handler[])) {
		const result = (await handler(event, ctx)) as Partial<BeforeAgentStart> | undefined;
		if (result && typeof result === "object") event = { ...event, ...result };
	}
	return event;
}

async function oneTurn(host: FakeHost, ctx: Record<string, unknown>, payload: BeforeAgentStart): Promise<string> {
	const event = await chainedBeforeAgentStart(host, payload, ctx);
	await host.fire("turn_end", { turnIndex: 0, message: { role: "assistant", content: [{ type: "text", text: "ok" }] }, toolResults: [] }, ctx);
	await host.fire("agent_end", { messages: [] }, ctx);
	await host.fire("agent_settled", {}, ctx);
	return event.systemPrompt ?? "";
}

describe("assembled core: the system prompt does not move within a session", () => {
	it("is byte-identical from the second user run on (turns, a custom-message run, the clock); the only allowed move is the declared first-run one-shot", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		try {
			vi.setSystemTime(new Date("2026-11-24T10:00:00Z"));
			const host = new FakeHost();
			await coreExtension(host.piObject() as never);
			const sessionDir = mkdtempSync(join(tmpdir(), "prompt-stability-sess-"));
			const ctx = host.makeCtx({ cwd, sessionDir, sessionId: "sess-prompt-stability", ui: true });
			await host.fire("session_start", {}, ctx);

			const first = await oneTurn(host, ctx, { messageType: "user", systemPrompt: "BASE", prompt: "turn 1: the first task" });
			const rest: string[] = [];
			for (let turn = 2; turn <= 5; turn += 1) {
				rest.push(await oneTurn(host, ctx, { messageType: "user", systemPrompt: "BASE", prompt: `turn ${turn}: unrelated task ${turn}` }));
			}
			// a directive-style run (goal continuation, review, consolidation) gets the same prefix
			rest.push(await oneTurn(host, ctx, { messageType: "custom", systemPrompt: "BASE" }));
			// the next day, same session
			vi.setSystemTime(new Date("2026-11-25T23:59:59Z"));
			rest.push(await oneTurn(host, ctx, { messageType: "user", systemPrompt: "BASE", prompt: "the next day" }));

			const distinct = new Set(rest);
			expect(distinct.size, `system prompt moved after the first run:\n${[...distinct].map((p) => JSON.stringify(p.slice(0, 200))).join("\n---\n")}`).toBe(1);
			const frozen = rest[0]!;
			expect(frozen).toMatch(/^BASE\n/);
			// not vacuous: the assembly injected something (memory's policy block is unconditional)
			expect(frozen).toContain("<memory-policy");

			// The first run differs by EXACTLY the modes one-shot block, nothing else.
			const modesBlock = /\n?<!-- permission-modes:context -->\n[\s\S]*?<!-- \/permission-modes:context -->\n?/;
			expect(first).toContain("<!-- permission-modes:context -->");
			expect(frozen).not.toContain("<!-- permission-modes:context -->");
			expect(first.replace(modesBlock, "\n")).toBe(frozen);
			rmSync(sessionDir, { recursive: true, force: true });
		} finally {
			vi.useRealTimers();
		}
	});
});
