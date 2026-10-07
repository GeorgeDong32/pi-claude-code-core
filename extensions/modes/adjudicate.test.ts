/**
 * adjudicate.test.ts — the DECIDE decision table (SPEC 2026-10-07 P2-1 §5).
 * Pure inputs -> expected Decision, no FakeHost, no pi. Behavior parity of
 * the assembled gate (decide + interpret through the real factory) is pinned
 * separately by test/lib/adjudication-parity.test.ts against the golden
 * fixture generated from the pre-refactor baseline.
 */
import { describe, expect, it } from "vitest";
import { decide, type AdjudicationFacts } from "./adjudicate.ts";

const allow = { behavior: "allow", rule: "Edit(src/**)", source: "global" } as const;
const ask = { behavior: "ask", rule: "Edit(src/**)", source: "global" } as const;
const deny = { behavior: "deny", rule: "Edit(src/**)", source: "global" } as const;

function facts(patch: Partial<AdjudicationFacts>): AdjudicationFacts {
	return {
		mode: "ask",
		tool: "read",
		input: {},
		hasUI: true,
		cwd: "/w",
		verdict: { behavior: "passthrough" },
		family: null,
		familySessionGrant: false,
		embeddedCommands: [],
		embeddedUnsafe: [],
		embeddedHint: "",
		path: "",
		pathSensitive: false,
		pathOutsideCwd: false,
		pathIsMemoryDir: false,
		command: "",
		commandSafe: false,
		...patch,
	};
}

describe("decide: bypass", () => {
	it("approves everything; edit/write carry outside-write tracking", () => {
		expect(decide(facts({ mode: "bypass", tool: "bash", input: { command: "rm -rf /" } })))
			.toEqual({ kind: "allow", effects: {} });
		expect(decide(facts({ mode: "bypass", tool: "edit" })))
			.toEqual({ kind: "allow", effects: { trackOutsideWrite: true } });
	});
});

describe("decide: rule layer", () => {
	it("deny is terminal and precedes plan/mode logic", () => {
		expect(decide(facts({ verdict: deny, mode: "plan", tool: "edit" })))
			.toEqual({ kind: "deny", reason: "Denied by permission rule [global]: Edit(src/**)" });
	});
	it("allow verdict: effects only for edit/write + family claims", () => {
		expect(decide(facts({ verdict: allow, tool: "edit" })))
			.toEqual({ kind: "allow", effects: { trackOutsideWrite: true } });
		expect(decide(facts({ verdict: allow, tool: "read" })))
			.toEqual({ kind: "allow", effects: {} });
		expect(decide(facts({
			verdict: allow,
			tool: "mcp__exa__search",
			family: { canonicalId: "mcp_exa_search", suggestedRule: "mcp_exa_*", hasExplicitAskRule: false },
			familySessionGrant: false,
		}))).toEqual({ kind: "allow", effects: { familyAdjudication: "rule-allow" } });
		expect(decide(facts({
			verdict: allow,
			tool: "mcp__exa__search",
			family: { canonicalId: "mcp_exa_search", suggestedRule: "mcp_exa_*", hasExplicitAskRule: false },
			familySessionGrant: true,
		}))).toEqual({ kind: "allow", effects: { familyAdjudication: "session-grant" } });
	});
	it("ask verdict: first-seen beats the plain permission prompt; explicit ask rule does not", () => {
		expect(decide(facts({
			verdict: ask,
			family: { canonicalId: "mcp_exa_search", suggestedRule: "mcp_exa_*", hasExplicitAskRule: false },
		}))).toEqual({ kind: "firstSeen", canonicalId: "mcp_exa_search", suggestedRule: "mcp_exa_*" });
		expect(decide(facts({
			verdict: ask,
			family: { canonicalId: "mcp_exa_search", suggestedRule: "mcp_exa_*", hasExplicitAskRule: true },
		}))).toEqual({
			kind: "prompt",
			flavor: "permission-options",
			label: "permission rule requires approval: Edit(src/**)",
			category: "permission-ask",
		});
	});
});

