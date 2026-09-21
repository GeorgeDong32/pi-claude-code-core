/**
 * rules/defaults.ts — builtin rule entries shipped with the package
 * (lowest-priority scope; any user rule with the same slug shadows it).
 *
 * The search-channel note is CONDITIONAL wording (red-team #12): until the
 * P4 exa MCP default actually ships, the model is told to prefer
 * mcp_exa_* tools IF they are present, else fall back to pi-web-access.
 * P4-WB-03 rewrites this to the final "exa MCP first" wording with 1.3.0.
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
		description: "Which search channel to use, conditional on installed tools",
		content: `Web search: if mcp_exa_* tools are available in this session, use them first (they return cleaner results and are the intended default going forward). Otherwise use the pi-web-access search tool. Do not mix channels within one task without saying so.`,
	},
];
