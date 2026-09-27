/**
 * Prose / directive-copy tests for src/directive.ts.
 *
 * The JSON-stringified workflowScript body assertions live in
 * tests/workflow-contract.test.ts (which parses the script back and asserts
 * against plain text). This file only asserts the human-facing directive
 * copy that is NOT embedded in the JSON string.
 */
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, test } from "node:test";

import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";

import { buildReviewDirective } from "../src/directive.js";
import {
	LEAN_BUDGETS,
	LEAN_GATE_AGENT,
	leanAgentName,
	resolveLeanBudgets,
	withThinkingSuffix,
} from "../src/lean-agents.js";
import type { ReviewerSpec, ReviewTarget } from "../src/types.js";

const CWD = "/tmp/pi-review-test-cwd";
const WORKSPACE = "/tmp/pi-review-tgt-ws";
const MANIFEST = "/tmp/pi-review-test-cwd/.pi/pi-review/runs/r1/manifest.json";
const DIFF = "/tmp/pi-review-test-cwd/.pi/pi-review/runs/r1/change.diff";
const DIMENSIONS = [
	"bugbot",
	"security-review",
	"rulesheriff",
	"code-comments",
	"history-context",
];

function fakeTarget(overrides: Partial<ReviewTarget> = {}): ReviewTarget {
	return {
		kind: "local-git",
		label: "uncommitted changes",
		hint: "Working tree is dirty. Use git status then git diff HEAD.",
		...overrides,
	};
}

function fakeReviewer(id: string): ReviewerSpec {
	return { id, label: id, enabled: true, model: "inherit" };
}

function baseInput(overrides: Partial<Parameters<typeof buildReviewDirective>[0]> = {}) {
	return {
		target: fakeTarget(),
		reviewers: DIMENSIONS.map(fakeReviewer),
		gateModel: "anthropic/claude-haiku-4-5",
		threshold: 8,
		lite: false,
		cwd: CWD,
		workspacePath: WORKSPACE,
		manifestPath: MANIFEST,
		diffPath: DIFF,
		...overrides,
	};
}

