
export function canonicalizeMcpShape(
	toolName: string,
	input: Record<string, unknown>,
	knownServers: ReadonlySet<string> = new Set(),
): string | null {
	const proxyTarget = typeof input.tool === "string" ? input.tool : "";
	const raw = toolName === "mcp" && proxyTarget ? proxyTarget : toolName;

	const native = /^(?:mcp__|mcp_)([A-Za-z0-9_-]+)__(.+)$/.exec(raw)
		?? /^(?:mcp__|mcp_)([A-Za-z0-9_-]+)_(.+)$/.exec(raw);
	if (native) {
		const server = native[1];
		const tool = native[2];
		if (!server || !tool) return null;
		return `mcp_${server}_${tool}`;
	}
	if (raw.startsWith("mcp_")) return raw;
	const direct = /^([a-z][a-z0-9]*)_[a-z][a-z0-9_]*$/i.exec(raw);
	if (direct && knownServers.has(direct[1].toLowerCase())) {
		return `mcp_${raw}`;
	}
	return null;
}

export function isMcpShapedCall(
	toolName: string,
	input: Record<string, unknown>,
	knownServers: ReadonlySet<string> = new Set(),
): boolean {
	return canonicalizeMcpShape(toolName, input, knownServers) !== null;
}

export function directKnownServersFromEnv(): string[] {
	return (process.env.PI_CORE_MCP_DIRECT_SERVERS ?? "")
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
}

export function knownServersSetFromEnv(): ReadonlySet<string> {
	return new Set(directKnownServersFromEnv().map((s) => s.toLowerCase()));
}
