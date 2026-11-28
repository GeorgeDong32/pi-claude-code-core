import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import coreExtension from "../../extensions/index.ts";
import { FakeHost, type Handler } from "../contracts/fake-host.ts";
import { defaultNotesDir } from "../../lib/agent-paths.ts";

let home: string;
let cwd: string;
let prevHome: string | undefined;

beforeAll(() => {
	prevHome = process.env.HOME;
	home = mkdtempSync(join(tmpdir(), "prompt-stability-home-"));
	cwd = mkdtempSync(join(tmpdir(), "prompt-stability-cwd-"));
	process.env.HOME = home;
	const notesDir = defaultNotesDir(cwd, home);
	mkdirSync(notesDir, { recursive: true });
	writeFileSync(
		join(notesDir, "stability-note.md"),
		"---\nname: stability-note\ndescription: the notes index block must stay byte-identical within a session\nmetadata:\n  type: project\n---\n\nbody\n",
	);
});

afterAll(() => {
	if (prevHome === undefined) delete process.env.HOME;
	else process.env.HOME = prevHome;
	rmSync(home, { recursive: true, force: true });
	rmSync(cwd, { recursive: true, force: true });
});

type BeforeAgentStart = { messageType?: string; systemPrompt?: string; prompt?: string; message?: unknown };

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
			rest.push(await oneTurn(host, ctx, { messageType: "custom", systemPrompt: "BASE" }));
			vi.setSystemTime(new Date("2026-11-25T23:59:59Z"));
			rest.push(await oneTurn(host, ctx, { messageType: "user", systemPrompt: "BASE", prompt: "the next day" }));

			const distinct = new Set(rest);
			expect(distinct.size, `system prompt moved after the first run:\n${[...distinct].map((p) => JSON.stringify(p.slice(0, 200))).join("\n---\n")}`).toBe(1);
			const frozen = rest[0]!;
			expect(frozen).toMatch(/^BASE\n/);
			expect(frozen).toContain("# Project notes");
			expect(frozen).toContain("- stability-note — the notes index block must stay byte-identical within a session");

			const modesBlock = /\n?<!-- permission-modes:context -->\n[\s\S]*?<!-- \/permission-modes:context -->\n?/;
			expect(first).toContain("<!-- permission-modes:context -->");
			expect(frozen).not.toContain("<!-- permission-modes:context -->");
			expect(first.replace(modesBlock, "\n")).toBe(frozen);

			const declaredSets = host.activeToolsCalls.slice(1).map((names) => [...names].sort().join(","));
			expect(declaredSets.length).toBeGreaterThan(0);
			expect(new Set(declaredSets).size, `declared tool set moved:\n${[...new Set(declaredSets)].join("\n---\n")}`).toBe(1);
			rmSync(sessionDir, { recursive: true, force: true });
		} finally {
			vi.useRealTimers();
		}
	});
});
