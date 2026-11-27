import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createAdjudicationFacts } from "./adjudication-facts.ts";
import { loadMergedPermissionRules } from "./permissions-loader.ts";
import { setConfigPath } from "./config.ts";
import { getPlanFilePath } from "./plan.ts";
import type { PermissionMode } from "./mode-prompt.ts";
import { createMcpRuleFamily } from "../mcp-gov/family.ts";
import {
	clearRuleFamilies,
	clearSessionGrants,
} from "./rule-families.ts";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

describe("adjudication facts raw pins (SR-4c)", () => {
	let project: string;
	let configTmp: string;

	beforeEach(() => {
		clearRuleFamilies();
		clearSessionGrants();
		project = mkdtempSync(join(tmpdir(), "adj-facts-proj-"));
		configTmp = mkdtempSync(join(tmpdir(), "adj-facts-cfg-"));
		const cfgPath = join(configTmp, "permission-modes.json");
		setConfigPath(cfgPath);
		writeFileSync(
			cfgPath,
			JSON.stringify({
				permissions: { deny: ["Read(./.env)"] },
				classifier: { enabled: false },
			}),
		);
	});

	afterEach(() => {
		clearRuleFamilies();
		clearSessionGrants();
		rmSync(project, { recursive: true, force: true });
		rmSync(configTmp, { recursive: true, force: true });
	});

	function makeFacts(getMode: () => PermissionMode) {
		return createAdjudicationFacts({
			getAllTools: () => [],
			getMode,
			getMergedRules: () => loadMergedPermissionRules(project),
			getAutoModeConfig: () => undefined,
			describeTier3Review: () => "<t3>",
			isMemoryDirWrite: () => false,
		});
	}

	function collect(
		getMode: () => PermissionMode,
		tool: string,
		input: Record<string, unknown>,
	) {
		const ctx = { cwd: project, hasUI: false } as unknown as ExtensionContext;
		return makeFacts(getMode).collectAdjudicationFacts({ ctx, tool, input });
	}

	it("plan mode: edit of a non-plan file is hard-blocked with the plan-path reason", () => {
		const f = collect(
			() => "plan",
			"edit",
			{ path: "src/a.ts", oldString: "x", newString: "y" },
		);
		expect(f.mode).toEqual("plan");
		expect(f.planHardBlock).toEqual({
			block: true,
			reason: `Plan mode: only ${getPlanFilePath(project)} may be edited.`,
		});
		expect(f.family).toEqual(null);
	});

	it("plan mode: edit of the plan file is NOT hard-blocked (planHardBlock undefined)", () => {
		const f = collect(
			() => "plan",
			"edit",
			{ path: getPlanFilePath(project), oldString: "x", newString: "y" },
		);
		expect(f.mode).toEqual("plan");
		expect(f.path).toEqual(getPlanFilePath(project));
		expect(f.planHardBlock).toBeUndefined();
	});

	it("bypass: `cat .env > /tmp/e` hits the Read(./.env) deny rule (bashDenyRule)", () => {
		const f = collect(
			() => "bypass",
			"bash",
			{ command: "cat .env > /tmp/e" },
		);
		expect(f.mode).toEqual("bypass");
		expect(f.bashDenyRule).toEqual(
			'Denied by permission rule [global]: Read(./.env) — bash references denied path ".env". Adjust the rule, or scope/disable via bashPathChecks / PI_CORE_BASH_PATH_CHECKS.',
		);
		expect(f.bashTiers).toEqual({ safe: false, autoApprovable: false });
		expect(f.commandSensitive).toBe(true);
	});

	it("bypass: `echo … >> ~/.bashrc` sets the W3 bashPathCheck redirect target", () => {
		const f = collect(
			() => "bypass",
			"bash",
			{ command: "echo alias x=1 >> ~/.bashrc" },
		);
		expect(f.mode).toEqual("bypass");
		expect(f.bashPathCheck).toEqual({ path: "~/.bashrc", kind: "redirect" });
		expect(f.bashProtectedWrite).toEqual(null);
	});

	it("ask: edit with then_run 'npm install' surfaces the embedded command as unsafe", () => {
		const f = collect(
			() => "ask",
			"edit",
			{ path: "src/a.ts", oldString: "x", newString: "y", then_run: "npm install" },
		);
		expect(f.mode).toEqual("ask");
		expect(f.embeddedCommands).toEqual(["npm install"]);
		expect(f.embeddedUnsafe).toEqual([true]);
		expect(f.embeddedAuto).toEqual([
			{ command: "npm install", sensitive: false, safe: false, autoApprovable: false },
		]);
	});

	it("auto: `npm run build` classifies as tier-2 (unsafe but auto-approvable)", () => {
		const f = collect(() => "auto", "bash", { command: "npm run build" });
		expect(f.mode).toEqual("auto");
		expect(f.bashTiers).toEqual({ safe: false, autoApprovable: true });
		expect(f.commandSafe).toBe(false);
	});

	it("mcp family call after createMcpRuleFamily(): family facts pin canonicalId + suggestedRule", () => {
		createMcpRuleFamily();
		const f = collect(
			() => "ask",
			"mcp__exa__search",
			{ query: "x" },
		);
		expect(f.mode).toEqual("ask");
		expect(f.family).toEqual({
			canonicalId: "mcp_exa_search",
			suggestedRule: "mcp_exa_*",
			hasExplicitAskRule: false,
		});
		expect(f.familySessionGrant).toBe(false);
	});
});
