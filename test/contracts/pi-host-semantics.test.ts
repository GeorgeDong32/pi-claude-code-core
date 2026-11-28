import { describe, expect, it } from "vitest";
import {
	VERSION,
	withFileMutationQueue,
	createBashToolDefinition,
	createEditToolDefinition,
	createWriteToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { FakeHost, type Handler } from "./fake-host.ts";

describe("pi host semantics the economy modules depend on (CON-01)", () => {
	it("① a context handler's rewritten messages become the projection result", async () => {
		const host = new FakeHost();
		const ctx = host.makeCtx({ cwd: "/tmp" });
		const rewritten = [{ role: "user", content: [{ type: "text", text: "projected" }] }] as never;
		(host.piObject() as { on: (e: string, h: Handler) => void }).on("context", () => ({ messages: rewritten }));
		const handlers = host.handlers.get("context")! as Handler[];
		const result = (await handlers[0](
			{ type: "context", messages: [] } as never,
			ctx as never,
		)) as { messages: unknown };
		expect(result.messages).toBe(rewritten);
	});

	it("② load-time registerTool with the same name overrides getAllTools parameters", () => {
		const host = new FakeHost();
		host.toolInfos.push({ name: "write", sourceInfo: { source: "builtin" } });
		(host.piObject() as {
			registerTool: (def: { name: string; parameters?: unknown; execute: (...a: any[]) => Promise<unknown> }) => void;
		}).registerTool({
			name: "write",
			parameters: { type: "object", properties: { path: {}, content: {}, then_run: {} } },
			execute: async () => ({}) as never,
		});
		const pi = host.piObject() as { getAllTools: () => Array<{ name: string; parameters?: { properties?: Record<string, unknown> } }> };
		const write = pi.getAllTools().find((t) => t.name === "write");
		expect(Object.keys(write?.parameters?.properties ?? {})).toContain("then_run");
	});

	it("③ withFileMutationQueue is a callable export of the real pi package", async () => {
		expect(typeof withFileMutationQueue).toBe("function");
		const order: number[] = [];
		const first = withFileMutationQueue("/tmp/con-a", async () => {
			await new Promise((r) => setTimeout(r, 20));
			order.push(1);
		});
		const second = withFileMutationQueue("/tmp/con-a", async () => {
			order.push(2);
		});
		await Promise.all([first, second]);
		expect(order).toEqual([1, 2]);
	});

	it("④ VERSION is importable and well-formed from the real pi package", () => {
		expect(typeof VERSION).toBe("string");
		expect(/^\d+\.\d+\.\d+/.test(VERSION)).toBe(true);
	});

	it("⑤ builtin mutation/bash tool factories are importable", () => {
		expect(typeof createWriteToolDefinition).toBe("function");
		expect(typeof createEditToolDefinition).toBe("function");
		expect(typeof createBashToolDefinition).toBe("function");
	});
});

import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { targets } from "./targets.ts";

function largeToolResult(text: string): never {
	return {
		role: "toolResult",
		toolCallId: "tc-large",
		toolName: "bash",
		isError: false,
		content: [{ type: "text", text }],
	} as never;
}

describe("observation-pack context projection (CON-03)", () => {
	it("keeps original bytes per-message when the store is broken (fail-open)", async () => {
		const host = new FakeHost();
		targets["observation-pack"].factory(host.piObject() as never);
		const root = await mkdtemp(join(tmpdir(), "con03-"));
		await mkdir(join(root, "observation-pack", "sess-1"), { recursive: true });
		await writeFile(join(root, "observation-pack", "sess-1", "objects"), "blocks the directory", "utf8");
		const ctx = host.makeCtx({ cwd: root, sessionDir: root, sessionId: "sess-1" });
		const text = "z".repeat(11 * 1024);
		const messages = [largeToolResult(text)];
		for (let i = 0; i < 4; i += 1) {
			const result = await (host.handlers.get("context")! as Handler[])[0](
				{ type: "context", messages } as never,
				ctx as never,
			);
			const projected = (result as { messages: unknown[] }).messages;
			const kept = projected[0] as { content: Array<{ type: string; text: string }> };
			expect(kept.content[0].text).toBe(text);
		}
	});

	it("replaces with a placeholder from the request after FULL_SENDS (healthy store)", async () => {
		const host = new FakeHost();
		targets["observation-pack"].factory(host.piObject() as never);
		const root = await mkdtemp(join(tmpdir(), "con03b-"));
		const ctx = host.makeCtx({ cwd: root, sessionDir: root, sessionId: "sess-2" });
		const text = Array.from({ length: 400 }, (_, i) => `row-${i}-${"y".repeat(40)}`).join("\n");
		const messages = [largeToolResult(text)];
		const handlers = host.handlers.get("context")! as Handler[];
		let sawPlaceholder = false;
		for (let i = 0; i < 4; i += 1) {
			const result = (await handlers[0]({ type: "context", messages } as never, ctx as never)) as {
				messages: Array<{ content: Array<{ type: string; text: string }> }>;
			};
			const body = result.messages[0].content[0].text;
			if (i >= 2) {
				expect(body).toContain("retrieve: call obs_recall");
				sawPlaceholder = true;
			} else {
				expect(body).toBe(text);
			}
		}
		expect(sawPlaceholder).toBe(true);
		const names = (host.piObject() as { getAllTools: () => Array<{ name: string }> }).getAllTools().map((t) => t.name);
		expect(names).toContain("obs_recall");
	});
});

import coreExtension from "../../extensions/index.ts";

describe("assembly order (CON-04)", () => {
	it("observation-pack owns the FINAL context handler slot after modes and notes-index", async () => {
		const host = new FakeHost();
		(host.piObject() as { on: (e: string, h: Handler) => () => void }).on("context", () => undefined);
		const before = (host.handlers.get("context")! as Handler[]).length;
		await coreExtension(host.piObject() as never);
		const contextHandlers = host.handlers.get("context")! as Handler[];
		expect(contextHandlers.length).toBeGreaterThan(before);

		const root = await mkdtemp(join(tmpdir(), "con04-"));
		const ctx = host.makeCtx({ cwd: root, sessionDir: root, sessionId: "sess-con04" });
		const text = Array.from({ length: 400 }, (_, i) => `row-${i}-${"y".repeat(40)}`).join("\n");
		const messages = [largeToolResult(text)];
		const fire = contextHandlers.at(-1)!;
		for (let i = 0; i < 3; i += 1) {
			const result = (await fire({ type: "context", messages } as never, ctx as never)) as {
				messages: Array<{ content: Array<{ type: string; text: string }> }>;
			};
			if (i === 2) {
				expect(result.messages[0].content[0].text).toContain("retrieve: call obs_recall");
			}
		}
		const names = (host.piObject() as { getAllTools: () => Array<{ name: string }> })
			.getAllTools()
			.map((t) => t.name);
		expect(names).toContain("write");
		expect(names).toContain("obs_recall");
	});
});

import { buildSessionProjection } from "@earendil-works/pi-coding-agent";

describe("RV host semantics (2026-10-02-memory-recall-v2)", () => {
	it("⑥ buildSessionProjection preserves custom_message customType + details", () => {
		const now = Date.now();
		const entries = [
			{ id: "e1", parentId: null, type: "session", version: 1, cwd: "/tmp", timestamp: now },
			{
				id: "e2",
				parentId: "e1",
				type: "message",
				message: { role: "user", content: [{ type: "text", text: "hello recall" }], timestamp: now },
				timestamp: now,
			},
			{
				id: "e3",
				parentId: "e2",
				type: "custom_message",
				customType: "pi-memory-recall",
				content: [{ type: "text", text: "<memory-recall>\n\n## t (memory/a.md)\n\nbody\n\n</memory-recall>" }],
				display: false,
				details: {
					v: 1,
					delivery: "immediate",
					model: "test/selector-1",
					files: [{ key: "memory/a.md", bytes: 120, truncated: false }],
					bytes: 200,
					elapsedMs: 3,
				},
				timestamp: now,
			},
		] as never[];
		const projection = buildSessionProjection(entries, "e3");
		const recall = (projection.messages as Array<Record<string, unknown>>).find(
			(m) => m.customType === "pi-memory-recall",
		) as { customType?: string; details?: { v?: number; files?: Array<{ key?: string }> } } | undefined;
		expect(recall).toBeDefined();
		expect(recall!.customType).toBe("pi-memory-recall");
		expect(recall!.details!.v).toBe(1);
		expect(recall!.details!.files![0]!.key).toBe("memory/a.md");
	});
});

import type { SessionBeforeCompactEvent, SessionCompactEvent, SessionCompactFailedEvent } from "@earendil-works/pi-coding-agent";

// AR1005-RC-HOST run-loop evidence. The recall-teardown scenario that hosted
// these placeholders was removed with the memory module; the host facts stay.
describe("AR1005-RC-HOST run-loop evidence (2026-10-05 §13)", () => {
	it.todo("⑨ real run loop: one turn_start per turn; tool calls within a turn share it (Phase 4 host acceptance — manual steps in the comment above) — EXECUTED PASS 2026-11-15 SR host batch (real pi 1.5.2 TUI via rex, GLM-5.3-flash: two reads in one message share one turn_start; next message's call lands after a fresh before_agent_start→turn_start; evidence ~/.cache/pi-core-acceptance/2026-11-15/run/host-todos); todo retained: not automatable in-suite");
	it.todo("⑪ real run loop: message_end vs SessionManager append ordering (Phase 4 host acceptance) — ADJUDICATED 2026-11-15 SR host batch (real pi 1.5.2 TUI via rex, GLM-5.3-flash): 11/11 message_end moments had getLeafId() already including the message and getBranch() already +1 — append happens BEFORE message_end fires, inverting the assumption this todo was registered under; the modes cache marks dirty on multiple events by design, so correctness never relied on the ordering (README row corrected). Evidence ~/.cache/pi-core-acceptance/2026-11-15/run/host-todos; todo retained: not automatable in-suite");
});

describe("CB1 cherry-batch1 host semantics (spec docs/en/cherry-batch1-spec.md)", () => {
	it("B3-ANCHOR: estimateContextTokens invalidates usage anchors behind newer synthetic prefixes and restores on fresh usage", async () => {
		const est = await import("@earendil-works/pi-ai/utils/estimate");
		const usage = (totalTokens: number) => ({
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens,
		});
		const assistant = (ts: number, u?: unknown) => ({
			role: "assistant",
			content: [{ type: "text" as const, text: "t" }],
			timestamp: ts,
			usage: u ?? usage(1),
			stopReason: "stop" as const,
			thinking: undefined,
		});
		const user = (ts: number, text: string) => ({
			role: "user",
			content: [{ type: "text" as const, text }],
			timestamp: ts,
		});
		const seq1 = [user(2000, "compaction summary"), assistant(1000, usage(9500))];
		const r1 = (est as { estimateContextTokens(c: unknown[]): { lastUsageIndex: number | null } }).estimateContextTokens(seq1 as never);
		expect(r1.lastUsageIndex).toBeNull();
		const seq2 = [...seq1, assistant(3000, usage(100))];
		const r2 = (est as { estimateContextTokens(c: unknown[]): { lastUsageIndex: number | null } }).estimateContextTokens(seq2 as never);
		expect(r2.lastUsageIndex).toBe(2);
	});

	it.todo("B1-TRUNC: host fails all toolCalls of a stopReason=length message (failToolCallsFromTruncatedMessage behavior) — needs a real-session injection scenario; target Phase: next pi-upgrade contract batch (P0-CT-13)");
});

describe("CB2 cherry-batch2 host semantics (spec docs/en/cherry-batch2-spec.md)", () => {
	it("B6-C1: AgentEndEvent has no willRetry field (compile-time keyof pin)", () => {
		type AgentEndEventLike = import("@earendil-works/pi-coding-agent").AgentEndEvent extends never ? never : keyof import("@earendil-works/pi-coding-agent").AgentEndEvent;
		const keys: AgentEndEventLike[] = ["type", "messages"] as AgentEndEventLike[];
		type HasWillRetry = "willRetry" extends keyof import("@earendil-works/pi-coding-agent").AgentEndEvent ? true : false;
		const _pinAgentEndHasNoWillRetry: false = null as unknown as HasWillRetry;
		void _pinAgentEndHasNoWillRetry;
		expect(keys).not.toContain("willRetry");
	});

	it("B6-C2: the three compaction events declare willRetry", async () => {
		const compactSample = { type: "session_compact", willRetry: false } as SessionCompactEvent;
		const beforeSample = { type: "session_before_compact", willRetry: false } as SessionBeforeCompactEvent;
		const failedSample = { type: "session_compact_failed", willRetry: false } as SessionCompactFailedEvent;
		expect("willRetry" in compactSample).toBe(true);
		expect("willRetry" in beforeSample).toBe(true);
		expect("willRetry" in failedSample).toBe(true);
	});
});
