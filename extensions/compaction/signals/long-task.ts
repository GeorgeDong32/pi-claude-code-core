/*
 * Long-task boundary signals (SPEC SC §5.4 / Appendix C weights, task W8).
 *
 *   goal-step   — a goal lifecycle event entry ends a work block (90)
 *   git-commit  — an assistant turn containing a `git commit` call (60)
 *   verified    — a toolResult following a TEST command exited 0 (55)
 *
 * All three are pure over the projected entry view (CUT-07 isolation) and
 * never touch git or the disk.
 */

import type { BoundarySignal } from "./generic.ts";

const GOAL_EVENT_TYPES = new Set(["pi-goal-event", "cc-core-goal"]);

function contentBlocks(entry: { messages: Array<{ role?: string; content?: unknown }> }): Array<{ type?: string; text?: string; output?: string; name?: string; arguments?: unknown }> {
	const blocks: Array<{ type?: string; text?: string; output?: string; name?: string; arguments?: unknown }> = [];
	for (const message of entry.messages) {
		if (Array.isArray(message.content)) {
			for (const block of message.content as Array<{ type?: string; text?: string; output?: string; name?: string; arguments?: unknown }>) blocks.push(block);
		}
	}
	return blocks;
}

/** goal-step: boundary after a goal lifecycle custom entry. */
export const goalStepSignal: BoundarySignal = {
	name: "goal-step",
	weight: (ctx) => {
		const entry = ctx.entries[ctx.index];
		const customType = (entry.sourceEntry as { type?: string; customType?: string }).customType;
		if (customType && GOAL_EVENT_TYPES.has(customType)) return 1;
		// Goal events also surface as text markers in assistant messages.
		const text = contentBlocks(entry).map((b) => b.text ?? "").join(" ");
		return /\[goal[ :][^\]]*\]|goal achieved|goal completed/i.test(text) ? 1 : 0;
	},
};

/** git-commit: boundary after an assistant turn that ran `git commit`. */
export const gitCommitSignal: BoundarySignal = {
	name: "git-commit",
	weight: (ctx) => {
		const entry = ctx.entries[ctx.index];
		const first = entry.messages[0];
		if (!first || first.role !== "assistant") return 0;
		for (const block of contentBlocks(entry)) {
			if (block.type !== "toolCall" || block.name !== "bash") continue;
			const command = (block.arguments as { command?: unknown } | undefined)?.command;
			if (typeof command === "string" && /\bgit commit\b/.test(command)) return 1;
		}
		return 0;
	},
};

const TEST_COMMAND = /\b(pnpm run test|npm (run )?test|vitest|node --test|pytest|go test|cargo test|bun (run )?test)\b/;

/** verified: boundary after a toolResult whose preceding turn ran a passing
 * test command. The verdict text must show a zero exit / pass markers. */
export const verifiedSignal: BoundarySignal = {
	name: "verified",
	weight: (ctx) => {
		const entry = ctx.entries[ctx.index];
		const first = entry.messages[0];
		if (!first || first.role !== "toolResult") return 0;
		const text = contentBlocks(entry).map((b) => (typeof b.output === "string" ? b.output : b.text ?? "")).join("\n");
		if (!/exit code:\s*0|✓|\bpass(ed)?\b/i.test(text)) return 0;
		// The paired assistant turn (immediately before) ran the test.
		const previous = ctx.entries[ctx.index - 1];
		if (!previous) return 0;
		for (const block of contentBlocks(previous)) {
			if (block.type !== "toolCall" || block.name !== "bash") continue;
			const command = (block.arguments as { command?: unknown } | undefined)?.command;
			if (typeof command === "string" && TEST_COMMAND.test(command)) return 1;
		}
		return 0;
	},
};
