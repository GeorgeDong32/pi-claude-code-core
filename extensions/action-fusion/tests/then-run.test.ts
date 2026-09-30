/*
 * SPEC FUS-10: module tests at the executeMutationThenRun / file-queue
 * interface. Bash is exercised through a stubbed queue+mutation harness; the
 * error semantics (skipped/failed THROW, success APPENDS) are pinned to the
 * upstream token literals.
 */
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import {
	assertUnchangedBeforeCommand,
	executeMutationThenRun,
	THEN_RUN_FAILED,
	THEN_RUN_SKIPPED,
	THEN_RUN_SUCCEEDED,
	type FileQueueFn,
} from "../then-run.ts";
import { resolveToolPath, withFusedFileQueue } from "../file-queue.ts";

const passthroughQueue: FileQueueFn = (_path, work) => work();

/** Tolerant session stub: the real bash tool probes several session APIs. */
function fakeCtx(cwd = "/tmp"): never {
	const sessionManager = new Proxy(
		{ getSessionId: () => "fus-test-session", getSessionDir: () => "", getSessionFile: () => "" },
		{
			get(target, prop) {
				if (typeof prop === "string" && prop in target) return (target as Record<string, unknown>)[prop];
				return () => undefined;
			},
		},
	);
	return { cwd, hasUI: false, sessionManager } as never;
}

function textOf(result: AgentToolResult<unknown>): string {
	return result.content
		.filter((b) => b.type === "text")
		.map((b) => (b as { text: string }).text)
		.join("\n");
}

describe("executeMutationThenRun (FUS-04/10)", () => {
	it("passes through untouched when then_run is absent", async () => {
		const mutation: AgentToolResult<undefined> = { content: [{ type: "text", text: "wrote" }], details: undefined };
		const result = await executeMutationThenRun({
			toolCallId: "t1",
			absolutePath: "/tmp/none",
			thenRun: undefined,
			mutate: async () => mutation,
			bashOptions: undefined,
			signal: undefined,
			ctx: fakeCtx(),
			queue: passthroughQueue,
		});
		assert.equal(textOf(result), "wrote");
	});

	it("THROWS [then_run:skipped] and never runs the command when the mutation fails", async () => {
		let bashRan = false;
		await assert.rejects(
			() =>
				executeMutationThenRun({
					toolCallId: "t2",
					absolutePath: "/tmp/none",
					thenRun: { command: "echo no" },
					mutate: async () => {
						throw new Error("edit failed");
					},
					bashOptions: undefined,
					signal: undefined,
					ctx: fakeCtx(),
					queue: passthroughQueue,
				}),
			(err) => {
				// The mutation failure surfaces before the queue's bash stub would run.
				const message = (err as Error).message;
				return message.includes("edit failed") && message.includes(THEN_RUN_SKIPPED) && !bashRan;
			},
		);
	});

	it("APPENDS [then_run:succeeded] with the command output on success", async () => {
		const dir = await mkdtemp(join(tmpdir(), "fus-ok-"));
		const file = join(dir, "target.txt");
		await writeFile(file, "content\n", "utf8");
		const mutation: AgentToolResult<undefined> = { content: [{ type: "text", text: "wrote target.txt" }], details: undefined };
		const result = await executeMutationThenRun({
			toolCallId: "t3",
			absolutePath: file,
			thenRun: { command: `cat ${file}` },
			mutate: async () => mutation,
			bashOptions: undefined,
			signal: undefined,
			ctx: fakeCtx(dir),
			queue: passthroughQueue,
		});
		assert.ok(textOf(result).startsWith("wrote target.txt"));
		assert.ok(textOf(result).includes(THEN_RUN_SUCCEEDED));
		assert.ok(textOf(result).includes("content"));
	});

	it("THROWS [then_run:failed] carrying the mutation output when the command fails", async () => {
		const dir = await mkdtemp(join(tmpdir(), "fus-fail-"));
		const file = join(dir, "target.txt");
		await writeFile(file, "content\n", "utf8");
		const mutation: AgentToolResult<undefined> = { content: [{ type: "text", text: "wrote target.txt" }], details: undefined };
		await assert.rejects(
			() =>
				executeMutationThenRun({
					toolCallId: "t4",
					absolutePath: file,
					thenRun: { command: "definitely-not-a-command-xyz" },
					mutate: async () => mutation,
					bashOptions: undefined,
					signal: undefined,
					ctx: fakeCtx(),
					queue: passthroughQueue,
				}),
			(err) => {
				const message = (err as Error).message;
				return message.includes("wrote target.txt") && message.includes(THEN_RUN_FAILED);
			},
		);
	});

	it("THROWS skipped when the target changes between mutation and command", async () => {
		const dir = await mkdtemp(join(tmpdir(), "fus-race-"));
		const file = join(dir, "target.txt");
		await writeFile(file, "before\n", "utf8");
		await assert.rejects(
			() =>
				executeMutationThenRun({
					toolCallId: "t5",
					absolutePath: file,
					thenRun: { command: "true" },
					mutate: async () => ({ content: [{ type: "text", text: "wrote" }], details: undefined }),
					bashOptions: undefined,
					signal: undefined,
					ctx: fakeCtx(),
					queue: passthroughQueue,
					// Deterministic seam: the interference lands exactly between the
					// two hash reads (the old setImmediate timing flaked 1-in-6).
					yieldForInterference: async () => {
						await writeFile(file, "interfered\n", "utf8");
					},
				}),
			(err) => (err as Error).message.includes(THEN_RUN_SKIPPED),
		);
	});
});

describe("assertUnchangedBeforeCommand (FUS-04)", () => {
	it("passes when the hash is stable across the yield", async () => {
		const dir = await mkdtemp(join(tmpdir(), "fus-hash-"));
		const file = join(dir, "stable.txt");
		await writeFile(file, "same\n", "utf8");
		await assertUnchangedBeforeCommand(file);
	});
});

describe("fallback file queue (FUS-03 adapter #2)", () => {
	it("serializes concurrent work on one canonical path", async () => {
		const order: number[] = [];
		const first = withFusedFileQueue("/tmp/fus-serial-a", async () => {
			await new Promise((r) => setTimeout(r, 25));
			order.push(1);
		});
		const second = withFusedFileQueue("/tmp/fus-serial-a", async () => {
			order.push(2);
		});
		await Promise.all([first, second]);
		assert.deepEqual(order, [1, 2]);
	});

	it("resolveToolPath collapses unicode spaces, @-prefix and ~", () => {
		assert.equal(resolveToolPath("/wd", "a\u00A0b.txt"), "/wd/a b.txt");
		assert.equal(resolveToolPath("/wd", "@/abs/p.txt"), "/abs/p.txt");
		assert.ok(resolveToolPath("/wd", "~/x.txt").length > 0);
	});
});
