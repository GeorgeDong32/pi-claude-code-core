/*
 * Ledger verification + file-activity scans (SPEC SC §5.6 LED-04, task W6).
 *
 * Session-scanning providers (deterministic, synchronous, no process
 * spawns): the last TEST command and its outcome, the last `git commit`
 * subject/hash, and the file-activity lists — all from the compressed
 * region's model-visible messages (context edits applied).
 */

import type { CompressedRegionView, FileActivity, VerificationData } from "./types.ts";

/** Test-command regexes (Appendix C; configurable at the W8 signal level). */
const DEFAULT_TEST_COMMAND = /\b(pnpm run test|npm (run )?test|vitest|node --test|pytest|go test|cargo test|bun (run )?test)\b/;

function textBlocks(content: unknown): string[] {
	if (typeof content === "string") return [content];
	if (!Array.isArray(content)) return [];
	return (content as Array<{ type?: string; text?: string; output?: string }>)
		.filter((block) => typeof block === "object" && block !== null)
		.map((block) => {
			if (typeof block.text === "string") return block.text;
			if (typeof block.output === "string") return block.output; // toolResult blocks carry `output`
			return "";
		})
		.filter((text) => text.length > 0);
}

/** LED-04: last test command + verdict; last commit subject. */
export function scanVerification(region: CompressedRegionView): VerificationData {
	let lastTest: VerificationData["lastTest"];
	let lastCommit: VerificationData["lastCommit"];
	for (const { messages } of region.entries) {
		for (const message of messages) {
			if (message.role === "assistant") {
				const content = (message as { content?: unknown }).content;
				if (!Array.isArray(content)) continue;
				for (const block of content as Array<{ type?: string; name?: string; arguments?: { command?: unknown } }>) {
					if (block?.type !== "toolCall" || block.name !== "bash") continue;
					const command = typeof block.arguments?.command === "string" ? block.arguments.command : "";
					if (DEFAULT_TEST_COMMAND.test(command)) {
						// Verdict comes from the following toolResult (paired below).
						lastTest = { command: command.trim().slice(0, 80), result: "unknown" };
					}
					if (/\bgit commit\b/.test(command)) {
						const subject = /-m\s+"([^"]{0,60})"/.exec(command)?.[1] ?? command.trim().slice(0, 60);
						lastCommit = { hash: "(see session)", subject };
					}
				}
			}
			if (message.role === "toolResult" && lastTest && lastTest.result === "unknown") {
				const text = textBlocks((message as { content?: unknown }).content).join(" ");
				if (/exit code:\s*0|✓|pass|passed|tests?\s+\d+\s+pass/i.test(text)) lastTest.result = "pass";
				else if (/exit code:\s*[1-9]|✗|fail|failed/i.test(text)) lastTest.result = "fail";
			}
		}
	}
	const out: VerificationData = {};
	if (lastTest) out.lastTest = lastTest;
	if (lastCommit) out.lastCommit = lastCommit;
	return out;
}

/** File activity from toolCalls (read/write/edit + nested calls), capped. */
export function scanFileActivity(region: CompressedRegionView, cap = 12): FileActivity {
	const read = new Set<string>();
	const modified = new Set<string>();
	const addOp = (name: unknown, args: unknown) => {
		const path = (args as { path?: unknown } | undefined)?.path;
		if (typeof path !== "string") return;
		if (name === "read") read.add(path);
		else if (name === "write" || name === "edit") modified.add(path);
	};
	for (const { messages } of region.entries) {
		for (const message of messages) {
			const record = message as {
				role?: string;
				content?: unknown;
				nestedCalls?: { calls?: Array<{ name?: unknown; arguments?: unknown }> };
			};
			if (record.role === "toolResult") {
				for (const call of record.nestedCalls?.calls ?? []) addOp(call.name, call.arguments);
			} else if (record.role === "assistant" && Array.isArray(record.content)) {
				for (const block of record.content as Array<{ type?: string; name?: unknown; arguments?: unknown }>) {
					if (block?.type === "toolCall") addOp(block.name, block.arguments);
				}
			}
		}
	}
	return {
		readFiles: [...read].slice(0, cap),
		modifiedFiles: [...modified].slice(0, cap),
	};
}
