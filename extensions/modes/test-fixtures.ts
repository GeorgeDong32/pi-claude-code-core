import type { BranchEntry } from "./session-branch.ts"

export function msg(
	role: "user" | "assistant" | "toolResult",
	content: unknown,
	extra: Record<string, unknown> = {},
): BranchEntry {
	return { type: "message", id: `e-${role}`, message: { role, content, ...extra } }
}

export function assistantToolCallMsg(
	toolName: string,
	args: Record<string, unknown>,
): BranchEntry {
	return {
		type: "message",
		id: "e-assistant",
		message: {
			role: "assistant",
			content: [{ type: "toolCall", name: toolName, arguments: args }],
			usage: {
				input: 10,
				output: 5,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { total: 0.01 },
			},
		},
	}
}

export function toolResultMsg(
	toolName: string,
	toolCallId: string,
	text: string,
): BranchEntry {
	return msg("toolResult", [{ type: "text", text }], { toolName, toolCallId })
}

export function customMsg(customType: string, data: unknown): BranchEntry {
	return { type: "custom", customType, data }
}
