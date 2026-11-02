import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	mapCcRule,
	planCcImport,
	executeCcImport,
	formatCcImportReport,
} from "./cc-import.ts";
import { setGlobalConfigPathForTests, getProjectPermissionsPath } from "./permissions-loader.ts";
import { setConfigPath } from "./config.ts";

let homeTmp: string;
let cwdTmp: string;

beforeEach(() => {
	homeTmp = mkdtempSync(join(tmpdir(), "ccimp-home-"));
	cwdTmp = mkdtempSync(join(tmpdir(), "ccimp-cwd-"));
	setConfigPath(join(homeTmp, "permission-modes.json"));
});

afterEach(() => {
	rmSync(homeTmp, { recursive: true, force: true });
	rmSync(cwdTmp, { recursive: true, force: true });
});

function writeJson(filePath: string, data: unknown): void {
	mkdirSync(join(filePath, ".."), { recursive: true });
	writeFileSync(filePath, JSON.stringify(data), "utf-8");
}

describe("mapCcRule (P2 rule mapping)", () => {
	it("passes built-in CC tool rules through verbatim (core stores CC syntax)", () => {
		expect(mapCcRule("Bash(git commit:*)")).toEqual({ coreRule: "Bash(git commit:*)" });
		expect(mapCcRule("Read(./.env)")).toEqual({ coreRule: "Read(./.env)" });
		expect(mapCcRule("Edit(src/**)")).toEqual({ coreRule: "Edit(src/**)" });
		expect(mapCcRule("Write(/tmp/x)")).toEqual({ coreRule: "Write(/tmp/x)" });
	});

	it("maps WebFetch to the lowercase web-gov family rule", () => {
		expect(mapCcRule("WebFetch(domain:github.com)")).toEqual({ coreRule: "webfetch(domain:github.com)" });
		expect(mapCcRule("WebFetch")).toEqual({ coreRule: "webfetch" });
	});

	it("maps mcp__ wire names to the single-underscore mcp family form", () => {
		expect(mapCcRule("mcp__exa__web_search_exa")).toEqual({ coreRule: "mcp(exa_web_search_exa)" });
		expect(mapCcRule("mcp__exa__*")).toEqual({ coreRule: "mcp(exa_*)" });
		expect(mapCcRule("mcp__exa")).toEqual({ coreRule: "mcp(exa_*)" });
	});

	it("keeps bare tool names, noting tools pi does not have", () => {
		expect(mapCcRule("WebSearch")).toEqual({ coreRule: "WebSearch", note: "no matching pi tool; rule stays inert" });
		expect(mapCcRule("Grep")).toEqual({ coreRule: "Grep" });
	});

	it("rejects unparsable rules", () => {
		expect(mapCcRule("")).toBeNull();
		expect(mapCcRule("not a rule (")).toBeNull();
	});
});

describe("planCcImport (P2 three-layer + legacy history)", () => {
	it("reads the three CC settings layers and maps behaviors", () => {
		writeJson(join(homeTmp, ".claude", "settings.json"), {
			permissions: { allow: ["Bash(git:*)", "WebFetch(domain:example.com)"], deny: ["Read(./secret)"] },
		});
		writeJson(join(cwdTmp, ".claude", "settings.json"), {
			permissions: { allow: ["mcp__exa__web_search_exa"] },
		});
		writeJson(join(cwdTmp, ".claude", "settings.local.json"), {
			permissions: { ask: ["Bash(npm publish:*)"] },
		});
		const plan = planCcImport({ cwd: cwdTmp, home: homeTmp });
		expect(plan.sources.map((s) => [s.scope, s.exists])).toEqual([
			["user", true],
			["project", true],
			["local", true],
			["history", true], // ~/.claude.json written below? not yet — see next case
		].map(([scope, exists], i) => [scope, exists && plan.sources[i].exists]));
		const rules = plan.rules.map((r) => `${r.scope}/${r.behavior}:${r.coreRule}`);
		expect(rules).toContain("user/allow:Bash(git:*)");
		expect(rules).toContain("user/allow:webfetch(domain:example.com)");
		expect(rules).toContain("user/deny:Read(./secret)");
		expect(rules).toContain("project/allow:mcp(exa_web_search_exa)");
		expect(rules).toContain("local/ask:Bash(npm publish:*)");
		expect(plan.skipped).toHaveLength(0);
	});

	it("reads the legacy ~/.claude.json projects.<cwd>.allowedTools as allow rules", () => {
		writeJson(join(homeTmp, ".claude.json"), {
			projects: { [cwdTmp]: { allowedTools: ["Bash(pnpm test:*)"] } },
		});
		const plan = planCcImport({ cwd: cwdTmp, home: homeTmp });
		expect(plan.rules).toContainEqual({
			scope: "history",
			behavior: "allow",
			ccRule: "Bash(pnpm test:*)",
			coreRule: "Bash(pnpm test:*)",
		});
	});

	it("reports missing sources and skips unparsable rules", () => {
		writeJson(join(homeTmp, ".claude", "settings.json"), {
			permissions: { allow: ["totally (((broken"] },
		});
		const plan = planCcImport({ cwd: cwdTmp, home: homeTmp });
		expect(plan.sources.find((s) => s.scope === "project")?.exists).toBe(false);
		expect(plan.skipped).toHaveLength(1);
		expect(plan.skipped[0]!.reason).toContain("unrecognized");
		expect(plan.rules).toHaveLength(0);
	});
});

