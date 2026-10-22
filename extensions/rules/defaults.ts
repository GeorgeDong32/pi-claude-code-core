/**
 * rules/defaults.ts — builtin rule entries shipped with the package
 * (lowest-priority scope; any user rule with the same slug shadows it).
 *
 * P4-WB-03 (1.3.0): the search-channel entry is now the FINAL "exa MCP
 * first" wording — the conditional 1.2.0 phrasing is retired together with
 * pi-web-access.
 *
 * 1.4.x (2026-10-22): the same entry no longer assumes direct exposure.
 * With `"exposure": "codemode"` (or "deferred") the mcp__exa__* tools are
 * not declared to the model and must be reached from codemode via the
 * top-level searchTools() global — the wording now covers both shapes.
 */

export interface BuiltinRule {
	slug: string;
	name: string;
	description: string;
	content: string;
}

export const BUILTIN_RULES: BuiltinRule[] = [
	{
		slug: "sources-and-references",
		name: "sources-and-references",
		description: "Cite Sources: as a trailing footnote when web/search facts are used",
		content: `When an answer draws on web content or search results, end the reply with a "Sources:" footnote listing the URLs actually used, as markdown links. Do not invent URLs; only list pages whose content you (or a tool result in this session) actually observed.`,
	},
	{
		slug: "mcp-tool-use",
		name: "mcp-tool-use",
		description: "Prefer dedicated MCP tools over shell workarounds when present",
		content: `When MCP tools (mcp__server__tool / mcp_* naming) are available for a task — search, fetch, GitHub operations — prefer them over shelling out with curl or reimplementing their function in scripts. If an MCP call fails, report the error instead of silently substituting a workaround.`,
	},
	{
		slug: "search-channel",
		name: "search-channel",
		description: "Use exa MCP as the default search channel (direct tools when declared, else via codemode); pi-web-access is retired",
		content: `Web search: exa MCP is the default search channel — cleaner, citable results. When mcp__exa__* tools are declared to you (direct exposure), call them directly; when they are not (codemode/deferred exposure), reach them from a codemode script via the top-level searchTools() global. pi-web-access is retired and must not be used. Do not mix search channels within one task without saying so.`,
	},
];
