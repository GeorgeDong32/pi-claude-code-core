const COMMAND_FIELDS = ["then_run", "run", "command", "cmd"] as const;

export interface EmbeddedCommandInput {
	field: string
	command: string
}

const PRIMARY_SHELL_TOOLS = new Set(["bash", "powershell"])

function isCommandFieldExcluded(toolName: string, field: string): boolean {
	return field === "command" && PRIMARY_SHELL_TOOLS.has(toolName)
}

export function extractEmbeddedCommandInputs(
	toolName: string,
	input: Record<string, unknown> | null | undefined,
): EmbeddedCommandInput[] {
	if (!input || typeof input !== "object") return []
	const found: EmbeddedCommandInput[] = []
	for (const field of COMMAND_FIELDS) {
		if (isCommandFieldExcluded(toolName, field)) continue
		if (!(field in input)) continue
		const value = input[field]
		if (field === "then_run" && value && typeof value === "object" && !Array.isArray(value)) {
			const cmd = (value as { command?: unknown }).command
			if (typeof cmd === "string" && cmd.trim()) {
				found.push({ field, command: cmd.trim() })
			}
			continue
		}
		const values = Array.isArray(value) ? value : [value]
		for (const v of values) {
			if (typeof v !== "string") continue
			const command = v.trim()
			if (!command) continue
			found.push({ field, command })
		}
	}
	return found
}

export function declaredCommandFields(parameters: unknown): string[] {
	const props = (parameters as { properties?: Record<string, unknown> } | null | undefined)
		?.properties
	if (!props || typeof props !== "object") return []
	return COMMAND_FIELDS.filter((field) => field in props)
}
