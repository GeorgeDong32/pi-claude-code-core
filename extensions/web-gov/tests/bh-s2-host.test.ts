import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { BUILTIN_PREAPPROVED, createWebRuleFamily, extractHost } from "../index.ts";
import { clearRuleFamilies, type RuleFamily } from "../../modes/rule-families.ts";
import type { PermissionRule } from "../../modes/permissions.ts";

const rule = (behavior: "allow" | "deny" | "ask", text: string): PermissionRule =>
	({ behavior, ruleValue: text, source: "global" }) as never;

const family: RuleFamily = createWebRuleFamily("/nonexistent-home");
after(() => clearRuleFamilies());

function verdict(url: string, rules: PermissionRule[] = []): "allow" | "deny" | "ask" {
	const id = family.match("mcp_exa_crawl", { url });
	assert.notEqual(id, null, `the web family must claim a url-carrying call: ${url}`);
	return family.resolve(id as string, rules);
}

describe("BH-S2: userinfo URLs are parsed, never preapproved", () => {
	it("https://github.com@evil.example/ extracts the REAL host evil.example", () => {
		assert.equal(extractHost({ url: "https://github.com@evil.example/" }), "evil.example");
	});

	it("https://github.com@evil.example/ → ask on the builtin list (was: preallowed github.com)", () => {
		assert.equal(verdict("https://github.com@evil.example/"), "ask");
	});

	it("a deny rule for the real host blocks a userinfo URL pointing elsewhere", () => {
		assert.equal(verdict("https://github.com@evil.example/", [rule("deny", "webfetch(domain:evil.example)")]), "deny");
	});

	it("an explicit domain-allow rule still grants a userinfo URL (rules match the real host)", () => {
		assert.equal(verdict("https://user@evil.example/", [rule("allow", "webfetch(domain:evil.example)")]), "allow");
		assert.equal(verdict("http://127.0.0.1:8080/x", [rule("allow", "webfetch(domain:127.0.0.1)")]), "allow");
	});

	it("an explicit domain-deny rule blocks an IP-literal URL", () => {
		assert.equal(verdict("http://127.0.0.1:8080/x", [rule("deny", "webfetch(domain:127.0.0.1)")]), "deny");
	});

	it("userinfo URL to a PREAPPROVED host asks (user@github.com must not ride the list)", () => {
		assert.equal(verdict("https://user@github.com/"), "ask");
		assert.equal(extractHost({ url: "https://user@github.com/" }), "github.com");
	});

	it("user:pass@ is userinfo too", () => {
		assert.equal(verdict("https://user:pass@github.com/"), "ask");
	});
});

describe("BH-S2: hostname normalization", () => {
	it("https://GitHub.com./x resolves to github.com (trailing dot stripped, case-folded)", () => {
		assert.equal(extractHost({ url: "https://GitHub.com./x" }), "github.com");
		assert.equal(verdict("https://GitHub.com./x"), "allow");
	});

	it("HTTPS://GitHub.COM/ → github.com", () => {
		assert.equal(extractHost({ url: "HTTPS://GitHub.COM/" }), "github.com");
	});
});

describe("BH-S2: IP literals are hosts", () => {
	it("http://127.0.0.1:8080 has host 127.0.0.1 (was: unclaimed)", () => {
		assert.equal(extractHost({ url: "http://127.0.0.1:8080/x" }), "127.0.0.1");
		assert.equal(family.match("mcp_exa_crawl", { url: "http://127.0.0.1:8080/x" }), "127.0.0.1");
	});

	it("domain: rules match an IP literal host normally", () => {
		assert.equal(verdict("http://127.0.0.1:8080/x", [rule("deny", "webfetch(domain:127.0.0.1)")]), "deny");
	});

	it("the preapproved list never matches an IP — even when a user override lists it", () => {
		const home = mkdtempSync(join(tmpdir(), "bh-s2-ip-"));
		try {
			mkdirSync(join(home, ".pi", "agent"), { recursive: true });
			writeFileSync(join(home, ".pi", "agent", "pi-core-web.json"), JSON.stringify({ preapprovedDomains: ["127.0.0.1"] }));
			const custom = createWebRuleFamily(home);
			const id = custom.match("mcp_exa_crawl", { url: "http://127.0.0.1:8080/x" });
			assert.equal(id, "127.0.0.1");
			assert.equal(custom.resolve(id as string, []), "ask");
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});
});

describe("BH-S2: fail-closed parsing", () => {
	it("an unparsable (schemeless) url field asks instead of riding the preapproved list", () => {
		assert.equal(verdict("github.com/docs"), "ask");
	});

	it("an empty url field is a parse failure → claimed and ask (fail-closed), not passthrough", () => {
		const id = family.match("mcp_exa_crawl", { url: "" });
		assert.notEqual(id, null);
		assert.equal(family.resolve(id as string, []), "ask");
	});

	it("a path can never make a host preapproved (evil.example/github.com is not github.com)", () => {
		assert.equal(extractHost({ url: "https://evil.example/github.com" }), "evil.example");
		assert.equal(verdict("https://evil.example/github.com"), "ask");
	});

	it("a free-text query is still unclaimed (a search term is not a fetch target)", () => {
		assert.equal(extractHost({ query: "example.com/docs" }), null);
		assert.equal(family.match("mcp_exa_search", { query: "github.com" }), null);
	});

	it("the builtin list still allows its plain domains and subdomains", () => {
		assert.equal(verdict("https://developer.mozilla.org/"), "allow");
		assert.equal(verdict("https://docs.github.com/"), "allow");
		assert.ok(BUILTIN_PREAPPROVED.includes("github.com"));
	});
});

describe("BH-S2: rule grammar over marked ids", () => {
	it("deny display works through the userinfo marker (matchesRule strips it)", () => {
		assert.equal(family.matchesRule(rule("deny", "webfetch(domain:evil.example)"), "@evil.example"), true);
		assert.equal(family.matchesRule(rule("deny", "webfetch(domain:other.example)"), "@evil.example"), false);
	});

	it("suggestAllowRule strips the userinfo marker (suggest the real host's rule)", () => {
		assert.equal(family.suggestAllowRule("@evil.example"), "webfetch(domain:evil.example)");
	});
});