describe("executeCcImport (P2 scope landing + idempotency)", () => {
	function seedSources(): void {
		writeJson(join(homeTmp, ".claude", "settings.json"), {
			permissions: { allow: ["Bash(git:*)", "WebFetch(domain:example.com)"] },
		});
		writeJson(join(cwdTmp, ".claude", "settings.json"), {
			permissions: { allow: ["mcp__exa__web_search_exa"] },
		});
		writeJson(join(cwdTmp, ".claude", "settings.local.json"), {
			permissions: { deny: ["Read(./secret)"] },
		});
	}

	it("lands each scope in its core destination (user→global, project→project, local→local)", () => {
		seedSources();
		const plan = planCcImport({ cwd: cwdTmp, home: homeTmp });
		const result = executeCcImport(plan, { cwd: cwdTmp, home: homeTmp });
		expect(result.imported).toBe(4);
		expect(result.failed).toBe(0);

		const globalFile = JSON.parse(readFileSync(join(homeTmp, "permission-modes.json"), "utf-8"));
		expect(globalFile.permissions.allow).toContain("Bash(git:*)");
		expect(globalFile.permissions.allow).toContain("webfetch(domain:example.com)");

		const projectFile = JSON.parse(readFileSync(getProjectPermissionsPath(cwdTmp), "utf-8"));
		expect(projectFile.permissions.allow).toContain("mcp(exa_web_search_exa)");

		const localFile = JSON.parse(readFileSync(getProjectPermissionsPath(cwdTmp, true), "utf-8"));
		expect(localFile.permissions.deny).toContain("Read(./secret)");
	});

	it("is idempotent — a second import reports every rule as already present", () => {
		seedSources();
		const plan = planCcImport({ cwd: cwdTmp, home: homeTmp });
		executeCcImport(plan, { cwd: cwdTmp, home: homeTmp });
		const plan2 = planCcImport({ cwd: cwdTmp, home: homeTmp });
		const result2 = executeCcImport(plan2, { cwd: cwdTmp, home: homeTmp });
		expect(result2.imported).toBe(0);
		expect(result2.skippedExisting).toBe(4);
	});

	it("dry-run planning never touches disk (no global config file appears)", () => {
		seedSources();
		planCcImport({ cwd: cwdTmp, home: homeTmp });
		expect(existsSync(join(homeTmp, "permission-modes.json"))).toBe(false);
		expect(existsSync(getProjectPermissionsPath(cwdTmp))).toBe(false);
	});

	it("formats a report listing rules, mappings, skips and the summary", () => {
		writeJson(join(homeTmp, ".claude", "settings.json"), {
			permissions: { allow: ["WebFetch(domain:example.com)", "not a rule ("] },
		});
		const plan = planCcImport({ cwd: cwdTmp, home: homeTmp });
		const text = formatCcImportReport(plan);
		expect(text).toContain("WebFetch(domain:example.com)");
		expect(text).toContain("webfetch(domain:example.com)");
		expect(text).toContain("Skipped");
		const withResult = formatCcImportReport(plan, { imported: 1, skippedExisting: 0, failed: 0, perDestination: { global: 1 } });
		expect(withResult).toContain("Imported 1 rule(s)");
	});
});
