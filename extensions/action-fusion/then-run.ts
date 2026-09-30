/*
 * Fused mutation + follow-up command execution.
 * Ported from NVlabs/SoL-Pi (MIT) @ src/sol-pi/extensions/action-fusion/then-run.ts
 * (SPEC FUS-04: error semantics kept exactly — skipped/failed THROW, success
 * APPENDS a text block to the mutation result).
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

export interface ThenRunInput {
	command: string;
	timeout?: number;
}

export function createThenRunSchema(description: string) {
	return Type.Optional(
		Type.Object(
			{
				command: Type.String({ description: "Bash command to run" }),
				timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (optional, no default timeout)" })),
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

/**
 * Apply a file mutation and, when the model asked for one, run its follow-up
 * command before returning a single observation.
 */
export async function executeMutationThenRun<TDetails>({
	toolCallId,
	absolutePath,
	thenRun,
	mutate,
	bashOptions,
	signal,
	ctx,
	queue,
}: {
	toolCallId: string;
	absolutePath: string;
	thenRun: ThenRunInput | undefined;
	mutate: () => Promise<AgentToolResult<TDetails>>;
	bashOptions: BashToolOptions | undefined;
	signal: AbortSignal | undefined;
	ctx: ExtensionContext;
	queue: FileQueueFn;
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

		await assertUnchangedBeforeCommand(absolutePath);
		const bash = createBashToolDefinition(ctx.cwd, bashOptions);
		try {
			// 0.99 types the execute ctx as ExtensionToolContext (superset with
			// tools/executeTool); runtime provides it. 0.87 accepts ExtensionContext.
			const bashResult = await bash.execute(`${toolCallId}:then_run`, thenRun, signal, undefined, ctx as Parameters<typeof bash.execute>[4]);
			const output = resultText(bashResult);
			// pi 0.99's bash RETURNS nonzero exits (isError + "Command exited
			// with code N") instead of throwing like 0.87 — treat both shapes as
			// THEN_RUN_FAILED so a failed command is never reported as succeeded.
			if ((bashResult as { isError?: boolean }).isError || /Command exited with code \d+/u.test(output)) {
				throw new Error(output || "then_run command failed");
			}
			return {
				...mutationResult,
				content: [
					...mutationResult.content,
					{ type: "text", text: output ? `${THEN_RUN_SUCCEEDED}\n${output}` : THEN_RUN_SUCCEEDED },
				],
			};
		} catch (error) {
			const mutationOutput = resultText(mutationResult);
			throw new Error([mutationOutput, THEN_RUN_FAILED, errorText(error)].filter(Boolean).join("\n\n"));
		}
	});
}
