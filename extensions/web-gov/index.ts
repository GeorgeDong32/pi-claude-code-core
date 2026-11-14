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
 *
 * BH-S2 (spec 2026-11-14-backtest-hardening): URL fields are parsed with
 * `new URL()` — the old prefix regex stopped at `@`, so
 * `https://github.com@evil.example/` extracted "github.com" and rode the
 * preapproved list. The family's canonical id now carries the parse
 * verdict (see canonicalTarget): plain host, `@host` for userinfo URLs
 * (explicit domain rules still match the real host, the preapproved list
 * NEVER does), `?raw` for unparsable fields (fail-closed ask), null for
 * non-URL fields (a free-text query is a search term, not a fetch target).
 * IP literals are hosts — `domain:` rules match them normally, but the
 * preapproved-domain list never matches an IP.
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

// BH-S2 canonical-id markers. `@` and `?` can never occur in a WHATWG
// hostname, so a marked id cannot collide with a real parsed host.
const USERINFO_MARK = "@";
const UNPARSABLE_MARK = "?";

interface ParsedTarget {
	host: string;
	userinfo: boolean;
}

/** Parse one URL field. Null when it is not an absolute URL with a host. */
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
	if (host === "") return null; // non-hierarchical (mailto:) — no fetch host to govern
	return { host, userinfo: url.username !== "" || url.password !== "" };
}

/**
 * Family canonical id for URL-ish tool input (BH-S2):
 *
 *   host       — parsed hostname, lowercased, trailing dots stripped
 *   `@host`    — the URL carried userinfo (user[:pass]@host): explicit
 *                domain rules still match the REAL host, but the
 *                preapproved list never does → ask absent an explicit rule
 *   `?raw`     — the field exists but is not a parsable absolute URL:
 *                fail-closed ask; only an explicit grant of the identical
 *                raw string can ever allow it again
 *   null       — no url/href/link string field (passthrough; falls through
 *                to the mcp family)
 */
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

/** The plain host view of a canonical id (null for unparsable fields). */
function targetHost(id: string): string {
	return id.startsWith(USERINFO_MARK) ? id.slice(USERINFO_MARK.length) : id;
}

/** IPv4-shaped (digits+dots) or IPv6 (brackets or any `:`). */
function isIpLiteral(host: string): boolean {
	return host.includes(":") || /^[\d.]+$/.test(host);
}

/**
 * Extract a hostname from URL-ish tool input. Only actual URL fields — a
 * free-text `query` is a search term, not a fetch target, and must not
 * drift a search call into host governance. BH-S2: parsed with `new URL()`
 * (userinfo URLs yield their real host; unparsable fields yield null here
 * while canonicalTarget still claims them for a fail-closed ask).
 */
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
			return canonicalTarget(input ?? {});
		},
		resolve(id, rules) {
			// deny > ask > allow (pm engine order); explicit rules beat the
			// preapproved list. Userinfo ids sweep rules by their REAL host
			// (`@evil.example` ↔ domain:evil.example); an unparsable `?raw`
			// id can only match a grant of the identical raw string.
			const host = targetHost(id);
			for (const behavior of ["deny", "ask", "allow"] as const) {
				for (const rule of rules) {
					if (rule.behavior !== behavior) continue;
					const m = /^webfetch\(domain:(.+)\)$/.exec(ruleValueText(rule));
					if (m && m[1].toLowerCase() === host) return behavior;
				}
			}
			// preapproved → allow without any rule (P4-WB-02). Subdomains of a
			// preapproved root (docs.github.com for github.com) count too —
			// but NEVER for a userinfo URL, an unparsable id, or an IP
			// literal (BH-S2: the preapproved list is a DOMAIN list).
			const preapprovedEligible =
				!id.startsWith(USERINFO_MARK) && !id.startsWith(UNPARSABLE_MARK) && !isIpLiteral(host);
			if (preapprovedEligible && isPreapproved(loadPreapprovedDomains(home), host)) return "allow";
			return "ask";
		},
		suggestAllowRule(id) {
			// userinfo ids suggest the real host's rule (the marker is not
			// user-writable grammar); an unparsable id suggests its exact
			// raw string so a grant re-matches only identical input
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
