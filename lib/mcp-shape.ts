/**
 * lib/mcp-shape.ts — pure MCP-shape predicate core (arch batch B1).
 *
 * The single authority on "is this an MCP-shaped tool" remains
 * `mcp-gov/family.ts#canonicalizeMcpTool`; this module is its pure
 * function core (zero extension imports, no pi runtime), shared with the
 * modes plan gate so the two can never drift again. The 0.99-adapt batch
 * left a private `__`-only regex in modes/index.ts that diverged from the
 * authority: single-underscore natives (`mcp_exa_search`), proxy-shaped
 * calls, direct-named tools, and bare `mcp_*` names all slipped past the
 * read-only plan gate (every MCP tool is a potential mutation).
 *
 * Shapes (mirrors the authority exactly — p4-families.test.ts pins both):
 *   native1  `mcp__srv__tool` / `mcp_srv__tool`    (double underscore)
 *   native2  `mcp__srv_tool`  / `mcp_srv_tool`     (single underscore)
 *   bare     `mcp_*` passthrough (no separator left to split)
 *   proxy    tool name "mcp" with the real tool in `input.tool`
 *   direct   bare `server_tool`, gated on the known-servers list
 */

export function canonicalizeMcpShape(
	toolName: string,
	input: Record<string, unknown>,
	knownServers: ReadonlySet<string> = new Set(),
): string | null {
	// proxy shape: tool name IS "mcp" and the real tool sits in input.tool
	const proxyTarget = typeof input.tool === "string" ? input.tool : "";
	const raw = toolName === "mcp" && proxyTarget ? proxyTarget : toolName;

	// native prefixes: mcp__server__tool / mcp_server__tool / mcp_server_tool
	const native = /^(?:mcp__|mcp_)([A-Za-z0-9_-]+)__(.+)$/.exec(raw)
		?? /^(?:mcp__|mcp_)([A-Za-z0-9_-]+)_(.+)$/.exec(raw);
	if (native) {
		const server = native[1];
		const tool = native[2];
		if (!server || !tool) return null;
		return `mcp_${server}_${tool}`;
	}
	if (raw.startsWith("mcp_")) return raw;
	// direct naming (exa_search): ONLY when the leading server id is on the
	// configured known-servers list — otherwise any foo_bar extension tool
	// would be misclaimed (P4-FAM-02④ keeps non-mcp unknown tools untouched;
	// risk ② "宁漏勿误")
	const direct = /^([a-z][a-z0-9]*)_[a-z][a-z0-9_]*$/i.exec(raw);
	if (direct && knownServers.has(direct[1].toLowerCase())) {
		return `mcp_${raw}`;
	}
	return null;
}

/** Boolean view of the same predicate — for gates that only need the shape. */
export function isMcpShapedCall(
	toolName: string,
	input: Record<string, unknown>,
	knownServers: ReadonlySet<string> = new Set(),
): boolean {
	return canonicalizeMcpShape(toolName, input, knownServers) !== null;
}

/**
 * Direct-naming server allowlist from env (DEVIATIONS #47④):
 * `PI_CORE_MCP_DIRECT_SERVERS=exa,github`. One parse shared by the mcp +
 * web rule families and the modes plan gate (B1).
 */
export function directKnownServersFromEnv(): string[] {
	return (process.env.PI_CORE_MCP_DIRECT_SERVERS ?? "")
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
}

/** Lowercased Set view, ready for the knownServers parameter. */
export function knownServersSetFromEnv(): ReadonlySet<string> {
	return new Set(directKnownServersFromEnv().map((s) => s.toLowerCase()));
}
