/**
 * B6 (arch): the fused-call counter — registration-level pin. A real write
 * via the registered fused tool with a then_run command must publish
 * fusedCount on the capability bus; the count comes from the structured
 * details.thenRun field (no protocol-token sniffing). Flat node:test.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { coreBus, resetCoreBusForTests } from "../../bus.ts";
import createActionFusion from "../index.ts";

/** Tolerant session stub (then-run.test.ts pattern). */
function fakeCtx(cwd: string): never {
	const sessionManager = new Proxy(
		{ getSessionId: () => "fus-count-session", getSessionDir: () => "", getSessionFile: () => "" },
		{
			get(target, prop) {
				if (typeof prop === "string" && prop in target) return (target as Record<string, unknown>)[prop];
				return () => undefined;
			},
		},
	);
	return { cwd, hasUI: false, sessionManager } as never;
}

test("a fused write with a succeeding then_run publishes fusedCount on the bus", async () => {
	resetCoreBusForTests();
	const dir = await mkdtemp(join(tmpdir(), "fus-count-"));
	const file = join(dir, "counter.txt");
	await writeFile(file, "old\n", "utf8");

	const definitions: Array<Record<string, unknown>> = [];
	const pi = {
		registerTool: (definition: Record<string, unknown>) => {
			definitions.push(definition);
		},
		getAllTools: () => [] as never[],
		on: () => {},
		registerCommand: () => {},
	} as unknown as ExtensionAPI;

	createActionFusion({ bashOptions: {} as never })(pi);
	const write = definitions.find((d) => d.name === "write") as unknown as {
		execute: (id: string, input: Record<string, unknown>, signal: undefined, onUpdate: undefined, ctx: never) => Promise<{ content: Array<{ type: string; text?: string }>; details?: unknown }>;
	};
	assert.ok(write, "fused write tool registered");
	assert.ok("then_run" in ((write as unknown as { parameters: { properties: Record<string, unknown> } }).parameters.properties), "schema carries then_run");

	const result = await write.execute(
		"tc-count",
		{ path: file, content: "new content\n", then_run: { command: `cat ${file}` } },
		undefined,
		undefined,
		fakeCtx(dir),
	);
	// FUS-04 token still model-facing…
	assert.ok(result.content.some((b) => b.type === "text" && (b.text ?? "").includes("[then_run:succeeded]")));
	// …and the structured outcome is on the details
	assert.equal((result.details as { thenRun?: string } | undefined)?.thenRun, "succeeded");
	// the counter published through the real bus
	assert.equal(coreBus()?.snapshot().fusion?.fusedCount, 1);
	resetCoreBusForTests();
});

test("a plain write without then_run does not count", async () => {
	resetCoreBusForTests();
	const dir = await mkdtemp(join(tmpdir(), "fus-plain-"));
	const file = join(dir, "plain.txt");

	const definitions: Array<Record<string, unknown>> = [];
	const pi = {
		registerTool: (definition: Record<string, unknown>) => {
			definitions.push(definition);
		},
		getAllTools: () => [] as never[],
		on: () => {},
		registerCommand: () => {},
	} as unknown as ExtensionAPI;

	createActionFusion({ bashOptions: {} as never })(pi);
	const write = definitions.find((d) => d.name === "write") as unknown as {
		execute: (id: string, input: Record<string, unknown>, signal: undefined, onUpdate: undefined, ctx: never) => Promise<{ content: Array<{ type: string; text?: string }> }>;
	};
	assert.ok(write, "fused write tool registered");
	await write.execute("tc-plain", { path: file, content: "plain\n" }, undefined, undefined, fakeCtx(dir));
	assert.equal(coreBus()?.snapshot().fusion, undefined, "no fusion patch published");
	resetCoreBusForTests();
});