describe("buildReviewDirective — user-facing copy", () => {
	const reviewers = DIMENSIONS.map(fakeReviewer);

	test("emits exactly one subagent call reference in the steps section", () => {
		const d = buildReviewDirective(baseInput());
		assert.match(d, /Call `subagent` \*\*exactly one\*\* time/);
		assert.match(d, /Step 2 must be a \*\*single\*\* `subagent\(/);
		assert.match(d, /never one call per reviewer/);
		assert.match(d, /pi_review_report/);
		const step2 = d.slice(d.indexOf("## Step 2"));
		const calls = step2.match(/^subagent\(\{$/gm) ?? [];
		assert.equal(calls.length, 1, "Step 2 must contain exactly one subagent({ }) call");
	});

	test("uses a chatProgress value accepted by pi-subagents", () => {
		const d = buildReviewDirective(baseInput());
		const m = d.match(/chatProgress: "(auto|off|live-card)"/);
		assert.ok(m, "must emit a valid chatProgress enum value");
	});

	test("chatProgress enum is not 'milestones' (PR #18689 regression)", () => {
		const d = buildReviewDirective(baseInput());
		assert.doesNotMatch(d, /chatProgress: "milestones"/);
	});

	test("pins a CC-style label for the call-row headline", () => {
		const d = buildReviewDirective(baseInput());
		assert.match(d, /label: "Code review"/);
		const step2 = d.slice(d.indexOf("## Step 2"));
		assert.equal((step2.match(/label: /g) ?? []).length, 1, "exactly one label in the pinned call");
	});

	test("top-level shape stays compatible with the workflowScript API", () => {
		const d = buildReviewDirective(baseInput());
		assert.match(d, /async: false/);
		assert.match(d, /context: "fresh"/);
		assert.match(d, /timeoutMs: \d+/);
	});

	test("Step 1 confirms plugin-prepared manifest + target workspace with real inline paths", () => {
		const d = buildReviewDirective(
			baseInput({
				target: fakeTarget({ kind: "pr", label: "PR 99", prRef: "https://github.com/o/r/pull/99", hint: "" }),
			}),
		);
		assert.match(d, /has \*\*already\*\* cloned\/checked out the target repo/);
		assert.ok(d.includes(MANIFEST));
		assert.ok(d.includes(DIFF));
		assert.ok(d.includes(WORKSPACE));
		// No template placeholders survive.
		assert.doesNotMatch(d, /\$\{TARGET_WORKSPACE\}/);
		assert.doesNotMatch(d, /\$\{MANIFEST_PATH\}/);
	});

	test("Step 3 names the pi_review_report tool with runId + workflowReturn", () => {
		const d = buildReviewDirective(baseInput());
		assert.match(d, /pi_review_report/);
		assert.match(d, /runId, workflowReturn/);
		assert.match(d, /exactly once/);
	});

	test("budget override flows into turnBudget line", () => {
		const d = buildReviewDirective(
			baseInput({ budgets: resolveLeanBudgets({ turnBudget: { maxTurns: 24, graceTurns: 2 } }) }),
		);
		assert.match(d, /turnBudget: \{ maxTurns: 24, graceTurns: 2 \}/);
	});

	test("hard rules preserve single-wave and no-retry guidance", () => {
		const d = buildReviewDirective(baseInput());
		assert.match(d, /Do not retry/);
		// v0.8.6: the report is echoed verbatim into chat; hand-rewriting stays banned.
		assert.match(d, /output its markdown verbatim in chat/);
		assert.match(d, /do not re-write findings yourself/);
		assert.match(d, new RegExp(leanAgentName("bugbot")));
	});

	test("PR target copies PR ref into the directive", () => {
		const d = buildReviewDirective(
			baseInput({
				target: fakeTarget({ kind: "pr", label: "PR 99", prRef: "https://github.com/o/r/pull/99" }),
			}),
		);
		assert.match(d, /PR 99/);
	});
});

describe("lean helpers", () => {
	test("leanAgentName namespaces under pi-review", () => {
		assert.equal(leanAgentName("bugbot"), "pi-review.bugbot");
		assert.equal(LEAN_GATE_AGENT, "pi-review.gate");
	});

	test("default turnBudget is 26 (raised from 20 — field runs wrapped partial)", () => {
		assert.equal(LEAN_BUDGETS.turnBudget.maxTurns, 26);
		// The gate must be able to actually verify high-severity candidates
		// (user-tuned 2026-08-25: 12 → 16 turns, 10 → 14 soft tools).
		assert.ok(LEAN_BUDGETS.gateTurnBudget.maxTurns >= 16, "gate turns >= 16");
		assert.ok(LEAN_BUDGETS.gateToolBudget.soft >= 14, "gate tool budget soft >= 14");
	});

	test("withThinkingSuffix", () => {
		assert.equal(withThinkingSuffix("anthropic/claude-haiku-4-5", "low"), "anthropic/claude-haiku-4-5:low");
		assert.equal(withThinkingSuffix("anthropic/claude-haiku-4-5:medium", "low"), "anthropic/claude-haiku-4-5:low");
		assert.equal(withThinkingSuffix("anthropic/claude-haiku-4-5", undefined), "anthropic/claude-haiku-4-5");
	});
});

describe("bundled agent prompts — pi-subagents ≥0.5 acceptance contract", () => {
	/**
	 * pi-subagents appends an Acceptance Contract to every child run and
	 * expects a closing ```acceptance-report fence. Agents whose prompts end
	 * with only "return JSON and stop" got meta acceptance: rejected on every
	 * run (observed in the field). Each bundled agent must tell the model to
	 * comply.
	 */
	const agentsDir = join(fileURLToPath(new URL(".", import.meta.url)), "..", "agents");
	for (const name of [
		"gate",
		"lite-review",
		"bugbot",
		"security-review",
		"conventions",
		"code-comments",
		"rulesheriff",
		"history-context",
	]) {
		test(`${name}.md ends with acceptance-report compliance`, () => {
			const body = readFileSync(join(agentsDir, `${name}.md`), "utf-8");
			assert.match(body, /acceptance-report/, `${name}.md must mention acceptance-report`);
		});
	}

	test("gate.md declares read-only role and verification duty", () => {
		const body = readFileSync(join(agentsDir, "gate.md"), "utf-8");
		assert.match(body, /^acceptanceRole: read-only$/m);
		assert.match(body, /Verification duty/);
		assert.match(body, /never score a finding above 8 without your own verification evidence/i);
		assert.match(body, /unverified:/);
		assert.doesNotMatch(body, /You do \*\*not\*\* have the full diff/);
	});

	test("v0.8: reviewers use Markdown output; gate/lite end with a fenced JSON block", () => {
		// User decision (2026-08-27): drop the structured-output tool contract
		// entirely — reviewers write Markdown reports, and only the gate /
		// lite-reviewer finish with a fenced ```json block that the report
		// tool machine-reads.
		for (const name of [
			"bugbot",
			"security-review",
			"conventions",
			"code-comments",
			"rulesheriff",
			"history-context",
		]) {
			const body = readFileSync(join(agentsDir, `${name}.md`), "utf-8");
			assert.match(body, /## Output format \(Markdown report\)/, `${name}.md must define the Markdown output format`);
			assert.doesNotMatch(body, /structured_output tool/, `${name}.md must not reference the structured_output tool`);
		}
		for (const name of ["gate", "lite-review"]) {
			const body = readFileSync(join(agentsDir, `${name}.md`), "utf-8");
			assert.match(body, /```json/, `${name}.md must show the fenced JSON block template`);
			assert.match(body, /fenced.*json block|EXACTLY one fenced JSON block/i, `${name}.md must instruct the fenced block`);
		}
	});
});

describe("tui-renderer summary line (v0.8.3 user decision)", () => {
	test("summaryLine renders `pi-review result: Approve · counts`", async () => {
		const { summaryLine } = await import("../src/tui-renderer.js");
		assert.equal(
			summaryLine({ verdict: "approve", totals: { blocker: 0, major: 0, minor: 0, nit: 0 } }),
			"pi-review result: Approve · 0 blocker · 0 major · 0 minor · 0 nit",
		);
		assert.equal(
			summaryLine({ verdict: "request_changes", totals: { blocker: 1, major: 2, minor: 3, nit: 4 } }),
			"pi-review result: Request changes · 1 blocker · 2 major · 3 minor · 4 nit",
		);
		assert.equal(summaryLine({ verdict: "no-gate" }), "pi-review result: No gate");
	});

	test("extractHeader reads the report's Verdict line incl. Chinese annotation", async () => {
		const { summaryLine } = await import("../src/tui-renderer.js");
		// renderReport emits `**Verdict: APPROVE** (0 blocker · ...)`;
		// the main agent's Chinese recap may emit `Verdict: APPROVE（通过）`.
		assert.equal(
			summaryLine({ verdict: "comment" as never, totals: undefined } as never),
			"pi-review result: Comment",
		);
	});
});

describe("tui-renderer flat report card (v0.8.5)", () => {
	// Pass-through theme: assertions see the plain text, structure only.
	const passthroughTheme = {
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
	};

	async function renderCard(contentText: string, width = 80): Promise<string[]> {
		const { extractHeader, reportCard } = await import("../src/tui-renderer.js");
		return reportCard(extractHeader(contentText), contentText, passthroughTheme).render(width);
	}

	test("extractHeader parses the canonical report Verdict line", async () => {
		const { extractHeader } = await import("../src/tui-renderer.js");
		// renderReport emits `**Verdict: APPROVE** (1 blocker · ...)`.
		const header = extractHeader("## Review\n**Verdict: APPROVE** (1 blocker · 2 major · 0 minor · 1 nit)\n");
		assert.equal(header.verdict, "approve");
		assert.deepEqual(header.totals, { blocker: 1, major: 2, minor: 0, nit: 1 });
		// Chinese annotation between verdict and counts still parses.
		const zh = extractHeader("**Verdict: REQUEST_CHANGES（需修改）** (0 blocker · 0 major · 0 minor · 0 nit)");
		assert.equal(zh.verdict, "request_changes");
		assert.deepEqual(zh.totals, { blocker: 0, major: 0, minor: 0, nit: 0 });
		// No Verdict line -> comment fallback.
		assert.deepEqual(extractHeader("free-form markdown without a verdict"), { verdict: "comment" });
	});

	test("head row is the CC-style dot + bold summary line, flat (no box padding rows)", async () => {
		const rows = await renderCard("**Verdict: APPROVE** (0 blocker · 0 major · 0 minor · 0 nit)\n\nbody");
		assert.match(rows[0]!, /^⏺ pi-review result: Approve · 0 blocker · 0 major · 0 minor · 0 nit$/);
	});

	test("body starts under a `⎿  ` gutter, continuation rows space-aligned", async () => {
		const rows = await renderCard("**Verdict: APPROVE** (0 blocker · 0 major · 0 minor · 0 nit)\nline one\nline two");
		// rows[1] is the report's own Verdict line — the full body renders
		// verbatim (v0.8.3), so the gutter opens with it, not "line one".
		assert.match(rows[1]!, /^ {2}⎿ {2}\*\*Verdict: APPROVE\*\*/);
		assert.match(rows[2]!, /^ {5}line one$/);
		assert.match(rows[3]!, /^ {5}line two$/);
		assert.equal(rows.length, 4);
	});

	test("long body lines wrap within the viewport, gutter-aligned", async () => {
		const long = "x".repeat(200);
		const rows = await renderCard("**Verdict: APPROVE** (0 blocker · 0 major · 0 minor · 0 nit)\n" + long, 80);
		for (const row of rows) {
			assert.ok(visibleWidth(row) <= 80, `row exceeds viewport: ${row}`);
		}
		// Body content survives wrapping intact (rows[1] is the Verdict line;
		// gutter/continuation prefixes stripped from the wrapped long line).
		const stripped = rows.slice(2).map((r) => r.replace(/^ {2}⎿ {2}/, "").replace(/^ {5}/, "")).join("");
		assert.equal(stripped, long);
	});

	test("narrow viewport truncates the summary with an ellipsis", async () => {
		const rows = await renderCard("**Verdict: REQUEST_CHANGES** (1 blocker · 2 major · 3 minor · 4 nit)\nbody", 30);
		assert.ok(visibleWidth(rows[0]!) <= 30, `head row too wide: ${rows[0]}`);
		// truncateToWidth appends an ANSI reset around the ellipsis even on
		// plain text, so strip sequences before matching the tail.
		assert.match(stripTerminalSequences(rows[0]!), /…$/);
	});

	test("empty report body renders only the summary row", async () => {
		const rows = await renderCard("");
		assert.equal(rows.length, 1);
		assert.match(rows[0]!, /^⏺ pi-review result: Comment$/);
	});
});
describe("tui-renderer command echo (fused: CC user-bar style)", () => {
	// Pass-through theme: assertions see the plain text, structure only.
	const passthroughTheme = {
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
	};

	async function renderEcho(contentText = "/review 测试 review", width = 80): Promise<string[]> {
		const { commandEchoRow } = await import("../src/tui-renderer.js");
		return commandEchoRow(contentText, passthroughTheme).render(width);
	}

	test("echo is a single CC user-bar row: dim ❯ + command text, no [pi-review] prefix", async () => {
		const rows = await renderEcho();
		assert.equal(rows.length, 1);
		const stripped = stripTerminalSequences(rows[0]!).replace(/\u00A0+$/, "");
		assert.match(stripped, /^❯ \/review 测试 review$/);
		assert.ok(!stripped.includes("[pi-review]"), "echo must not carry the [pi-review] prefix");
	});

	test("bar spans the row on the CC userMessageBackground", async () => {
		const rows = await renderEcho();
		assert.match(rows[0]!, /\x1b\[48;2;55;55;55m/);
		assert.ok(visibleWidth(rows[0]!) >= 78, `bar should span the row: ${rows[0]}`);
		assert.ok(visibleWidth(rows[0]!) <= 80, `bar exceeds viewport: ${rows[0]}`);
	});

	test("overlong commands truncate with an ellipsis within the viewport", async () => {
		const rows = await renderEcho(`/review ${"x".repeat(200)}`, 60);
		const stripped = stripTerminalSequences(rows[0]!);
		assert.ok(visibleWidth(rows[0]!) <= 60, `row exceeds viewport: ${stripped}`);
		assert.match(stripped, /…/);
	});
});
