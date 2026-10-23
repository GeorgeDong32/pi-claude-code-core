/**
 * cc-panels.test.ts — 2026-10-20 notification CC-ification: the shared CC
 * visual primitives (cc-rows) and every per-customType shaper, pinned against
 * the prototype-page decisions. Pass-through theme keeps assertions on plain
 * text and structure only (same pattern as review's directive tests).
 */
import { describe, expect, it } from "vitest";
import {
	ccBodyBlock,
	ccCommandBar,
	ccPanel,
	ccSingleRow,
	ccSummaryRow,
	CLIP_LINES,
} from "../../extensions/ui/cc-rows.ts";
import {
	CC_PANEL_SHAPERS,
	panelRenderer,
	registerCcPanels,
	shapeCoreStatus,
	shapeMemoryStatus,
	shapeModelProfiles,
	shapeModesExecute,
	shapeOutsideWrites,
	shapePermissions,
	shapePlanComplete,
	shapeReviewAgents,
	shapeRulesActivate,
	shapeRulesList,
} from "../../extensions/ui/cc-panels.ts";

const passthroughTheme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
};

/** Strip SGR sequences + NBSP padding for structural assertions. */
const strip = (row: string): string => row.replace(/\x1b\[[0-9;]*m/g, "").replace(/\u00A0+$/, "");

describe("cc-rows primitives", () => {
	it("command bar: one row, dim ❯ + command text, spans the width, no [customType] box", () => {
		const rows = ccCommandBar("/core", passthroughTheme).render(40);
		expect(rows).toHaveLength(1);
		expect(strip(rows[0]!)).toMatch(/^❯ \/core$/);
		expect(rows[0]).not.toContain("[pi-core-status]");
		// NBSP padding fills the row so the background spans the full width
		expect(rows[0]!.includes("\u00A0")).toBe(true);
	});

	it("summary row: ⏺ + bold summary, truncated to the viewport", () => {
		const rows = ccSummaryRow("mcp-gov · green", passthroughTheme).render(40);
		expect(rows).toHaveLength(1);
		expect(strip(rows[0]!)).toBe("⏺ mcp-gov · green");
		const narrow = ccSummaryRow("x".repeat(60), passthroughTheme).render(30);
		expect(strip(narrow[0]!).endsWith("…")).toBe(true);
	});

	it("single row: ⏺ + title + colored tail (plan-complete terminal row)", () => {
		const rows = ccSingleRow("Plan Complete", passthroughTheme, { text: " ✓", color: "success" }).render(40);
		expect(rows).toHaveLength(1);
		expect(strip(rows[0]!)).toBe("⏺ Plan Complete ✓");
	});

	it("body block: ⎿ gutter on the first row, 5-space continuation, wrapped to width", () => {
		const rows = ccBodyBlock(["line one", "line two", "y".repeat(100)], passthroughTheme, true).render(60);
		expect(strip(rows[0]!)).toMatch(/^ {2}⎿ {2}line one$/);
		expect(strip(rows[1]!)).toMatch(/^ {5}line two$/);
		// the long line wrapped: every row stays within the viewport
		for (const row of rows) {
			expect([...strip(row)].length).toBeLessThanOrEqual(60);
		}
	});

	it("body block: strong lead-in stays white, rest painted toolOutput", () => {
		const rows = ccBodyBlock([{ strong: "fast (active)", rest: ": ask glm/5.3-flash" }], passthroughTheme, true).render(60);
		expect(strip(rows[0]!)).toBe("  ⎿  fast (active): ask glm/5.3-flash");
	});

	it("body block: collapsed bodies past CLIP_LINES clip with a ctrl+o hint; expanded renders all", () => {
		const many = Array.from({ length: CLIP_LINES + 8 }, (_, i) => `row ${i}`);
		const collapsed = ccBodyBlock(many, passthroughTheme, false).render(60);
		expect(collapsed).toHaveLength(CLIP_LINES + 1);
		expect(strip(collapsed[collapsed.length - 1]!)).toBe(`     … +8 more lines (ctrl+o to expand)`);
		const expanded = ccBodyBlock(many, passthroughTheme, true).render(60);
		expect(expanded).toHaveLength(CLIP_LINES + 8);
	});

	it("panel assembly: bar → ⏺ summary → ⎿ body; each part skippable", () => {
		const full = ccPanel({ bar: "/core", summary: "mcp-gov", body: ["a"] }, passthroughTheme, true).render(60);
		expect(full).toHaveLength(3);
		expect(strip(full[0]!)).toMatch(/^❯ \/core$/);
		expect(strip(full[1]!)).toBe("⏺ mcp-gov");
		expect(strip(full[2]!)).toBe("  ⎿  a");
		const degraded = ccPanel({ body: ["just body"] }, passthroughTheme, true).render(60);
		expect(degraded).toHaveLength(1);
		expect(strip(degraded[0]!)).toBe("  ⎿  just body");
		const empty = ccPanel({}, passthroughTheme, true).render(60);
		expect(empty).toHaveLength(0);
	});
});

describe("shapers — command-panel family", () => {
	it("shapeCoreStatus: panel form (status header + mcp lead bullet)", () => {
		const parts = shapeCoreStatus({
			content: "# /core — mcp-gov [green]\n\n- mcp: adapter connected (v1), servers: exa\n- allow: mcp__exa__web_search_exa\n- mirror deny count: 0",
			details: { command: "/core" },
		});
		expect(parts).toEqual({
			bar: "/core",
			summary: "mcp-gov · green — adapter connected (v1), servers: exa",
			body: ["allow: mcp__exa__web_search_exa", "mirror deny count: 0"],
		});
	});

	it("shapeCoreStatus: exposure form (result line split into summary + dim note)", () => {
		const parts = shapeCoreStatus({
			content: '# /core — mcp-gov\n\n- exposure of "exa" → codemode (takes effect after /reload or a restart)',
			details: { command: "/core exposure exa codemode" },
		});
		expect(parts).toEqual({
			bar: "/core exposure exa codemode",
			summary: 'exposure of "exa" → codemode',
			body: ["takes effect after /reload or a restart"],
		});
	});

	it("shapeCoreStatus: error result degrades (summary = section, body verbatim)", () => {
		const parts = shapeCoreStatus({
			content: "# /core — mcp-gov\n\n- usage: /core exposure <server> <codemode|deferred|direct|hidden>",
			details: { command: "/core exposure" },
		});
		expect(parts.summary).toBe("mcp-gov");
		expect(parts.body).toEqual(["usage: /core exposure <server> <codemode|deferred|direct|hidden>"]);
	});

	it("shapeMemoryStatus: import report (first line = summary)", () => {
		const parts = shapeMemoryStatus({
			content: "memory-import-claude: copied 12, skipped 3 (idempotent)\nnote one",
			details: { command: "/memory-import-claude" },
		});
		expect(parts).toEqual({
			bar: "/memory-import-claude",
			summary: "memory-import-claude: copied 12, skipped 3 (idempotent)",
			body: ["note one"],
		});
	});

	it("shapeMemoryStatus: /memory diagnostics (file counts feed the summary, full dump stays in body)", () => {
		const content = [
			"user memory: /u — files: 12, skipped: 0, index: 100/200 bytes",
			"project memory: /p — files: 34, skipped: 1, index: 300/400 bytes",
			"recall: off — set memory.recallModel",
		].join("\n");
		const parts = shapeMemoryStatus({ content, details: { command: "/memory" } });
		expect(parts.summary).toBe("memory: user 12 files · project 34 files");
		expect(parts.body).toHaveLength(3);
	});

	it("shapeMemoryStatus: unknown shape degrades to body only", () => {
		const parts = shapeMemoryStatus({ content: "something else" });
		expect(parts.summary).toBeUndefined();
		expect(parts.bar).toBeUndefined();
		expect(parts.body).toEqual(["something else"]);
	});

	it("shapeReviewAgents: roster with gate/routing summary and strong agent ids", () => {
		const content = [
			"- **reviewer-a** (5.3-flash) — enabled",
			"  - model: glm/5.3-flash",
			"  - thinking: high",
			"- **reviewer-b** (5.3-flash) — disabled",
			"  - model: glm/5.3-flash",
			"  - thinking: low",
			"",
			"Gate: glm/5.3-flash · threshold 6 · policy strict",
			"Routing: parallel",
		].join("\n");
		const parts = shapeReviewAgents({ content, details: { command: "/review-agents" } });
		expect(parts.summary).toBe("review agents: 1 enabled · gate glm/5.3-flash · threshold 6 · policy strict · parallel");
		expect(parts.body).toEqual([
			{ strong: "reviewer-a", rest: " (5.3-flash) — enabled · glm/5.3-flash · thinking high" },
			{ strong: "reviewer-b", rest: " (5.3-flash) — disabled · glm/5.3-flash · thinking low" },
		]);
	});

	it("shapeModelProfiles: count summary, active profile line keeps a strong lead-in", () => {
		const parts = shapeModelProfiles({
			content: "Model profiles:\nfast (active): ask:glm/5.3-flash plan:- auto:- bypass:-\ndeep: ask:glm/5.5 plan:glm/5.5 auto:- bypass:-",
			details: { command: "/model-profile" },
		});
		expect(parts.summary).toBe("model profiles: 2");
		expect(parts.body).toEqual([
			{ strong: "fast (active)", rest: ": ask:glm/5.3-flash plan:- auto:- bypass:-" },
			"deep: ask:glm/5.5 plan:glm/5.5 auto:- bypass:-",
		]);
	});

	it("shapePermissions: behavior counts + session grants summary, fences flatten into the body", () => {
		const content = [
			"**Permission rules**",
			"",
			"```",
			"allow:",
			"  [global] Bash(git diff:*)",
			"deny:",
			"  [global] Read(./.env*)",
			"```",
			"",
			"**Session grants** (this session only)",
			"",
			"```",
			"bash(git push) until 14:32",
			"```",
			"Clear with: /permissions-clear-grants",
		].join("\n");
		const parts = shapePermissions({ content, details: { command: "/permissions" } });
		expect(parts.summary).toBe("permission rules: 1 allow · 0 ask · 1 deny · 1 session grant");
		expect(parts.body).toContain("  [global] Bash(git diff:*)");
		expect(parts.body).toContain("bash(git push) until 14:32");
		expect(parts.body).toContain("clear with /permissions-clear-grants");
	});

	it("shapeOutsideWrites: count from the first line, snapshots as body", () => {
		const parts = shapeOutsideWrites({
			content: "Tracked outside-cwd writes (2):\n2026-10-20 14:32:10 · Write · /tmp/x (would restore)\n2026-10-20 14:33:00 · Edit · /tmp/y (would delete)",
			details: { command: "/outside-writes" },
		});
		expect(parts).toEqual({
			bar: "/outside-writes",
			summary: "tracked outside-cwd writes: 2",
			body: ["2026-10-20 14:32:10 · Write · /tmp/x (would restore)", "2026-10-20 14:33:00 · Edit · /tmp/y (would delete)"],
		});
	});

	it("shapeRulesList: the shaper-side summary line gets middot separators", () => {
		const parts = shapeRulesList({
			content: "rules: 6 inline, 14 indexed, 8432/12000 chars, 9 activated this session\n\n### repo-conventions (inline)\n- tab indent",
			details: { command: "/rules" },
		});
		expect(parts.summary).toBe("rules: 6 inline · 14 indexed · 8432/12000 chars · 9 activated this session");
		expect(parts.body).toEqual(["### repo-conventions (inline)", "- tab indent"]);
	});
});

describe("shapers — special forms", () => {
	it("shapeModesExecute: synthetic approval bar + numbered steps + tag note", () => {
		const parts = shapeModesExecute({
			content: "Execute the plan now. Steps:\n1. port the shimmer function\n2. wire it into the spinner\n\nStart with step 1. After finishing each step, include a [DONE:n] tag in your reply.",
		});
		expect(parts).toEqual({
			bar: "Execute the plan now — 2 steps (plan approved)",
			body: ["1. port the shimmer function", "2. wire it into the spinner", "start with step 1 · tag each finished step [DONE:n]"],
		});
		expect(parts.summary).toBeUndefined();
	});

	it("shapeModesExecute: no numbered steps degrades to body only", () => {
		const parts = shapeModesExecute({ content: "no steps here" });
		expect(parts.bar).toBeUndefined();
		expect(parts.body).toEqual(["no steps here"]);
	});

	it("shapePlanComplete: fixed single terminal row", () => {
		expect(shapePlanComplete({ content: "**Plan Complete!** ✓" })).toEqual({
			single: { title: "Plan Complete", tail: { text: " ✓", color: "success" } },
		});
	});

	it("shapeRulesActivate: dim ⎿ block only — no bar, no summary", () => {
		const parts = shapeRulesActivate({ content: "[AR1005] never throw from render callbacks" });
		expect(parts).toEqual({ body: ["[AR1005] never throw from render callbacks"] });
		expect(parts.bar).toBeUndefined();
		expect(parts.summary).toBeUndefined();
	});
});

describe("renderer safety + registration", () => {
	it("panelRenderer: a throwing shaper returns undefined (native box fallback)", () => {
		const renderer = panelRenderer(() => {
			throw new Error("boom");
		});
		expect(renderer({ content: "x" }, { expanded: false, outputPad: 1 }, passthroughTheme)).toBeUndefined();
	});

	it("panelRenderer: assembles a full panel through ccPanel", () => {
		const renderer = panelRenderer(shapeCoreStatus);
		const rows = renderer(
			{ content: "# /core — mcp-gov [green]\n\n- mcp: adapter connected, servers: exa", details: { command: "/core" } },
			{ expanded: false, outputPad: 1 },
			passthroughTheme,
		)!.render(60);
		expect(strip(rows[0]!)).toBe("❯ /core");
		expect(strip(rows[1]!)).toBe("⏺ mcp-gov · green — adapter connected, servers: exa");
	});

	it("registerCcPanels: registers all 10 core-owned customTypes exactly once", () => {
		const registered = new Map<string, unknown>();
		const fakePi = {
			registerMessageRenderer(customType: string, renderer: unknown) {
				if (registered.has(customType)) throw new Error(`duplicate: ${customType}`);
				registered.set(customType, renderer);
			},
		};
		registerCcPanels(fakePi);
		expect([...registered.keys()].sort()).toEqual(
			[
				"model-profile-list",
				"modes-execute",
				"outside-writes-list",
				"permissions-list",
				"pi-core-status",
				"pi-memory-status",
				"pi-review-agents",
				"pi-rules-activate",
				"pi-rules-list",
				"plan-complete",
			].sort(),
		);
		// the shaper table and the registration set stay in lockstep
		expect(Object.keys(CC_PANEL_SHAPERS)).toHaveLength(registered.size);
	});

	it("goal/review-owned types are NOT in the shaper table (first-wins, no squatting)", () => {
		for (const foreign of ["pi-goal-event", "pi-goal-audit-event", "pi-review"]) {
			expect(CC_PANEL_SHAPERS).not.toHaveProperty(foreign);
		}
	});
});
