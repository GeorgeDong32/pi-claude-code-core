/*
 * rex-flow boundary signal (SPEC SC §5.6 LED-05c / §5.4 CUT-04, task W7).
 *
 * run-closed: the boundary AFTER the first toolCall-free assistant message
 * that follows a run-done sentinel (or a board-done run) in the branch —
 * the natural "this run just wrapped up" cut point, highest class weight.
 */

import type { BoundarySignal } from "./generic.ts";

function isAssistantWithoutToolCall(entry: { messages?: readonly unknown[] }): boolean {
	const first = entry.messages?.[0] as { role?: string; content?: unknown } | undefined;
	if (!first || first.role !== "assistant") return false;
	const content = first.content as unknown;
	if (!Array.isArray(content)) return false;
	return !(content as Array<{ type?: string }>).some((block) => block?.type === "toolCall");
}

function textOf(entry: { messages?: readonly unknown[] }): string {
	const parts: string[] = [];
	for (const raw of entry.messages ?? []) {
		const message = raw as { content?: unknown };
		const content = message.content as unknown;
		if (typeof content === "string") parts.push(content);
		else if (Array.isArray(content)) {
			for (const block of content as Array<{ text?: string; output?: string }>) {
				if (typeof block.text === "string") parts.push(block.text);
				else if (typeof block.output === "string") parts.push(block.output);
			}
		}
	}
	return parts.join("\n");
}

export const runClosedSignal: BoundarySignal = {
	name: "run-closed",
	weight: (ctx) => {
		const entry = ctx.entries[ctx.index];
		if (!entry || !isAssistantWithoutToolCall(entry)) return 0;
		// Any run-done sentinel since the previous toolCall-free assistant?
		let cursor = ctx.index - 1;
		while (cursor >= 0) {
			const candidate = ctx.entries[cursor];
			if (isAssistantWithoutToolCall(candidate)) return 0; // earlier plain assistant already consumed the sentinel window
			if (/\brun-done\b|\brun_done\b/.test(textOf(candidate))) return 1;
			cursor -= 1;
		}
		return 0;
	},
};
