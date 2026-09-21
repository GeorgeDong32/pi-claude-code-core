/**
 * mcp-gov/index.ts — MCP governance module assembly (P4-MC).
 *
 * Registers the MCP rule family into the modes engine, starts the broker
 * mirror against the probed adapter port (absent → idle, zero side
 * effects), and adds the /core panel command (P4-MC-06).
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { loadMergedPermissionRules } from "../modes/permissions-loader.ts";
import { ruleMatchesId, ruleValueText } from "../../lib/rule-text.js";
import { getAdjudication, hasSessionGrant, isBypassActive } from "../modes/rule-families.ts";
import { createBrokerMirror, probeMcpAdapterPort, type McpEventPort } from "./broker.ts";
import { createMcpRuleFamily } from "./family.ts";
import { renderMcpPanel } from "./panel.ts";

export default function mcpGovExtension(pi: ExtensionAPI): void {
	// direct tool naming (exa_search) only claims when the server id is on
	// this list — configure via env, e.g. PI_CORE_MCP_DIRECT_SERVERS=exa,github
	const knownServers = (process.env.PI_CORE_MCP_DIRECT_SERVERS ?? "")
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
	createMcpRuleFamily({ knownServers });

	let mirror = createBrokerMirror({ present: false } as McpEventPort, {
		getAdjudication: () => undefined,
		bypassActive: () => false,
		hasAllowRule: () => false,
		hasSessionGrant,
	});

	pi.on("session_start", async (_event, ctx: ExtensionContext) => {
		try {
			const port = await probeMcpAdapterPort();
			mirror = createBrokerMirror(port, {
				// live rule view over the same merged rules the gate used
				hasAllowRule: (canonicalId) =>
					resolveHasAllow(loadMergedPermissionRules(ctx.cwd), canonicalId),
				bypassActive: isBypassActive,
				getAdjudication: (id) => getAdjudicationFor(id),
				hasSessionGrant,
			});
			mirror.start();
		} catch {
			/* mirror is best-effort */
		}
	});

	pi.registerCommand("core", {
		description: "Core status panel: MCP governance section",
		handler: async (_args, ctx) => {
			const commandCtx = ctx as ExtensionContext;
			const port = await probeMcpAdapterPort();
			const rules = loadMergedPermissionRules(commandCtx.cwd ?? process.cwd());
			const ruleSummary = (["allow", "deny", "ask"] as const).map((behavior) => {
				const rows = rules
					.filter((r) => r.behavior === behavior)
					.map((r) => (typeof r.ruleValue === "string" ? r.ruleValue : ""));
				return rows.length > 0 ? `${behavior}: ${rows.join(", ")}` : `${behavior}: (none)`;
			});
			const section = renderMcpPanel({ port, ruleSummary, denyCount: mirror.denyCount() });
			pi.sendMessage({
				customType: "pi-core-status",
				content: `# /core — mcp-gov [${section.status}]\n\n${section.lines.map((l) => `- ${l}`).join("\n")}`,
				display: true,
			});
		},
	});
}

function resolveHasAllow(rules: ReturnType<typeof loadMergedPermissionRules>, canonicalId: string): boolean {
	return rules.some(
		(r) => r.behavior === "allow" && ruleMatchesId(ruleValueText(r), canonicalId),
	);
}

function getAdjudicationFor(id: string): { outcome: string } | undefined {
	return getAdjudication(id);
}
