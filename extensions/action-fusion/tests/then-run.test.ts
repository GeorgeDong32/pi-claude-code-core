import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, mock } from "node:test";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { type BashToolOptions, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	assertUnchangedBeforeCommand,
	executeMutationThenRun,
	THEN_RUN_DEFAULT_TIMEOUT_SECONDS,
	THEN_RUN_FAILED,
	THEN_RUN_SKIPPED,
	THEN_RUN_SUCCEEDED,
	type FileQueueFn,
} from "../then-run.ts";
import { createActionFusionExtension } from "../index.ts";
import { withFusedFileQueue } from "../file-queue.ts";
import { resolveToolPath } from "../tool-path.ts";

const passthroughQueue: FileQueueFn = (_path, work) => work();

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

/** The REAL timer, captured before any test enables mock.timers (watchdogs must not depend on mocked time). */
const realSetTimeout = setTimeout.bind(globalThis);

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
		assert.match(textOf(result), /\[then_run:failed\]/);
		assert.equal((result.details as unknown as { thenRun?: string }).thenRun, "succeeded");
		assert.equal(thenRunStatusRow(result, stubTheme), "↳ then_run ✓ ok");
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
		assert.equal(JSON.stringify(result), before);
	});
});

describe("then_run timeout hardening (BH-R5)", () => {
	const mutation: AgentToolResult<undefined> = { content: [{ type: "text", text: "wrote" }], details: undefined };

	it("exposes the default as the named constant THEN_RUN_DEFAULT_TIMEOUT_SECONDS (= 600, deliberately not configurable)", () => {
		assert.equal(THEN_RUN_DEFAULT_TIMEOUT_SECONDS, 600);
	});

	function recordingOps(seen: Array<{ command: string; timeout?: number }>): BashToolOptions {
		return {
			operations: {
				exec: async (command, _cwd, { timeout }) => {
					seen.push({ command, timeout });
					return { exitCode: 0 };
				},
			},
		};
	}

	it("applies the 600 s default timeout when then_run gives none, and an explicit timeout still wins", async () => {
		const dir = await mkdtemp(join(tmpdir(), "fus-r5-default-"));
		const file = join(dir, "target.txt");
		await writeFile(file, "content\n", "utf8");
		const seen: Array<{ command: string; timeout?: number }> = [];
		const ops = recordingOps(seen);
		await executeMutationThenRun({
			toolCallId: "r5-default",
			absolutePath: file,
			thenRun: { command: "echo done" },
			mutate: async () => mutation,
			bashOptions: ops,
			signal: undefined,
			ctx: fakeCtx(dir),
			queue: passthroughQueue,
		});
		assert.equal(seen.length, 1);
		assert.equal(seen[0].timeout, 600, "BH-R5: then_run without a timeout must carry the 600 s default");
		seen.length = 0;
		await executeMutationThenRun({
			toolCallId: "r5-explicit",
			absolutePath: file,
			thenRun: { command: "echo done", timeout: 42 },
			mutate: async () => mutation,
			bashOptions: ops,
			signal: undefined,
			ctx: fakeCtx(dir),
			queue: passthroughQueue,
		});
		assert.equal(seen[0].timeout, 42, "BH-R5: an explicit timeout must not be overridden");
	});

	it("terminates a hanging command at the 600 s default timeout, hints at background bash, and frees the file's queue", async () => {
		mock.timers.enable({ apis: ["setTimeout"] });
		try {
			const dir = await mkdtemp(join(tmpdir(), "fus-r5-hang-"));
			const file = join(dir, "target.txt");
			await writeFile(file, "content\n", "utf8");
			let execStarted = false;
			let escape!: (error: Error) => void;
			const hangOps: BashToolOptions = {
				operations: {
					exec: (_command, _cwd, { signal, timeout }) =>
						new Promise((_resolve, reject) => {
							execStarted = true;
							signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
							if (timeout !== undefined) setTimeout(() => reject(new Error(`timeout:${timeout}`)), timeout * 1000);
							escape = (error) => reject(error);
						}),
				},
			};
			const first = executeMutationThenRun({
				toolCallId: "r5-hang",
				absolutePath: file,
				thenRun: { command: "serve --forever" },
				mutate: async () => mutation,
				bashOptions: hangOps,
				signal: undefined,
				ctx: fakeCtx(dir),
				queue: withFusedFileQueue,
			});
			first.catch(() => {});
			// realpath resolves on the thread pool: wait until exec is actually pending.
			for (let i = 0; i < 10_000 && !execStarted; i += 1) await flush();
			assert.ok(execStarted, "the then_run command started");
			mock.timers.tick(600_000);
			await flush();
			const race = Promise.race([
				first.then(
					() => "completed" as const,
					(error) => error,
				),
				new Promise<"still-pending">((resolve) => realSetTimeout(() => resolve("still-pending"), 1000)),
			]);
			const settled = await race;
			if (settled === "still-pending") {
				escape(new Error("released by test"));
				assert.fail("BH-R5: the hanging then_run command must be terminated by the 600 s default timeout");
			}
			assert.ok(settled instanceof Error);
			assert.match(settled.message, /Command timed out after 600 seconds/);
			assert.ok(settled.message.includes(THEN_RUN_FAILED), "the failure keeps the THEN_RUN_FAILED token");
			assert.match(
				settled.message,
				/belong in a `background: true` bash call/,
				"the timeout error must point long-running commands at background bash",
			);
			const seen: Array<{ command: string; timeout?: number }> = [];
			const second = await executeMutationThenRun({
				toolCallId: "r5-next",
				absolutePath: file,
				thenRun: { command: "echo ok" },
				mutate: async () => mutation,
				bashOptions: recordingOps(seen),
				signal: undefined,
				ctx: fakeCtx(dir),
				queue: withFusedFileQueue,
			});
			assert.ok(textOf(second).includes(THEN_RUN_SUCCEEDED));
		} finally {
			mock.timers.reset();
		}
	});

	it("the registered descriptions no longer suggest start/restart, and the schema states the default timeout", async () => {
		const definitions: Array<Record<string, unknown>> = [];
		const pi = {
			registerTool: (definition: Record<string, unknown>) => {
				definitions.push(definition);
			},
			getAllTools: () => [] as never[],
			on: () => {},
			registerCommand: () => {},
		} as unknown as ExtensionAPI;
		createActionFusionExtension({})(pi);
		for (const name of ["write", "edit"] as const) {
			const tool = definitions.find((definition) => definition.name === name) as
				| { description: string; parameters: { properties: Record<string, { description?: string } & Record<string, unknown>> } }
				| undefined;
			assert.ok(tool, `${name} registered`);
			assert.doesNotMatch(
				tool.description,
				/start\/restart/,
				"BH-R5: long-running or server-like commands must not be steered into then_run",
			);
			const thenRun = tool.parameters.properties.then_run as
				| { description?: string; properties?: Record<string, { description?: string }> }
				| undefined;
			assert.ok(thenRun, "then_run stays in the schema");
			assert.doesNotMatch(thenRun.description ?? "", /start\/restart/);
			assert.match(thenRun.properties?.timeout?.description ?? "", /defaults to 600/, "BH-R5: the schema states the 600 s default");
		}
	});
});
