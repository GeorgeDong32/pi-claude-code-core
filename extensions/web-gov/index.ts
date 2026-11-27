import { statSync } from "node:fs";
import { readJson } from "../../lib/settings.ts";
import { homedir } from "node:os";
import { join } from "node:path";

import { ruleValueText } from "../../lib/rule-text.js";
import type { PermissionRule } from "../modes/permissions.ts";
import { registerRuleFamily, type RuleFamily } from "../modes/rule-families.ts";
import { canonicalizeMcpTool, directKnownServersFromEnv } from "../mcp-gov/family.ts";

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

const preapprovedCache = new Map<string, { fingerprint: string; value: string[] }>();

function overrideFingerprint(path: string): string | null {
	try {
		const st = statSync(path);
		return `${st.mtimeMs}:${st.size}:${st.ino}`;
	} catch {
		return null;
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

export function isPreapproved(domains: string[], host: string): boolean {
	return domains.some((d) => host === d || host.endsWith(`.${d}`));
}

const USERINFO_MARK = "@";
const UNPARSABLE_MARK = "?";

interface ParsedTarget {
	host: string;
	userinfo: boolean;
}

function parseUrlTarget(raw: string): ParsedTarget | null {
	let url: URL;
	try {
		url = new URL(raw.trim());
	} catch {
		return null;
	}
	// WHATWG already case-folds the host; the trailing dot(s) are kept by
	// the parser and must be stripped here (`GitHub.com.` ⊆ `github.com`).
	const host = url.hostname.toLowerCase().replace(/\.+$/, "");
	if (host === "") return null;
	return { host, userinfo: url.username !== "" || url.password !== "" };
}

export function canonicalTarget(input: Record<string, unknown>): string | null {
	let unparsable: string | undefined;
	for (const key of ["url", "href", "link"]) {
		const value = input[key];
		if (typeof value !== "string") continue;
		const parsed = parseUrlTarget(value);
		if (parsed === null) {
			unparsable ??= value.trim();
			continue;
		}
		return parsed.userinfo ? `${USERINFO_MARK}${parsed.host}` : parsed.host;
	}
	return unparsable !== undefined ? `${UNPARSABLE_MARK}${unparsable}` : null;
}

function targetHost(id: string): string {
	return id.startsWith(USERINFO_MARK) ? id.slice(USERINFO_MARK.length) : id;
}

function isIpLiteral(host: string): boolean {
	return host.includes(":") || /^[\d.]+$/.test(host);
}

export function extractHost(input: Record<string, unknown>): string | null {
	const target = canonicalTarget(input);
	if (target === null || target.startsWith(UNPARSABLE_MARK)) return null;
	return targetHost(target);
}

const URL_TOOL_HINT = /search|crawl|fetch|browse|webfetch|web/i;

export function createWebRuleFamily(home = homedir()): RuleFamily {
	const knownServers = new Set(directKnownServersFromEnv().map((s) => s.toLowerCase()));
	const family: RuleFamily = {
		id: "web",
		match(toolName, input) {
			const proxyTarget = typeof input?.tool === "string" ? input.tool : "";
			const effectiveName = toolName === "mcp" && proxyTarget ? proxyTarget : toolName;
			if (!URL_TOOL_HINT.test(effectiveName)) return null;
			if (canonicalizeMcpTool(toolName, input ?? {}, knownServers) === null) return null;
			return canonicalTarget(input ?? {});
		},
		resolve(id, rules) {
			const host = targetHost(id);
			for (const behavior of ["deny", "ask", "allow"] as const) {
				for (const rule of rules) {
					if (rule.behavior !== behavior) continue;
					const m = /^webfetch\(domain:(.+)\)$/.exec(ruleValueText(rule));
					if (m && m[1].toLowerCase() === host) return behavior;
				}
			}
			const preapprovedEligible =
				!id.startsWith(USERINFO_MARK) && !id.startsWith(UNPARSABLE_MARK) && !isIpLiteral(host);
			if (preapprovedEligible && isPreapproved(loadPreapprovedDomains(home), host)) return "allow";
			return "ask";
		},
		suggestAllowRule(id) {
			return `webfetch(domain:${targetHost(id)})`;
		},
		matchesRule(rule, canonicalId) {
			const id = targetHost(canonicalId);
			const m = /^webfetch\(domain:(.+)\)$/.exec(ruleValueText(rule));
			return m !== null && m[1].toLowerCase() === id;
		},
	};
	registerRuleFamily(family);
	return family;
}
