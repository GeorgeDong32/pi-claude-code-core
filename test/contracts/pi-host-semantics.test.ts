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

/*
 * ⑥ (附记 A.1 ①, spec 2026-10-02-memory-recall-v2): RV-06 dedup + /memory
 * diagnostics derive recall state from ctx.sessionManager.buildSessionProjection()
 * reading details.files[].key / details.bytes. If a pi upgrade ever strips or
 * reshapes `details` on custom messages in the projection, recall silently
 * degrades to duplicate injections with no error anywhere — this pin turns
 * that red at the contract gate instead. Asserted against the REAL installed
 * pi package export.
 */
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

// ── AR1005-RC-HOST (spec 2026-10-05 §13/§4): session teardown must cancel
// old recall work and absorb late failures. Runs the REAL memory extension
// inside a REAL ExtensionRunner in an ISOLATED subprocess (the unhandled
// rejection probe must not install a process-wide net into the shared test
// process). The scenario pins the exact defect reproduced at baseline
// 76e933a: a late selector completion after invalidate() read the stale
// ctx inside a void'd promise chain → unhandledRejection. ──
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

describe("AR1005-RC-HOST recall teardown (2026-10-05-core-architecture-reliability)", () => {
	it("⑦ invalidate + session_shutdown drop the late abort-ignoring selection: zero sends, zero unhandled rejections", () => {
		const scenario = fileURLToPath(new URL("./rc-host-scenario.ts", import.meta.url));
		// The scenario imports core's TypeScript sources — run it under bun (the
		// repo runtime); node's strip-only mode rejects parameter properties.
		const result = spawnSync("bun", [scenario], {
			encoding: "utf8",
			timeout: 60_000,
			env: { ...process.env, PI_CONTRACT_RC_HOST: "1" },
		});
		const out = `${result.stdout ?? ""}${result.stderr ?? ""}`;
		if (result.status !== 0) {
			throw new Error(`scenario exited ${result.status}:\n${out.slice(0, 3000)}`);
		}
		expect(out).toContain("SCENARIO_SELECTOR_CALLS:1");
		expect(out).toContain("SCENARIO_SENT:0"); // the late result delivered nothing
		expect(out).not.toContain("SCENARIO_UNHANDLED"); // and crashed nothing
		expect(out).toContain("SCENARIO_DONE");
	});
});

// ── AR1005-FU-HOST (spec 2026-10-05 §13): the renderer render facts the
// action-fusion UI adapter depends on. Type-level pin against the REAL
// installed package — if a pi upgrade drops/renames either field this file
// stops compiling at the contracts gate (bun run check) before anything
// else; the runtime fallbacks for missing fields are covered by the
// structurally-missing stand-ins in test/lib/tool-renderers.test.ts. ──
// Deep-path import via relative resolution (node enforces the package "exports"
// map for bare deep specifiers; these types are not re-exported at the root).
import type { ToolRenderContext, ToolRenderResultOptions } from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.js";

describe("AR1005-FU-HOST renderer render facts (2026-10-05-core-architecture-reliability)", () => {
	it("⑧ ToolRenderResultOptions.isPartial + ToolRenderContext.args/isError exist and are populated", () => {
		const options: ToolRenderResultOptions = { expanded: true, isPartial: false };
		const context: Pick<ToolRenderContext, "args" | "isError" | "isPartial"> = {
			args: { then_run: { command: "bun run check" } },
			isError: false,
			isPartial: false,
		};
		expect(options.isPartial).toBe(false);
		expect((context.args as { then_run?: { command?: string } }).then_run?.command).toBe("bun run check");
		expect(context.isError).toBe(false);
	});
});

// ── AR1005-RU-HOST (spec 2026-10-05 §13): the turn lifecycle the rules
// activation budget depends on — turn_start fires once per turn and every
// tool call within a turn shares it. The fact is a property of pi's real
// run loop (agent-session fires turn_start at turn boundaries); it cannot
// be exercised automatically without a full model-driven run, so per spec
// §13.2 this is a registered todo with the Phase 4 host-acceptance target.
// Manual verification steps (executed and recorded at Phase 4):
//   1. start a real pi session in a throwaway project with a rule file
//      carrying `globs: ["src/**/*.ts"]`;
//   2. send one user message that triggers TWO read/edit tool calls on
//      matching paths — both activations must land in the SAME turn
//      (pi's pending-steer queue flushes them together at turn_end);
//   3. send a second user message triggering another matching call —
//      exactly one turn_start must have separated the two batches.
describe("AR1005-RU-HOST turn lifecycle (2026-10-05-core-architecture-reliability)", () => {
	it.todo("⑨ real run loop: one turn_start per turn; tool calls within a turn share it (Phase 4 host acceptance — manual steps in the comment above)");
});

// ── AR1005-ST-HOST (spec 2026-10-05 §13): the host facts the modes
// working-stats cache depends on. The leaf-identity half is pinned against
// the REAL SessionManager below (an appended committed entry moves
// getLeafId and appears in getBranch — that is what invalidates the cache
// key). The message_end-before-append ordering is a run-loop property that
// cannot be driven without a model — registered todo with the Phase 4
// target and manual steps (spec §13.2); defensively, the modes wiring ALSO
// marks the snapshot dirty on message_end, so the cache never relies on
// the ordering alone. ──
import { SessionManager as RealSessionManager } from "@earendil-works/pi-coding-agent";
import { mkdtempSync, rmSync } from "node:fs";

describe("AR1005-ST-HOST branch identity (2026-10-05-core-architecture-reliability)", () => {
	it("⑩ a real SessionManager: appending a committed entry moves getLeafId and lands in getBranch (the cache key's invalidation signal)", () => {
		const dir = mkdtempSync(join(tmpdir(), "st-host-"));
		try {
			const root = { id: "root", parentId: null, type: "session", timestamp: Date.now() };
			const first = { id: "m1", parentId: "root", type: "message", message: { role: "user", content: [{ type: "text", text: "hi" }] }, timestamp: Date.now() };
			const sm = RealSessionManager.inMemory(dir, undefined, [root, first] as never);
			const leafBefore = sm.getLeafId();
			const branchBefore = sm.getBranch().length;
			sm.appendMessage({ role: "assistant", content: [{ type: "text", text: "ok" }] } as never);
			expect(sm.getLeafId()).not.toBe(leafBefore); // the key moved
			expect(sm.getBranch().length).toBe(branchBefore + 1); // and the branch grew
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it.todo("⑪ real run loop: message_end fires before SessionManager append (Phase 4 host acceptance — manual: breakpoint/log both in a live session; the modes cache also marks dirty on message_end, so correctness never relies on the ordering alone)");
});
