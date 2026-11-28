import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import protectedWritesExtension from "./protected-writes.ts";

type Handler = (event: any, ctx: ExtensionContext) => Promise<unknown> | unknown;

function setup() {
	const handlers = new Map<string, Handler[]>();
	const pi = {
		on(event: string, handler: Handler) {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
	} as unknown as ExtensionAPI;
	protectedWritesExtension(pi);
	const fire = (event: string, ctx: ExtensionContext, payload: Record<string, unknown> = {}) =>
		Promise.all((handlers.get(event) ?? []).map((h) => h({ type: event, ...payload }, ctx)));
	return { fire };
}

let home: string;
let prevHome: string | undefined;
let cwd: string;
const notices: Array<{ message: string; level: string }> = [];

beforeEach(() => {
	prevHome = process.env.HOME;
	home = mkdtempSync(join(tmpdir(), "c4-home-"));
	cwd = mkdtempSync(join(tmpdir(), "c4-cwd-"));
	process.env.HOME = home;
	mkdirSync(join(home, ".pi", "agent"), { recursive: true });
	notices.length = 0;
	// the warning reaches ctx.ui.notify only with a live cctui that does not consume the bus channel
	(globalThis as Record<string, unknown>).__piCcTui = { active: true, notificationsConsumer: false };
});
afterEach(() => {
	delete (globalThis as Record<string, unknown>).__piCcTui;
	if (prevHome === undefined) delete process.env.HOME;
	else process.env.HOME = prevHome;
	rmSync(home, { recursive: true, force: true });
	rmSync(cwd, { recursive: true, force: true });
});

describe("[C4] protected writes", () => {
	it("blocks write/edit onto permission-modes.json regardless of the mode flag", async () => {
		const { fire } = setup();
		const ctx = { cwd, hasUI: true, ui: { notify: (message: string, level: string) => notices.push({ message, level }) } } as unknown as ExtensionContext;
		const results = await fire("tool_call", ctx, { toolName: "write", toolCallId: "t1", input: { path: join(home, ".pi", "agent", "permission-modes.json"), content: "{}" } });
		expect(results.some((r) => (r as { block?: boolean } | undefined)?.block === true)).toBe(true);
		const ok = await fire("tool_call", ctx, { toolName: "write", toolCallId: "t2", input: { path: join(cwd, "notes.md"), content: "x" } });
		expect(ok.every((r) => r === undefined)).toBe(true);
	});

	it("warns once when a protected file changes between session_start and agent_end", async () => {
		const { fire } = setup();
		const file = join(home, ".pi", "agent", "settings.json");
		writeFileSync(file, "{}");
		const ctx = { cwd, hasUI: true, ui: { notify: (message: string, level: string) => notices.push({ message, level }) } } as unknown as ExtensionContext;
		await fire("session_start", ctx);
		writeFileSync(file, '{"theme":"dark"}');
		await fire("agent_end", ctx);
		expect(notices).toHaveLength(1);
		expect(notices[0].message).toMatch(/Protected files changed outside the tool guard/);
		expect(notices[0].message).toContain("settings.json");
		await fire("agent_end", ctx);
		expect(notices).toHaveLength(1);
	});

	it("stays silent when nothing changed, and a new session re-arms the detector", async () => {
		const { fire } = setup();
		writeFileSync(join(home, ".pi", "agent", "settings.json"), "{}");
		const ctx = { cwd, hasUI: true, ui: { notify: (message: string, level: string) => notices.push({ message, level }) } } as unknown as ExtensionContext;
		await fire("session_start", ctx);
		await fire("agent_end", ctx);
		expect(notices).toHaveLength(0);
		writeFileSync(join(home, ".pi", "agent", "settings.json"), '{"theme":"dark"}');
		await fire("session_start", ctx);
		await fire("agent_end", ctx);
		expect(notices).toHaveLength(0);
	});
});