describe("decide: plan", () => {
	it("hard limits deny ahead of the allowlist and cannot be unlocked by allow rules", () => {
		expect(decide(facts({ mode: "plan", verdict: allow, tool: "edit", planHardBlock: { block: true, reason: "Plan mode: only plan.md may be edited." } })))
			.toEqual({ kind: "deny", reason: "Plan mode: only plan.md may be edited." });
	});
	it("allowlist passes read tools, tool_search and the default once hard limits cleared", () => {
		for (const tool of ["read", "tool_search", "my_custom_tool"]) {
			expect(decide(facts({ mode: "plan", tool }))).toEqual({ kind: "allow", effects: {} });
		}
	});
});

describe("decide: embedded commands (ask only)", () => {
	it("one unsafe embedded command prompts with the full list + hint", () => {
		expect(decide(facts({
			mode: "ask",
			tool: "edit",
			embeddedCommands: ["npm install", "echo hi"],
			embeddedUnsafe: [true, false],
			embeddedHint: " (hint)",
		}))).toEqual({
			kind: "prompt",
			flavor: "approval",
			label: '"npm install", "echo hi" (hint)',
		});
	});
	it("plan mode ignores embedded safety (plan-gate owns it) and auto defers to legacy", () => {
		expect(decide(facts({ mode: "plan", embeddedCommands: ["npm install"], embeddedUnsafe: [true] })))
			.toEqual({ kind: "allow", effects: {} });
		expect(decide(facts({ mode: "auto", embeddedCommands: ["npm install"], embeddedUnsafe: [true] })))
			.toEqual({ kind: "legacyAuto" });
	});
});

describe("decide: ask dispatch", () => {
	it("read outside cwd prompts; inside passes", () => {
		expect(decide(facts({ tool: "read", path: "/etc/hosts", pathOutsideCwd: true })))
			.toEqual({ kind: "prompt", flavor: "approval", label: 'outside cwd on "/etc/hosts"' });
		expect(decide(facts({ tool: "read", path: "src/a.ts" }))).toEqual({ kind: "allow", effects: {} });
	});
	it("edit/write: memory carve-out allows; headless takes approval; UI takes the 5-choice dialog", () => {
		expect(decide(facts({ tool: "edit", pathIsMemoryDir: true }))).toEqual({ kind: "allow", effects: {} });
		expect(decide(facts({ tool: "edit", path: "src/a.ts", hasUI: false })))
			.toEqual({ kind: "prompt", flavor: "approval", label: "on src/a.ts" });
		expect(decide(facts({ tool: "edit", path: "src/a.ts", hasUI: true })))
			.toEqual({ kind: "prompt", flavor: "edit-write-choice", label: "Allow edit on src/a.ts?", path: "src/a.ts" });
	});
	it("bash: safe passes; unsafe prompts; unknown tools pass", () => {
		expect(decide(facts({ tool: "bash", command: "ls", commandSafe: true }))).toEqual({ kind: "allow", effects: {} });
		expect(decide(facts({ tool: "bash", command: "npm install", commandSafe: false })))
			.toEqual({ kind: "prompt", flavor: "approval", label: '"npm install"' });
		expect(decide(facts({ tool: "my_custom_tool" }))).toEqual({ kind: "allow", effects: {} });
	});
});

describe("decide: auto (Step-1 transitional)", () => {
	it("everything past the rule layer defers to the legacy ladder", () => {
		expect(decide(facts({ mode: "auto", tool: "bash", command: "rm -rf /" })))
			.toEqual({ kind: "legacyAuto" });
		// rule verdicts still adjudicate in decide for auto too
		expect(decide(facts({ mode: "auto", verdict: deny }))).toMatchObject({ kind: "deny" });
	});
});
