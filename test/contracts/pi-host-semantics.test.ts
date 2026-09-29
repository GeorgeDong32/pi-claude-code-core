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
import { FakeHost } from "./fake-host.ts";

describe("pi host semantics the economy modules depend on (CON-01)", () => {
	it("① a context handler's rewritten messages become the projection result", async () => {
		const host = new FakeHost();
		const ctx = host.makeCtx({ cwd: "/tmp" });
		const rewritten = [{ role: "user", content: [{ type: "text", text: "projected" }] }] as never;
		host.piObject().on("context", () => ({ messages: rewritten }));
		const handlers = host.handlers.get("context")!;
		const result = (await handlers[0]!(
			{ type: "context", messages: [] } as never,
			ctx as never,
		)) as { messages: unknown };
		expect(result.messages).toBe(rewritten);
	});

	it("② load-time registerTool with the same name overrides getAllTools parameters", () => {
		const host = new FakeHost();
		host.toolInfos.push({ name: "write", sourceInfo: { source: "builtin" } });
		host.piObject().registerTool({
			name: "write",
			parameters: { type: "object", properties: { path: {}, content: {}, then_run: {} } },
			execute: async () => ({}) as never,
		});
		const write = host.piObject().getAllTools().find((t: { name: string }) => t.name === "write") as {
			parameters?: { properties?: Record<string, unknown> };
		};
		expect(Object.keys(write.parameters?.properties ?? {})).toContain("then_run");
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
