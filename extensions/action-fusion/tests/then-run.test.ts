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
import { withFusedFileQueue } from "../file-queue.ts";
import { resolveToolPath } from "../tool-path.ts";

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
		// B6: structured outcome on the merged details — the token stays
		// model-facing, the field is for callers.
		assert.equal((result.details as { thenRun?: string } | undefined)?.thenRun, "succeeded");
	});

	it("stamps thenRun onto EXISTING mutation details without clobbering them (B6)", async () => {
		const dir = await mkdtemp(join(tmpdir(), "fus-det-"));
		const file = join(dir, "target.txt");
		await writeFile(file, "content\n", "utf8");
		const mutation: AgentToolResult<{ changedFiles: string[] }> = {
			content: [{ type: "text", text: "wrote target.txt" }],
			details: { changedFiles: ["target.txt"] },
		};
		const result = await executeMutationThenRun({
			toolCallId: "t3b",
			absolutePath: file,
			thenRun: { command: `cat ${file}` },
			mutate: async () => mutation,
			bashOptions: undefined,
			signal: undefined,
			ctx: fakeCtx(dir),
			queue: passthroughQueue,
		});
		const details = result.details as { changedFiles?: string[]; thenRun?: string };
		assert.deepEqual(details.changedFiles, ["target.txt"]);
		assert.equal(details.thenRun, "succeeded");
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

// ── AR1005-FU (spec 2026-10-05 §6): the display interpretation of REAL
// executeMutationThenRun results — structured outcome first, opposite
// markers in log bodies cannot flip it, production succeeded actually
// badges, partial shows no terminal state. Baseline red via stash. ──
import { thenRunStatusRow } from "../renderers.ts";
import { interpretThenRunResult } from "../outcome.ts";

const stubTheme = { fg: (_role: string, text: string) => text } as never;

describe("AR1005-FU display interpretation over real results", () => {
	it("FU-T01: a real successful fused run shows the success badge (production [then_run:succeeded])", async () => {
		const dir = await mkdtemp(join(tmpdir(), "fu-t01-"));
		const file = join(dir, "target.txt");
		await writeFile(file, "content\n", "utf8");
		const result = await executeMutationThenRun({
			toolCallId: "fu1",
			absolutePath: file,
			thenRun: { command: `cat ${file}` },
			mutate: async () => ({ content: [{ type: "text", text: "wrote" }], details: undefined }),
			bashOptions: undefined,
			signal: undefined,
			ctx: fakeCtx(dir),
			queue: passthroughQueue,
		});
		assert.equal(interpretThenRunResult(result), "succeeded");
		assert.equal(thenRunStatusRow(result, stubTheme), "↳ then_run ✓ ok");
	});

	it("FU-T02: a success whose command output contains the failed marker still shows success (structure wins)", async () => {
		const dir = await mkdtemp(join(tmpdir(), "fu-t02-"));
		const file = join(dir, "log.txt");
		await writeFile(file, "old\n", "utf8");
		// the command's own output carries the failed marker as a standalone line
		const result = await executeMutationThenRun({
			toolCallId: "fu2",
			absolutePath: file,
			thenRun: { command: `printf 'build step echoed:\\n[then_run:failed]\\n'` },
			mutate: async () => ({ content: [{ type: "text", text: "wrote" }], details: undefined }),
			bashOptions: undefined,
			signal: undefined,
			ctx: fakeCtx(dir),
			queue: passthroughQueue,
		});
		assert.match(textOf(result), /\[then_run:failed\]/); // the marker really is in the body
		assert.equal((result.details as unknown as { thenRun?: string }).thenRun, "succeeded");
		assert.equal(thenRunStatusRow(result, stubTheme), "↳ then_run ✓ ok"); // structure is the authority
	});

	it("FU-T03: real failed and skipped results render their rows", async () => {
		const dir = await mkdtemp(join(tmpdir(), "fu-t03-"));
		const file = join(dir, "target.txt");
		await writeFile(file, "content\n", "utf8");
		const failedText = await executeMutationThenRun({
			toolCallId: "fu3a",
			absolutePath: file,
			thenRun: { command: "definitely-not-a-command-xyz" },
			mutate: async () => ({ content: [{ type: "text", text: "wrote" }], details: undefined }),
			bashOptions: undefined,
			signal: undefined,
			ctx: fakeCtx(dir),
			queue: passthroughQueue,
		}).then(
			() => null,
			(err: Error) => err.message,
		);
		assert.ok(failedText?.includes(THEN_RUN_FAILED));
		assert.equal(thenRunStatusRow({ content: [{ type: "text", text: failedText! }] }, stubTheme), "↳ then_run ✗ failed");
		const skippedText = "edit failed\n\n" + THEN_RUN_SKIPPED + " The file mutation did not complete successfully; the command was not run.";
		assert.equal(thenRunStatusRow({ content: [{ type: "text", text: skippedText }] }, stubTheme), "↳ then_run ⊘ skipped");
	});

	it("FU-T05: a partial stream never shows a terminal state", async () => {
		const dir = await mkdtemp(join(tmpdir(), "fu-t05-"));
		const file = join(dir, "target.txt");
		await writeFile(file, "content\n", "utf8");
		const result = await executeMutationThenRun({
			toolCallId: "fu5",
			absolutePath: file,
			thenRun: { command: `cat ${file}` },
			mutate: async () => ({ content: [{ type: "text", text: "wrote" }], details: undefined }),
			bashOptions: undefined,
			signal: undefined,
			ctx: fakeCtx(dir),
			queue: passthroughQueue,
		});
		assert.equal(thenRunStatusRow(result, stubTheme, { args: { then_run: { command: "cat" } }, isPartial: true }), null);
	});

	it("FU-T07 (interp purity): interpretation never rewrites content or details", async () => {
		const dir = await mkdtemp(join(tmpdir(), "fu-t07-"));
		const file = join(dir, "target.txt");
		await writeFile(file, "content\n", "utf8");
		const result = await executeMutationThenRun({
			toolCallId: "fu7",
			absolutePath: file,
			thenRun: { command: `cat ${file}` },
			mutate: async () => ({ content: [{ type: "text", text: "wrote" }], details: undefined }),
			bashOptions: undefined,
			signal: undefined,
			ctx: fakeCtx(dir),
			queue: passthroughQueue,
		});
		const before = JSON.stringify(result);
		assert.equal(interpretThenRunResult(result), "succeeded");
		assert.equal(JSON.stringify(result), before); // read-only interpretation
	});
});
