/**
 * plan-gate.test.ts — T12 (SPEC 2026-10-07 P0-1 §5): the pure plan hard-limit
 * function. One case per hard-limit class + the plan-legal allowlist returns
 * undefined. No mode parameter: planHardBlock is only called under plan mode.
 */
import { describe, expect, it } from "vitest";
import { planHardBlock, type PlanGateFacts } from "./plan-gate.ts";

const facts = (over: Partial<PlanGateFacts> = {}): PlanGateFacts => ({
	planFilePath: "/home/u/proj/.pi/projects/x/plan.md",
	isPlanFile: false,
	mcpShaped: false,
	familyClaimed: false,
	fusionSchemaHint: "",
	...over,
});

describe("planHardBlock (T12)", () => {
	it("codemode is blocked (it can execute other tools)", () => {
		const r = planHardBlock("codemode", { script: "return 1" }, facts());
		expect(r).toMatchObject({ block: true });
		expect(r!.reason).toContain("codemode is not available");
	});

	it("edit outside the plan file is blocked with the plan-file reason", () => {
		const r = planHardBlock("edit", { path: "src/a.ts" }, facts());
		expect(r).toMatchObject({ block: true });
		expect(r!.reason).toContain("may be edited");
	});

	it("edit on the plan file passes the path limit (embedded scan still applies)", () => {
		expect(planHardBlock("edit", { path: "plan.md" }, facts({ isPlanFile: true }))).toBeUndefined();
	});

	it("edit with an empty path is blocked", () => {
		expect(planHardBlock("edit", { path: "" }, facts({ isPlanFile: false }))).toMatchObject({ block: true });
	});

	it("unsafe bash is blocked with the read-only reason", () => {
		const r = planHardBlock("bash", { command: "npm run build" }, facts());
		expect(r).toMatchObject({ block: true });
		expect(r!.reason).toContain("read-only commands only");
		expect(r!.reason).toContain("npm run build");
	});

	it("safe bash passes", () => {
		expect(planHardBlock("bash", { command: "ls -la" }, facts())).toBeUndefined();
	});

	it("unclaimed MCP-shaped call is denied (D2c fail-closed)", () => {
		const r = planHardBlock("mcp__exa__search", { query: "x" }, facts({ mcpShaped: true }));
		expect(r).toMatchObject({ block: true });
		expect(r!.reason).toContain("MCP tool mcp__exa__search is not available");
	});

	it("family-claimed MCP call is NOT hard-blocked (family verdict adjudicates, D2b)", () => {
		const r = planHardBlock("mcp__exa__search", { command: "rm -rf /" }, facts({ mcpShaped: true, familyClaimed: true }));
		expect(r).toBeUndefined();
	});

	it("family claim does NOT exempt the built-in edit path limit", () => {
		const r = planHardBlock("edit", { path: "src/a.ts" }, facts({ familyClaimed: true, mcpShaped: true }));
		expect(r).toMatchObject({ block: true });
		expect(r!.reason).toContain("may be edited");
	});

	it("unknown non-MCP tool with an unsafe embedded command is blocked (schema hint appended)", () => {
		const r = planHardBlock("sometool", { then_run: "rm -rf /tmp/x" }, facts({ fusionSchemaHint: "\n  (tool schema declares command fields: then_run)" }));
		expect(r).toMatchObject({ block: true });
		expect(r!.reason).toContain("read-only commands only");
		expect(r!.reason).toContain("tool schema declares command fields");
	});

	it("unknown non-MCP tool with a safe embedded command passes", () => {
		expect(planHardBlock("sometool", { then_run: "ls" }, facts())).toBeUndefined();
	});

	it("read tools and tool_search pass (plan allowlist)", () => {
		expect(planHardBlock("read", { path: "a.ts" }, facts())).toBeUndefined();
		expect(planHardBlock("grep", { pattern: "x" }, facts())).toBeUndefined();
		expect(planHardBlock("tool_search", { query: "x" }, facts())).toBeUndefined();
	});
});
