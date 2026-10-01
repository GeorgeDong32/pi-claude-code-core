/**
 * mcp-gov/family.ts — the MCP rule family (P4-MC-01/02).
 *
 * canonicalize three call shapes to one id: `mcp__exa__search` (native
 * prefix), `exa_search` (direct naming), proxy `mcp` tool with
 * `input.tool` → `mcp_exa_search`. Non-MCP names return null — the family
 * never claims beyond its boundary.
 *
 * canonicalizeMcpTool stays the single authority (invariant 4); its pure
 * shape core lives in lib/mcp-shape.ts and is shared verbatim with the
 * modes plan gate (arch batch B1) so the two consumers cannot drift.
 *
 * resolve order: deny > ask > allow (the pm engine's order, applied to
 * rule strings over the canonical id with `mcp_<server>_*` prefixes
 * matching first, then the bare `mcp_*`).
 */

import { canonicalizeMcpShape } from "../../lib/mcp-shape.js";
import { ruleMatchesId, ruleValueText } from "../../lib/rule-text.js";
import type { PermissionRule } from "../modes/permissions.ts";
import { registerRuleFamily, type RuleFamily } from "../modes/rule-families.ts";

// B1: the pure core + env parse moved to lib/mcp-shape.ts; re-exported
// here so existing consumers (web-gov) keep their import surface.
export { directKnownServersFromEnv } from "../../lib/mcp-shape.js";

export function canonicalizeMcpTool(
	toolName: string,
	input: Record<string, unknown>,
	knownServers: ReadonlySet<string> = new Set(),
): string | null {
	return canonicalizeMcpShape(toolName, input, knownServers);
}

function ruleMatchesCanonicalId(ruleText: string, canonicalId: string): boolean {
	return ruleMatchesId(ruleText, canonicalId);
}

/**
 * How specifically a rule text governs the canonicalId (P4-MC-01):
 * 3 = exact name, 2 = `mcp_<server>_*` prefix, 1 = bare `mcp_*`,
 * 0 = no match. A more specific rule beats a broader one across
 * behaviors (deny `mcp_*` + allow `mcp_exa_search` → allow).
 */
function matchTier(ruleText: string, canonicalId: string): number {
	if (ruleText === canonicalId) return 3;
	if (ruleText.endsWith("*") && canonicalId.startsWith(ruleText.slice(0, -1))) {
		return ruleText.slice(0, -1).length > "mcp_".length ? 2 : 1;
	}
	return 0;
}

const BEHAVIOR_ORDER = { deny: 0, ask: 1, allow: 2 } as const;

export function resolveMcpVerdict(canonicalId: string, rules: PermissionRule[]): "deny" | "allow" | "ask" {
	// specificity first (exact > server-prefix > bare mcp_*), then
	// deny > ask > allow within a tier (spec P4-MC-01; an explicit ask must
	// not be silently swallowed by a broader allow prefix)
	let best: { tier: number; behavior: "deny" | "ask" | "allow" } | null = null;
	for (const rule of rules) {
		if (rule.behavior !== "deny" && rule.behavior !== "ask" && rule.behavior !== "allow") continue;
		const tier = matchTier(ruleValueText(rule), canonicalId);
		if (tier === 0) continue;
		if (!best || tier > best.tier || (tier === best.tier && BEHAVIOR_ORDER[rule.behavior] < BEHAVIOR_ORDER[best.behavior])) {
			best = { tier, behavior: rule.behavior };
		}
	}
	return best?.behavior ?? "ask";
}

/** Create and register the family. Returns it for tests. */
export function createMcpRuleFamily(options?: { knownServers?: string[] }): RuleFamily {
	const knownServers = new Set((options?.knownServers ?? []).map((s) => s.toLowerCase()));
	const family: RuleFamily = {
		id: "mcp",
		match(toolName, input) {
			return canonicalizeMcpTool(toolName, input ?? {}, knownServers);
		},
		resolve(canonicalId, rules) {
			return resolveMcpVerdict(canonicalId, rules);
		},
		suggestAllowRule(canonicalId) {
			// mcp_exa_search → mcp_exa_* (server-wide allow; P4-MC-02)
			const m = /^mcp_([A-Za-z0-9_-]+)_/.exec(canonicalId);
			return m ? `mcp_${m[1]}_*` : canonicalId;
		},
		matchesRule(rule, canonicalId) {
			return ruleMatchesCanonicalId(ruleValueText(rule), canonicalId);
		},
	};
	registerRuleFamily(family);
	return family;
}
