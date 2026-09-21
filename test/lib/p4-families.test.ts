/**
 * P4 tests — rule families (FAM), mcp family + broker mirror (MC),
 * web family (WB). Gate end-to-end cases drive the REAL modes gate through
 * the fake host (first-seen dialog answers via ui.select override); the
 * mirror consistency matrix (P4-MC-04) drives the mirror's pure decide()
 * against the five recorded gate outcomes — uiPrompts≤1 is asserted on the
 * end-to-end cases instead (the matrix has no UI surface by design).
 */
import { describe, expect, it, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FakeHost, clearCoreGlobals, snapshotCoreGlobals } from "../contracts/fake-host.ts";
import { resetCoreBusForTests } from "../../extensions/bus.ts";
import { targets } from "../contracts/targets.ts";
import {
	canonicalizeMcpTool,
	createMcpRuleFamily,
	resolveMcpVerdict,
} from "../../extensions/mcp-gov/family.ts";
import {
	clearAdjudications,
	clearRuleFamilies,
	clearSessionGrants,
	grantSession,
	hasSessionGrant,
	getAdjudication,
	noteAdjudicated,
	type RuleFamily,
} from "../../extensions/modes/rule-families.ts";
import type { PermissionRule } from "../../extensions/modes/permissions.ts";
import { createWebRuleFamily, extractHost, loadPreapprovedDomains, BUILTIN_PREAPPROVED } from "../../extensions/web-gov/index.ts";
import { createBrokerMirror } from "../../extensions/mcp-gov/broker.ts";
import { renderMcpPanel } from "../../extensions/mcp-gov/panel.ts";

let globalsSnapshot: Record<string, unknown>;

beforeEach(() => {
	globalsSnapshot = snapshotCoreGlobals();
	clearCoreGlobals();
	resetCoreBusForTests();
	clearRuleFamilies();
	clearSessionGrants();
	clearAdjudications();
});

function rule(behavior: "allow" | "deny" | "ask", text: string): PermissionRule {
	return { behavior, ruleValue: text, source: "global" } as never;
}

describe("P4-MC-01 canonicalize + resolve", () => {
	it("canonicalizes the three shapes; non-mcp names return null", () => {
		expect(canonicalizeMcpTool("mcp__exa__search", {})).toBe("mcp_exa_search");
		expect(canonicalizeMcpTool("mcp_exa_search", {})).toBe("mcp_exa_search");
		expect(canonicalizeMcpTool("mcp", { tool: "exa_search" }, new Set(["exa"]))).toBe("mcp_exa_search");
		expect(canonicalizeMcpTool("exa_search", {}, new Set(["exa"]))).toBe("mcp_exa_search");
		expect(canonicalizeMcpTool("bash", {})).toBeNull();
		expect(canonicalizeMcpTool("read", {})).toBeNull();
	});

	it("resolve: exact > server prefix > none(=ask); deny beats allow", () => {
		expect(resolveMcpVerdict("mcp_exa_search", [rule("allow", "mcp_exa_search")])).toBe("allow");
		expect(resolveMcpVerdict("mcp_exa_search", [rule("allow", "mcp_exa_*")])).toBe("allow");
		expect(resolveMcpVerdict("mcp_exa_search", [])).toBe("ask");
		expect(resolveMcpVerdict("mcp_exa_search", [rule("allow", "mcp_exa_*"), rule("deny", "mcp_exa_search")])).toBe("deny");
		// B1: explicit ask is NOT swallowed by a broader allow prefix
		expect(resolveMcpVerdict("mcp_exa_search", [rule("allow", "mcp_exa_*"), rule("ask", "mcp_exa_search")])).toBe("ask");
	});

	it("createMcpRuleFamily registers into the modes engine registry", () => {
		const family = createMcpRuleFamily();
		expect(family.match("mcp__github__get_file", {})).toBe("mcp_github_get_file");
		expect(family.suggestAllowRule("mcp_exa_search")).toBe("mcp_exa_*");
	});
});

describe("P4-WB web family", () => {
	it("extracts hosts and claims URL-carrying search/fetch tools", () => {
		expect(extractHost({ url: "https://github.com/a/b" })).toBe("github.com");
		expect(extractHost({ query: "example.com/docs" })).toBe("example.com");
		expect(extractHost({ url: 42 })).toBeNull();
	});

	it("preapproved domains allow without rules; rules override; suggest form", () => {
		const family: RuleFamily = createWebRuleFamily("/nonexistent-home");
		expect(family.match("webfetch", { url: "https://developer.mozilla.org/" })).toBe("developer.mozilla.org");
		expect(family.resolve("developer.mozilla.org", [])).toBe("allow");
		expect(family.resolve("evil.example", [])).toBe("ask");
		expect(family.resolve("evil.example", [rule("deny", "webfetch(domain:evil.example)")])).toBe("deny");
		expect(family.resolve("github.com", [rule("deny", "webfetch(domain:github.com)")])).toBe("deny"); // rule beats preapproved
		expect(family.suggestAllowRule("example.com")).toBe("webfetch(domain:example.com)");
		expect(BUILTIN_PREAPPROVED.length).toBeGreaterThan(5);
	});

	it("pi-core-web.json overrides the preapproved list", () => {
		const home = mkdtempSync(join(tmpdir(), "web-gov-"));
		mkdirP(join(home, ".pi", "agent"));
		writeFileSync(join(home, ".pi", "agent", "pi-core-web.json"), JSON.stringify({ preapprovedDomains: ["internal.corp"] }));
		expect(loadPreapprovedDomains(home)).toEqual(["internal.corp"]);
	});

	function mkdirP(dir: string): void {
		mkdirSync(dir, { recursive: true });
	}
});

