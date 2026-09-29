/*
 * Host-semantics contract tests (SPEC CON-01).
 *
 * Positioning (per spec review): ①② pin CORE registration behaviour on the
 * extended fake host; the real pi 0.87 host semantics (load-time snapshot,
 * projection adoption) are additionally proven by the TST-04 sandbox run
 * recorded in the spec appendix. ③④ assert directly against the real
 * installed pi package, so a pi upgrade that drops/renames either export
 * turns this file red before anything else.
 */
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
		// Serializes per canonical path: second work starts after first settles.
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

/*
 * CON-03: per-message fail-open through the real module factory on the
 * extended fake host (SPEC OBS-08). A broken store keeps every candidate's
 * original bytes in the projection; a healthy store replaces them from the
 * request after FULL_SENDS.
 */
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
		// OBS-03 topology: <sessionDir>/observation-pack/<sessionId>/objects.
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
		// obs_recall got registered alongside.
		const names = (host.piObject() as { getAllTools: () => Array<{ name: string }> }).getAllTools().map((t) => t.name);
		expect(names).toContain("obs_recall");
	});
});

/*
 * CON-04: assembly-order contract — observation-pack must own the FINAL
 * context handler slot (after modes/memory). Pinned through the real
 * assembly default export on the extended fake host.
 */
import coreExtension from "../../extensions/index.ts";

describe("assembly order (CON-04)", () => {
	it("observation-pack owns the FINAL context handler slot after modes and memory", async () => {
		const host = new FakeHost();
		// Snapshot the chain BEFORE the assembly to know how many handlers
		// earlier modules contributed.
		(host.piObject() as { on: (e: string, h: Handler) => () => void }).on("context", () => undefined);
		const before = (host.handlers.get("context")! as Handler[]).length;
		await coreExtension(host.piObject() as never);
		const contextHandlers = host.handlers.get("context")! as Handler[];
		expect(contextHandlers.length).toBeGreaterThan(before);

		// The LAST handler is observation-pack's: firing it alone replaces a
		// large tool result past FULL_SENDS — the projection-owner behaviour
		// ASM-01 exists to guarantee.
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
