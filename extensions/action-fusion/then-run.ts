/*
 * Fused mutation + follow-up command execution.
 * Ported from NVlabs/SoL-Pi (MIT) @ src/sol-pi/extensions/action-fusion/then-run.ts
 * (SPEC FUS-04: error semantics kept exactly — skipped/failed THROW, success
 * APPENDS a text block to the mutation result and stamps the merged details
 * with thenRun: "succeeded" — the structured outcome callers count from,
 * B6; the protocol token text stays byte-identical for upstream compat).
 *
 * BH-R5 (2026-11-14, spec 2026-11-14-backtest-hardening): then_run now
 * carries a 600 s default timeout (THEN_RUN_DEFAULT_TIMEOUT_SECONDS — a
 * named constant, deliberately NOT configurable: no new env var or setting).
 * Without it a hanging command blocked the whole turn AND the per-file
 * fusion queue. A timed-out command's error text hints that long-running or
 * server-like commands belong in a background bash instead.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { type BashToolOptions, createBashToolDefinition, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { withFusedFileQueue } from "./file-queue.ts";

export const THEN_RUN_SUCCEEDED = "[then_run:succeeded]";
export const THEN_RUN_FAILED = "[then_run:failed]";
export const THEN_RUN_SKIPPED = "[then_run:skipped]";

export const THEN_RUN_DEFAULT_TIMEOUT_SECONDS = 600;

/** pi's bash surfaces a timeout as "Command timed out after N seconds" (its own `timeout:<seconds>` exec error, reformatted). */
const TIMED_OUT_PATTERN = /Command timed out after \d+(?:\.\d+)? seconds/u;

/** BH-R5: appended to a timeout failure — a hanging command must not be retried here, and servers do not belong in then_run. */
const TIMEOUT_HINT =
	"then_run is for short verification commands only: long-running or server-like commands belong in a `background: true` bash call (they would block this file's queue here).";

export interface ThenRunInput {
	command: string;
	timeout?: number;
}

export function createThenRunSchema(description: string) {
	return Type.Optional(
		Type.Object(
			{
				command: Type.String({ description: "Bash command to run" }),
				timeout: Type.Optional(
					Type.Number({ description: "Timeout in seconds (optional; defaults to 600). Long-running or server-like commands do not belong here — use a background bash call." }),
				),
			},
			{ description },
		),
	);
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function resultText(result: AgentToolResult<unknown>): string {
	return result.content
		.filter((block) => block.type === "text")
		.map((block) => (block as { text: string }).text)
		.join("\n");
}

function thenRunSkippedError(error: unknown): Error {
	return new Error(
		`${errorText(error)}\n\n${THEN_RUN_SKIPPED} The file mutation did not complete successfully; the command was not run.`,
	);
}

async function fileSha256(path: string): Promise<string> {
	return createHash("sha256").update(await readFile(path)).digest("hex");
}

export async function assertUnchangedBeforeCommand(
	path: string,
	yieldForInterference: () => Promise<void> = () => new Promise<void>((resolve) => setImmediate(resolve)),
): Promise<void> {
	try {
		const mutationHash = await fileSha256(path);
		await yieldForInterference();
		const commandHash = await fileSha256(path);
		if (mutationHash !== commandHash) {
			throw new Error("target content changed after the fused mutation");
		}
	} catch (error) {
		throw new Error(`${THEN_RUN_SKIPPED} ${errorText(error)}; the command was not run.`);
	}
}

/**
 * Queue seam (SPEC FUS-03): the official withFileMutationQueue when the host
 * exports it, otherwise the ported per-file promise chain. Both adapters
 * serialize per canonical path; the official one additionally shares ordering
 * with pi's built-in mutation tools.
 */
export type FileQueueFn = <T>(filePath: string, work: () => Promise<T>) => Promise<T>;

export async function executeMutationThenRun<TDetails>({
	toolCallId,
	absolutePath,
	thenRun,
	mutate,
	bashOptions,
	signal,
	ctx,
	queue,
	yieldForInterference,
}: {
	toolCallId: string;
	absolutePath: string;
	thenRun: ThenRunInput | undefined;
	mutate: () => Promise<AgentToolResult<TDetails>>;
	bashOptions: BashToolOptions | undefined;
	signal: AbortSignal | undefined;
	ctx: ExtensionContext;
	queue: FileQueueFn;
	yieldForInterference?: () => Promise<void>;
}): Promise<AgentToolResult<TDetails>> {
	return queue(absolutePath, async () => {
		let mutationResult: AgentToolResult<TDetails>;
		try {
			mutationResult = await mutate();
		} catch (error) {
			if (thenRun !== undefined) {
				throw thenRunSkippedError(error);
			}
			throw error;
		}

		if (thenRun === undefined) {
			return mutationResult;
		}

		await assertUnchangedBeforeCommand(absolutePath, yieldForInterference);
		const bash = createBashToolDefinition(ctx.cwd, bashOptions);
		try {
			const bashParams: ThenRunInput = { ...thenRun, timeout: thenRun.timeout ?? THEN_RUN_DEFAULT_TIMEOUT_SECONDS };
			// 0.99 types the execute ctx as ExtensionToolContext (superset with
			// tools/executeTool); runtime provides it. 0.87 accepts ExtensionContext.
			const bashResult = await bash.execute(`${toolCallId}:then_run`, bashParams, signal, undefined, ctx as Parameters<typeof bash.execute>[4]);
			const output = resultText(bashResult);
			// pi 0.99's bash RETURNS nonzero exits (isError + "Command exited
			// with code N") instead of throwing like 0.87 — treat both shapes as
			// THEN_RUN_FAILED so a failed command is never reported as succeeded.
			if ((bashResult as { isError?: boolean }).isError || /Command exited with code \d+/u.test(output)) {
				throw new Error(output || "then_run command failed");
			}
			const mergedDetails =
				mutationResult.details === undefined
					? { thenRun: "succeeded" }
					: { ...mutationResult.details, thenRun: "succeeded" };
			return {
				...mutationResult,
				content: [
					...mutationResult.content,
					{ type: "text", text: output ? `${THEN_RUN_SUCCEEDED}\n${output}` : THEN_RUN_SUCCEEDED },
				],
				details: mergedDetails as typeof mutationResult.details,
			};
		} catch (error) {
			const mutationOutput = resultText(mutationResult);
			const detail = errorText(error);
			const message = TIMED_OUT_PATTERN.test(detail) ? `${detail}\n\n${TIMEOUT_HINT}` : detail;
			throw new Error([mutationOutput, THEN_RUN_FAILED, message].filter(Boolean).join("\n\n"));
		}
	});
}
