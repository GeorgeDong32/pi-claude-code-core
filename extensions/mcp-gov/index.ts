import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { loadMergedPermissionRules } from "../modes/permissions-loader.ts";
import { ruleMatchesId, ruleValueText } from "../../lib/rule-text.js";
import { getAdjudication, hasSessionGrant, isBypassActive } from "../modes/rule-families.ts";
import { createBrokerMirror, probeMcpAdapterPort, type McpEventPort } from "./broker.ts";
import { createMcpRuleFamily, directKnownServersFromEnv } from "./family.ts";
import { renderMcpPanel } from "./panel.ts";
// NOTE (DEVIATIONS #133): inline copy of pi-ai's estimateTextTokens
// (ceil(len / 3.5), pi-ai 1.4.0 dist/utils/estimate.js). The public
// "@earendil-works/pi-ai/utils/estimate" subpath import cannot be used
// here twice over: pi's extension loader (jiti aliases) rewrites bare
// "@earendil-works/pi-ai*" to the compat entrypoint FILE (killing any
// subpath), and a relative entity-path import would bind the package to
// the dev node_modules layout (absent on machines that install via
// `pi update` without devDeps). Keep in sync with pi-ai if the constant
// changes; re-export from the public subpath once pi's alias table grows
// per-subpath entries.
const PI_AI_CHARS_PER_TOKEN = 3.5;
const estimateTextTokens = (text: string): number => Math.ceil(text.length / PI_AI_CHARS_PER_TOKEN);
import { createDeclarationMeter } from "./declaration-meter.ts";
import { readJson, writeJsonAtomic } from "../../lib/settings.ts";

export default function mcpGovExtension(pi: ExtensionAPI): void {
	createMcpRuleFamily({ knownServers: directKnownServersFromEnv() });

	let mirror = createBrokerMirror({ present: false } as McpEventPort, {
		getAdjudication: () => undefined,
		bypassActive: () => false,
		hasAllowRule: () => false,
		hasSessionGrant,
	});

	pi.on("session_start", async (_event, ctx: ExtensionContext) => {
		mirror.stop();
		try {
			const port = await probeMcpAdapterPort();
			mirror = createBrokerMirror(port, {
				hasAllowRule: (canonicalId) =>
					resolveHasAllow(loadMergedPermissionRules(ctx.cwd), canonicalId),
				bypassActive: isBypassActive,
				getAdjudication: (id) => getAdjudicationFor(id),
				hasSessionGrant,
			});
			mirror.start();
		} catch {
		}
	});

	pi.on("session_shutdown", async () => {
		mirror.stop();
	});

	const declarationMeter = createDeclarationMeter();
	pi.on("before_provider_request", async (event) => {
		declarationMeter.observe((event as { payload?: unknown }).payload);
	});

	pi.registerCommand("core", {
		description: "Core status panel: MCP governance section; `/core exposure <server> <tier>` switches a server's declaration tier",
		handler: async (args, ctx) => {
			const commandCtx = ctx as ExtensionContext;
			const tokens = (args ?? "").trim().split(/\s+/).filter(Boolean);
			if (tokens[0] === "exposure") {
				const result = switchExposure(tokens, commandCtx);
				pi.sendMessage({
					customType: "pi-core-status",
					content: `# /core — mcp-gov\n\n- ${result}`,
					details: { command: `/core ${(args ?? "").trim()}`.trim() },
					display: true,
				});
				return;
			}
			const port = await probeMcpAdapterPort();
			const rules = loadMergedPermissionRules(commandCtx.cwd ?? process.cwd());
			const ruleSummary = (["allow", "deny", "ask"] as const).map((behavior) => {
				const rows = rules
					.filter((r) => r.behavior === behavior)
					.map((r) => ruleValueText(r));
				return rows.length > 0 ? `${behavior}: ${rows.join(", ")}` : `${behavior}: (none)`;
			});
			const meterSnap = declarationMeter.last();
			const declLine = meterSnap
				? `declarations: ${meterSnap.toolCount} tools, ${Object.entries(meterSnap.perServer).map(([srv, b]) => `${srv} ${formatTok(b)}`).join(", ") || "no mcp"} (peak ${formatTok(meterSnap.maxBytes)}) — \`/core exposure <server> codemode\` to drop a server's declarations`
				: null;
			const section = renderMcpPanel({ port, ruleSummary, denyCount: mirror.denyCount(), extraLines: declLine ? [declLine] : [] });
			pi.sendMessage({
				customType: "pi-core-status",
				content: `# /core — mcp-gov [${section.status}]\n\n${section.lines.map((l) => `- ${l}`).join("\n")}`,
				details: { command: "/core" },
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

export function switchExposure(tokens: string[], ctx: ExtensionContext): string {
	const [, serverArg, tierArg] = tokens;
	const TIERS = new Set(["codemode", "deferred", "direct", "hidden"]);
	const ALIAS: Record<string, string> = { "codemode-deferred": "codemode" };
	if (!serverArg || !tierArg) return "usage: /core exposure <server> <codemode|deferred|direct|hidden>";
	const tier = ALIAS[tierArg] ?? tierArg;
	if (!TIERS.has(tier)) return `unknown tier "${tierArg}" (tiers: ${[...TIERS].join("|")}; codemode-deferred aliases to codemode)`;
	const home = (process.env.PI_B4_TEST_HOME as string | undefined) ?? process.env.HOME ?? homedir();
	const globalPath = join(home, ".pi", "agent", "mcp.json");
	const cfg = readJson<{ mcpServers?: Record<string, { exposure?: string }> }>(globalPath, {});
	if (!cfg.mcpServers || !(serverArg in cfg.mcpServers)) {
		return `server "${serverArg}" not found in the global mcp.json (or the file is unreadable)`;
	}
	const projectOverride = join(ctx.cwd ?? process.cwd(), ".pi", "mcp.json");
	const proj = readJson<{ mcpServers?: Record<string, { exposure?: string }> }>(projectOverride, {});
	if (proj.mcpServers && serverArg in proj.mcpServers && proj.mcpServers[serverArg]?.exposure !== undefined) {
		return `"${serverArg}" has a project-level exposure override (${projectOverride}) — edit it there (this command writes the global file only)`;
	}
	const next = JSON.parse(JSON.stringify(cfg)) as typeof cfg;
	next.mcpServers![serverArg]!.exposure = tier;
	writeJsonAtomic(globalPath, next);
	return `exposure of "${serverArg}" → ${tier} (takes effect after /reload or a restart)`;
}

function formatTok(bytes: number): string {
	return `≈${estimateTextTokens("a".repeat(bytes))} tok`;
}
