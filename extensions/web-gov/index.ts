/**
 * web-gov/index.ts — the second rule family (P4-WB), proving the family
 * seam is real (P4-FAM-06).
 *
 * Claims search/fetch tools that carry a URL-ish input (exa
 * search/crawl/fetch, webfetch…), maps them to the HOST, and evaluates
 * `webfetch(domain:host)` rules (deny > ask > allow). A builtin
 * pre-approved domain list (P4-WB-02, CC preapproved pattern) renders
 * allow without any rule; the list is overridable via
 * ~/.pi/agent/pi-core-web.json.
 */
import { statSync } from "node:fs";
import { readJson } from "../../lib/settings.ts";
import { homedir } from "node:os";
import { join } from "node:path";

import { ruleValueText } from "../../lib/rule-text.js";
import type { PermissionRule } from "../modes/permissions.ts";
import { registerRuleFamily, type RuleFamily } from "../modes/rule-families.ts";
// canonicalizeMcpTool is the single authority on "is this an MCP-shaped
// tool" (native/proxy/direct+knownServers) — reuse, don't reimplement;
// its pure shape core lives in lib/mcp-shape.ts, shared with the modes
// plan gate (arch B1)
import { canonicalizeMcpTool, directKnownServersFromEnv } from "../mcp-gov/family.ts";

/** CC-style preapproved documentation/reference domains (P4-WB-02). */
export const BUILTIN_PREAPPROVED = [
	"developer.mozilla.org",
	"github.com",
	"raw.githubusercontent.com",
	"docs.python.org",
	"nodejs.org",
	"deno.com",
	"bun.sh",
	"rust-lang.org",
	"go.dev",
	"developer.apple.com",
	"learn.microsoft.com",
	"cloud.google.com",
	"docs.aws.amazon.com",
	"stackoverflow.com",
];

// P3-1 S4 (SPEC 2026-10-07): the override read goes through lib/settings'
// readJson (invariant 10 — malformed input never throws) with a stat-
// fingerprint cache (absPath + mtimeMs + size + ino). A hit skips the
// read/parse entirely; missing falls back to the builtin list silently.
// Limit (disclosed): mtime-preserving in-place edits of the SAME length are
// invisible until the next stat-visible change.
const preapprovedCache = new Map<string, { fingerprint: string; value: string[] }>();

function overrideFingerprint(path: string): string | null {
	try {
		const st = statSync(path);
		return `${st.mtimeMs}:${st.size}:${st.ino}`;
	} catch {
		return null; // missing → builtin, silently
	}
}

export function loadPreapprovedDomains(home = homedir()): string[] {
	const override = join(home, ".pi", "agent", "pi-core-web.json");
	const fp = overrideFingerprint(override);
	if (fp === null) return BUILTIN_PREAPPROVED;
	const cached = preapprovedCache.get(override);
	if (cached && cached.fingerprint === fp) return cached.value;
	const parsed = readJson<{ preapprovedDomains?: unknown }>(override, {} as { preapprovedDomains?: unknown }, (reason) => {
		if (reason === "malformed" || reason === "non-object") {
			console.warn(`[web-gov] Failed to read ${override}: invalid JSON — using the builtin preapproved list`);
		}
	});
	const value = Array.isArray(parsed.preapprovedDomains)
		? parsed.preapprovedDomains.filter((d): d is string => typeof d === "string")
		: BUILTIN_PREAPPROVED;
	preapprovedCache.set(override, { fingerprint: fp, value });
	return value;
}

/** Exact host or any subdomain of it (`docs.github.com` ⊆ `github.com`). */
export function isPreapproved(domains: string[], host: string): boolean {
	return domains.some((d) => host === d || host.endsWith(`.${d}`));
}

/**
 * Extract a hostname from URL-ish tool input. Only actual URL fields — a
 * free-text `query` is a search term, not a fetch target, and must not
 * drift a search call into host governance.
 */
export function extractHost(input: Record<string, unknown>): string | null {
	for (const key of ["url", "href", "link"]) {
		const value = input[key];
		if (typeof value !== "string") continue;
		const match = /^(?:https?:\/\/)?([a-z0-9.-]+\.[a-z]{2,})/i.exec(value.trim());
		if (match) return match[1].toLowerCase();
	}
	return null;
}

const URL_TOOL_HINT = /search|crawl|fetch|browse|webfetch|web/i;

export function createWebRuleFamily(home = homedir()): RuleFamily {
	const knownServers = new Set(directKnownServersFromEnv().map((s) => s.toLowerCase()));
	const family: RuleFamily = {
		id: "web",
		match(toolName, input) {
			// proxy shape: the real tool name sits in input.tool
			const proxyTarget = typeof input?.tool === "string" ? input.tool : "";
			const effectiveName = toolName === "mcp" && proxyTarget ? proxyTarget : toolName;
			if (!URL_TOOL_HINT.test(effectiveName)) return null;
			// P4-WB-01 + FAM-02④: only MCP-shaped tools are governed. A
			// non-mcp extension tool that merely has a url-ish param must
			// stay a passthrough, not become a first-seen prompt.
			if (canonicalizeMcpTool(toolName, input ?? {}, knownServers) === null) return null;
			// registered BEFORE the mcp family (extensions/index.ts): a
			// URL-carrying call is governed by its HOST here, taking
			// precedence over mcp-prefix rules (P4-WB-01); URL-less calls
			// return null and fall through to the mcp family
			return extractHost(input ?? {});
		},
		resolve(host, rules) {
			// explicit rules beat the preapproved list (a deny for a
			// preapproved domain must hold)
			// deny > ask > allow (pm engine order); explicit rules beat the
			// preapproved list
			for (const behavior of ["deny", "ask", "allow"] as const) {
				for (const rule of rules) {
					if (rule.behavior !== behavior) continue;
					const m = /^webfetch\(domain:(.+)\)$/.exec(ruleValueText(rule));
					if (m && m[1].toLowerCase() === host) return behavior;
				}
			}
			// preapproved → allow without any rule (P4-WB-02). Subdomains of a
			// preapproved root (docs.github.com for github.com) count too.
			if (isPreapproved(loadPreapprovedDomains(home), host)) return "allow";
			return "ask";
		},
		suggestAllowRule(host) {
			return `webfetch(domain:${host})`;
		},
		matchesRule(rule, canonicalId) {
			const m = /^webfetch\(domain:(.+)\)$/.exec(ruleValueText(rule));
			return m !== null && m[1].toLowerCase() === canonicalId;
		},
	};
	registerRuleFamily(family);
	return family;
}