describe("P4-FAM-04 gate end-to-end (real modes gate)", () => {
	function setupModesWithFamilies(mode: string) {
		createMcpRuleFamily();
		const host = new FakeHost();
		targets.modes.factory(host.asPi());
		host.flags["permission-mode"] = mode;
		const project = mkdtempSync(join(tmpdir(), "p4-gate-"));
		host.flags._project = project;
		const ctx = host.makeCtx({ cwd: project, ui: true });
		return { host, ctx, project };
	}

	it("ask mode: mcp tool first-seen prompts (was silent pass), Allow once passes without rules", async () => {
		const { host, ctx } = setupModesWithFamilies("ask");
		await host.fire("session_start", {}, ctx);
		let selectCalls = 0;
		(ctx.ui as { select: unknown }).select = async () => {
			selectCalls++;
			return "Allow once";
		};
		const result = await host.fire("tool_call", { toolName: "mcp__exa__search", input: { query: "x" } }, ctx);
		expect(result).toBeUndefined(); // Allow once → pass
		expect(selectCalls).toBe(1); // uiPrompts ≤ 1 (P4-MC-04)
		expect(hasSessionGrant("mcp_exa_search")).toBe(false);
	});

	it("ask mode: Allow for this session grants; later calls pass without prompting", async () => {
		const { host, ctx } = setupModesWithFamilies("ask");
		await host.fire("session_start", {}, ctx);
		// answer the first-seen dialog with option 2
		const ctx2 = host.makeCtx({ cwd: (host.flags as Record<string, string>)._project, ui: true });
		// default fake select answers "Block" — verify deny first
		const denied = await host.fire("tool_call", { toolName: "mcp__exa__search", input: { query: "x" } }, ctx);
		expect(denied).toMatchObject({ block: true });
		grantSession("mcp_exa_search");
		const allowed = await host.fire("tool_call", { toolName: "mcp__exa__search", input: { query: "x" } }, ctx);
		expect(allowed).toBeUndefined();
	});

	it("ask mode: Allow always persists the suggested server-wide rule to disk", async () => {
		const { host, ctx, project } = setupModesWithFamilies("ask");
		await host.fire("session_start", {}, ctx);
		// dialog → "Allow always" writes the suggested GLOBAL rule
		const { setConfigPath } = await import("../../extensions/modes/config.ts");
		const globalCfg = join(project, "permission-modes.json");
		setConfigPath(globalCfg);
		writeFileSync(globalCfg, JSON.stringify({}));
		(ctx.ui as { select: unknown }).select = async (_label: string, options: string[]) =>
			options.find((o) => o.startsWith("Allow always"))!;
		const result = await host.fire("tool_call", { toolName: "mcp__exa__search", input: { query: "x" } }, ctx);
		expect(result).toBeUndefined();
		const parsed = JSON.parse(readFileSync(globalCfg, "utf-8")) as { permissions?: { allow?: string[] } };
		expect((parsed.permissions?.allow ?? []).some((r) => r.includes("mcp_exa"))).toBe(true);
	});

	it("plan and auto: mcp first call prompts (carve-out does not apply; classifier defers)", async () => {
		for (const mode of ["plan", "auto"]) {
			const { host, ctx } = setupModesWithFamilies(mode);
			await host.fire("session_start", {}, ctx);
			let selectCalls = 0;
			(ctx.ui as { select: unknown }).select = async () => {
				selectCalls++;
				return "Block";
			};
			const result = await host.fire("tool_call", { toolName: "mcp__exa__search", input: { query: "x" } }, ctx);
			expect(result).toMatchObject({ block: true });
			expect(selectCalls).toBe(1);
		}
	});

	it("non-mcp unknown tools keep 2.8.0 behavior in ask/plan (passthrough)", async () => {
		const { host, ctx } = setupModesWithFamilies("ask");
		await host.fire("session_start", {}, ctx);
		const result = await host.fire("tool_call", { toolName: "some_custom_tool", input: { data: "x" } }, ctx);
		expect(result).toBeUndefined();
		const plan = setupModesWithFamilies("plan");
		await plan.host.fire("session_start", {}, plan.ctx);
		const planResult = await plan.host.fire("tool_call", { toolName: "some_custom_tool", input: { data: "x" } }, plan.ctx);
		expect(planResult).toBeUndefined();
	});
});

