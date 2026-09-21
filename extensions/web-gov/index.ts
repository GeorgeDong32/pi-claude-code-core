/**
 * web-gov/index.ts — the second rule family (P4-WB), proving the family
 * seam is real (P4-FAM-06).
 *
 * Claims search/fetch tools that carry a URL-ish input (exa
 * search/crawl/fetch, webfetch…), maps them to the HOST, and evaluates
 * `webfetch(domain:host)` rules (deny > allow > ask). A builtin
 * pre-approved domain list (P4-WB-02, CC preapproved pattern) renders
 * allow without any rule; the list is overridable via
 * ~/.pi/agent/pi-core-web.json.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { PermissionRule } from "../modes/permissions.ts";
import { registerRuleFamily, type RuleFamily } from "../modes/rule-families.ts";

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

export function loadPreapprovedDomains(home = homedir()): string[] {
	const override = join(home, ".pi", "agent", "pi-core-web.json");
	if (existsSync(override)) {
		try {
			const parsed = JSON.parse(readFileSync(override, "utf-8")) as { preapprovedDomains?: unknown };
			if (Array.isArray(parsed.preapprovedDomains)) {
				return parsed.preapprovedDomains.filter((d): d is string => typeof d === "string");
			}
		} catch {
			/* unreadable override → builtin list */
		}
	}
	return BUILTIN_PREAPPROVED;
}

/** Extract a hostname from URL-ish tool input. */
export function extractHost(input: Record<string, unknown>): string | null {
	for (const key of ["url", "query", "href", "link"]) {
		const value = input[key];
		if (typeof value !== "string") continue;
		const match = /^(?:https?:\/\/)?([a-z0-9.-]+\.[a-z]{2,})/i.exec(value.trim());
		if (match) return match[1].toLowerCase();
	}
	return null;
}

const URL_TOOL_HINT = /search|crawl|fetch|browse|webfetch|web/i;

export function createWebRuleFamily(home = homedir()): RuleFamily {
	const family: RuleFamily = {
		id: "web",
		match(toolName, input) {
			if (!URL_TOOL_HINT.test(toolName)) return null;
			// registered AFTER the mcp family: native-mcp shapes are claimed by
			// mcp first; URL-carrying direct tools (webfetch, web_search, …)
			// specialize here by host
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
					const text =
						typeof rule.ruleValue === "string"
							? rule.ruleValue
							: String((rule.ruleValue as { value?: unknown })?.value ?? "");
					const m = /^webfetch\(domain:(.+)\)$/.exec(text);
					if (m && m[1].toLowerCase() === host) return behavior;
				}
			}
			// preapproved → allow without any rule (P4-WB-02)
			if (loadPreapprovedDomains(home).includes(host)) return "allow";
			return "ask";
		},
		suggestAllowRule(host) {
			return `webfetch(domain:${host})`;
		},
	};
	registerRuleFamily(family);
	return family;
}