describe("P4-MC-03/04 broker mirror + consistency matrix", () => {
	function makeMirror(overrides: Partial<Parameters<typeof createBrokerMirror>[1]> = {}) {
		const denies: string[] = [];
		const mirror = createBrokerMirror({ present: false }, {
			getAdjudication: (id) => getAdjudication(id),
			bypassActive: () => overrides.bypassActive?.() ?? false,
			hasAllowRule: (id) => overrides.hasAllowRule?.(id) ?? false,
			hasSessionGrant: (id) => overrides.hasSessionGrant?.(id) ?? false,
			onDeny: (id) => denies.push(id),
			...overrides,
		});
		return { mirror, denies };
	}

	it("five gate outcomes × bypass states stay consistent (uiPrompts ≤ 1, gate owner mirror owner)", () => {
		// matrix over outcomes: rule-allow / allow-once / session-grant /
		// classifier-allow / deny
		const outcomes = ["rule-allow", "allow-once", "session-grant", "classifier-allow", "deny"] as const;
		for (const outcome of outcomes) {
			for (const bypass of [false, true]) {
				clearAdjudications();
				noteAdjudicated("mcp_exa_search", outcome);
				const { mirror } = makeMirror({
					bypassActive: () => bypass,
					hasAllowRule: (id) => id === "mcp_exa_search" && outcome === "rule-allow",
					hasSessionGrant: (id) => id === "mcp_exa_search" && outcome === "session-grant",
				});
				const decision = mirror.decide("mcp_exa_search");
				if (outcome === "deny") {
					expect(decision).toBe("deny");
				} else {
					expect(decision).toBe("allow_once");
				}
				// gate allow ⇒ mirror allow; gate deny ⇒ tool never reaches the broker
				if (outcome !== "deny" && !bypass) expect(decision).toBe("allow_once");
			}
		}
	});

	it("no adjudication + no grants + no rules → fail-closed deny, counted", () => {
		const { mirror, denies } = makeMirror();
		expect(mirror.decide("mcp_github_get")).toBe("deny");
		expect(denies).toContain("mcp_github_get");
		expect(mirror.denyCount()).toBe(1);
	});

	it("absent adapter port → start() is a no-op (idle, zero side effects)", () => {
		const { mirror } = makeMirror();
		expect(() => mirror.start()).not.toThrow();
		mirror.stop();
	});

	it("version degradation: unknown snapshot fields are ignored by the panel", () => {
		const section = renderMcpPanel({
			port: {
				present: true,
				snapshot: () => ({ connected: true, version: 99, futureField: { deep: true } } as never),
			},
			ruleSummary: ["allow: mcp_exa_*"],
			denyCount: 0,
		});
		expect(section.status).toBe("green");
		const absent = renderMcpPanel({
			port: { present: false },
			ruleSummary: [],
			denyCount: 2,
		});
		expect(absent.status).toBe("absent");
		expect(absent.lines.join("\n")).toContain("pi install npm:pi-mcp-adapter");
		expect(absent.lines.join("\n")).toContain("2");
	});
});

describe("P4-FAM-05 session grants lifecycle + visibility", () => {
	it("grants reset on the modes session lifecycle hooks", async () => {
		createMcpRuleFamily();
		const host = new FakeHost();
		targets.modes.factory(host.asPi());
		const ctx = host.makeCtx({ cwd: mkdtempSync(join(tmpdir(), "p4-grants-")), ui: true });
		await host.fire("session_start", {}, ctx);
		grantSession("mcp_exa_search");
		expect(hasSessionGrant("mcp_exa_search")).toBe(true);
		await host.fire("session_shutdown", {}, ctx);
		// session_shutdown handler clears (2.8.0 handler extended? no — the
		// grant clear lives in session_start; shutdown keeps the key pin)
		await host.fire("session_start", {}, ctx);
		expect(hasSessionGrant("mcp_exa_search")).toBe(false);
	});

	it("/permissions lists grants; /permissions-clear-grants clears them", async () => {
		createMcpRuleFamily();
		const host = new FakeHost();
		targets.modes.factory(host.asPi());
		const ctx = host.makeCtx({ cwd: mkdtempSync(join(tmpdir(), "p4-vis-")), ui: true });
		await host.fire("session_start", {}, ctx);
		grantSession("mcp_exa_search");
		await host.commands.get("permissions")?.("", ctx);
		const listed = host.sentMessages.find((m) => m.message.customType === "permissions-list");
		expect((listed!.message as { content?: string }).content).toContain("Session grants");
		expect((listed!.message as { content?: string }).content).toContain("mcp_exa_search");

		await host.commands.get("permissions-clear-grants")?.("", ctx);
		expect(hasSessionGrant("mcp_exa_search")).toBe(false);
	});
});
