/**
 * Workflow contract tests — pin the generated workflowScript API shape that
 * pi-subagents validates. These tests guard against the real failures
 * observed during PR #18689 (agent-fetch) review and the follow-up P0:
 *
 *  - invalid `chatProgress` enum value (rejected by pi-subagents schema)
 *  - reviewer model inheritance leaked into explicit model overrides
 *  - free-text output treated as a successful reviewer result
 *  - gate consuming Markdown text instead of structured objects
 *  - "exactly one subagent call" + single workflowScript + fresh context +
 *    async:false + inline gate inside the same script
 *  - raw paths leaking into the workflowScript as UNQUOTED JS (SyntaxError:
 *    Invalid regular expression flags) — paths must be JSON.stringify'd
 *    inline so the final script parses as valid JS (see assertScriptParses).
 */
import { strict as assert } from "node:assert";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";

import { buildReviewDirective } from "../src/directive.js";
import { FALSE_POSITIVE_GUIDANCE, LEAN_BUDGETS, leanAgentName } from "../src/lean-agents.js";
import type { ReviewerSpec, ReviewTarget } from "../src/types.js";

const CWD = "/tmp/pi-review-contract";
const WORKSPACE = "/private/var/folders/ab/pi-review-ws-123/cherry-studio-18689";
const MANIFEST = "/tmp/pi-review-contract/.pi/pi-review/runs/r1/manifest.json";
const DIFF = "/tmp/pi-review-contract/.pi/pi-review/runs/r1/change.diff";

/**
 * Extract the workflowScript from the directive. Since v0.7.2 the script is
 * presented as a template literal (backticks) with no escaping — the main
 * agent copies it verbatim (the 2026-08-25 PR 19395 incident: the old
 * double-escaped JSON string form made the copy/unescape step produce
 * `workflowScript must be valid JavaScript` three times).
 */
function scriptOf(d: string): string {
	const m = d.match(/workflowScript: `\n([\s\S]*?)\n`,\s*\n\s*async: false/);
	assert.ok(m, "expected a workflowScript template-literal block in the directive");
	return m[1]!;
}

/**
 * P0 regression (real run failure): the script must **parse as valid JS**.
 * The old buildReviewDirective emitted unquoted paths (`cwd: /var/...`)
 * which the JS engine parsed as a RegExp literal → `SyntaxError: Invalid
 * regular expression flags` at subagent() call time. We assert every cwd / diff
 * / manifest occurrence is a properly JSON-quoted string.
 */
function assertScriptParses(script: string): void {
	// Every path-bearing field must be a quoted string literal.
	for (const field of ["cwd:", "toolBudget:", "turnBudget:"]) {
		assert.match(script, new RegExp(`${field} `), `script should contain ${field}`);
	}
	// cwd values must be JSON strings (backtick-adjacent), never bare /path.
	assert.doesNotMatch(script, /cwd: \/[A-Za-z_]/);
	// And the overall script must be parseable JS (async wrapper permits
	// top-level await inside the body). `new Function` only parses — never runs.
	const wrapped = `(async () => {\n${script}\n})`;
	new Function(wrapped); // eslint-disable-line no-new-func -- parse-only check
}

function fakeTarget(overrides: Partial<ReviewTarget> = {}): ReviewTarget {
	return {
		kind: "local-git",
		label: "uncommitted changes",
		hint: "Working tree is dirty.",
		...overrides,
	};
}

function fakeReviewer(id: string, overrides: Partial<ReviewerSpec> = {}): ReviewerSpec {
	return { id, label: id, enabled: true, model: "inherit", ...overrides };
}

function defaultReviewers(): ReviewerSpec[] {
	return [
		fakeReviewer("rulesheriff"),
		fakeReviewer("bugbot"),
		fakeReviewer("security-review"),
		fakeReviewer("code-comments"),
		fakeReviewer("history-context"),
	];
}

function baseInput(overrides: Partial<Parameters<typeof buildReviewDirective>[0]> = {}) {
	return {
		target: fakeTarget(),
		reviewers: defaultReviewers(),
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

function runsAllOf(script: string): string {
	const start = script.indexOf("runs.all([");
	const end = script.indexOf("]);");
	return script.slice(start, end + 4);
}

function gateBlockOf(script: string): string {
	return script.slice(script.indexOf("const reviewerSections"));
}

describe("buildReviewDirective — pi-subagents API contract", () => {
	test("chatProgress is a value pi-subagents accepts", () => {
		const d = buildReviewDirective(baseInput({ gateThinking: "low" }));
		assert.match(d, /chatProgress: "(auto|off|live-card)"/);
		assert.doesNotMatch(d, /chatProgress: "milestones"/);
		assert.doesNotMatch(d, /chatProgress: "on"/);
		assert.doesNotMatch(d, /chatProgress: "stream"/);
	});

	test("exactly one subagent tool call (no per-reviewer fallback path)", () => {
		const d = buildReviewDirective(baseInput());
		const script = scriptOf(d);
		// The reviewer array must be bound to a local before the return
		// object — the gate IIFE and `reviewersShaped` reference it (a bare
		// object property would throw `reviewers is not defined`).
		assert.match(script, /\nconst reviewers = await runs\.all\(\[/);
		assert.match(script, /return \{\n  reviewers,/);
		const runsAll = (script.match(/runs\.all\(\[/g) ?? []).length;
		assert.equal(runsAll, 1, "workflowScript must invoke runs.all once");
		const runsRunGate = (script.match(/runs\.run\('gate'/g) ?? []).length;
		assert.equal(runsRunGate, 1, "workflowScript must invoke runs.run('gate') once");
		// v0.8.1: proxy providers report bare model ids that fail upstream's
		// strict model verification — the gate launch is wrapped in try/catch
		// with a one-shot inherit-model retry under a different key.
		assert.equal((script.match(/runs\.run\('gate-fallback'/g) ?? []).length, 1, "one fallback launch");
		assert.match(script, /try \{\n  gateRun = await runs\.run\('gate'/);
		assert.match(script, /\} catch \(gateLaunchError\) \{\n  gateRun = await runs\.run\('gate-fallback'/);
		// v0.8.2: the fallback keeps the configured thinking level via the
		// child `thinking` param (child params consume it as an override).
		const dThink = buildReviewDirective(baseInput({ gateThinking: "low" }));
		assert.match(scriptOf(dThink), /gate-fallback[\s\S]{0,320}thinking: "low",/);
		// Without a thinking config, no thinking line is emitted.
		assert.doesNotMatch(script, /\n\s{4}thinking: /);
		assert.doesNotMatch(script, /runs\.run\('rulesheriff'/);
		assert.doesNotMatch(script, /runs\.run\('bugbot'/);
		assert.doesNotMatch(script, /runs\.run\('security-review'/);
	});

	test("top-level shape matches pi-subagents schema", () => {
		const d = buildReviewDirective(baseInput());
		assert.match(d, /async: false/);
		assert.match(d, /context: "fresh"/);
		assert.match(d, /timeoutMs: \d+/);
		// v0.7.2: the script is presented as an unescaped template literal
		// (the double-escaped JSON string form broke the main agent's copy).
		assert.match(d, /workflowScript: `\n\n?const reviewers = await runs\.all\(\[/);
	});

	test("P0: the generated workflowScript parses as valid JS (unquoted-path regression)", () => {
		const d = buildReviewDirective(baseInput());
		const script = scriptOf(d);
		assertScriptParses(script);
		// cwd values are the actual workspace path, JSON-quoted.
		assert.match(script, new RegExp(`cwd: ${JSON.stringify(WORKSPACE)}`));
	});

	test("v0.7.2: the script is presented verbatim inside a template literal (no escaping for the main agent to undo)", () => {
		const d = buildReviewDirective(baseInput());
		const script = scriptOf(d);
		// Template-literal safety: the script must never contain a backtick or
		// ${ — a single one would corrupt the directive presentation.
		assert.doesNotMatch(script, /[`$]/);
		// The full script body appears in the directive unescaped.
		assert.ok(d.includes(script), "directive must embed the raw script text");
		// And the literal is a template literal, not a JSON string.
		assert.doesNotMatch(d, /workflowScript: "/);
	});

	test("workflowPath writes the raw script to disk (retry source for the main agent)", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-review-wf-"));
		const wf = join(dir, "workflow.js");
		const d = buildReviewDirective(baseInput({ workflowPath: wf }));
		const script = scriptOf(d);
		assert.ok(existsSync(wf), "workflow.js must be written");
		assert.equal(readFileSync(wf, "utf-8"), script);
		rmSync(dir, { recursive: true, force: true });
	});

	test("P0: paths are inlined via JSON.stringify — no placeholder tokens survive", () => {
		const d = buildReviewDirective(baseInput());
		const script = scriptOf(d);
		assert.ok(script.includes(WORKSPACE), "workspace path must be inlined");
		assert.ok(script.includes(DIFF), "diff path must be inlined");
		assert.ok(script.includes(MANIFEST), "manifest path must be inlined");
		assert.doesNotMatch(script, /\$\{TARGET_WORKSPACE\}/);
		assert.doesNotMatch(script, /\$\{MANIFEST_PATH\}/);
		assert.doesNotMatch(script, /\$\{DIFF_PATH\}/);
	});

	test("reviewer models use 'inherit' when config says so (no parent model leakage)", () => {
		const inherited: ReviewerSpec[] = [
			fakeReviewer("bugbot", { model: "inherit" }),
			fakeReviewer("history-context", { model: "inherit" }),
		];
		const d = buildReviewDirective(baseInput({ reviewers: inherited }));
		const script = scriptOf(d);
		const block = runsAllOf(script);
		assert.doesNotMatch(block, /model: "(anthropic|google|openai|CPA)\//);
	});

	test("explicit per-reviewer model override flows into the script", () => {
		const reviewersWithModel: ReviewerSpec[] = [
			fakeReviewer("bugbot", { model: "anthropic/claude-opus-4-6" }),
			fakeReviewer("history-context", { model: "inherit" }),
			fakeReviewer("security-review", { model: "google/gemini-2.5-flash" }),
		];
		const d = buildReviewDirective(baseInput({ reviewers: reviewersWithModel }));
		const script = scriptOf(d);
		const block = runsAllOf(script);
		assert.match(block, /model: "anthropic\/claude-opus-4-6"/);
		assert.match(block, /model: "google\/gemini-2\.5-flash"/);
		const historyItem = block.slice(
			block.indexOf('key: "history-context"'),
			block.indexOf('key: "history-context"') + 400,
		);
		assert.doesNotMatch(historyItem, /model:/);
	});

	test("per-child cwd is passed so reviewer can reach target repo", () => {
		// Real failure (PR #18689): reviewers had cwd === plugin repo, so
		// history-context / code-comments saw no relevant files.
		const reviewers = defaultReviewers();
		const d = buildReviewDirective(
			baseInput({
				target: fakeTarget({
					kind: "pr",
					label: "PR 18689 (agent-fetch)",
					prRef: "https://github.com/CherryHQ/cherry-studio/pull/18689",
					hint: "PR belongs to CherryHQ/cherry-studio.",
				}),
			}),
		);
		const script = scriptOf(d);
		const cwdOccurrences = script.split(`cwd: ${JSON.stringify(WORKSPACE)}`).length - 1;
		// One cwd per reviewer + two for the gate (primary + inherit fallback).
		assert.equal(cwdOccurrences, reviewers.length + 2, "every reviewer + gate launches must set cwd to the target workspace");
	});

	test("v0.8: NO child declares outputSchema (Markdown-first contract)", () => {
		const d = buildReviewDirective(baseInput());
		const script = scriptOf(d);
		// The structured-output tool contract was too fragile in the field
		// ("Missing structured_output call" after budget wrap-ups). Reviewers
		// return Markdown; the gate ends with a fenced JSON verdict block.
		assert.doesNotMatch(script, /outputSchema/, "no child may declare outputSchema");
		assert.doesNotMatch(script, /REVIEWER_SCHEMA|GATE_SCHEMA/, "schema consts must be gone");
	});

	test("RUNTIME: evaluating the script with stub runs returns the full object (no ReferenceError)", async () => {
		// Real failure: the old script used `return { reviewers: await runs.all(...) }`
		// which never bound a `reviewers` variable, so the gate IIFE and
		// `reviewersShaped` threw `ReferenceError: reviewers is not defined`
		// and the subagent harness surfaced it as a null workflow return.
		const d = buildReviewDirective(baseInput());
		const script = scriptOf(d);
		const stubOutput = (key: string) => ({
			key,
			ok: true,
			error: undefined,
			output: `## Summary\nstub ${key}\n\n## Findings\nNo findings.\n\n## Coverage\n- Files checked: …`,
		});
		const runs = {
			all: async () => defaultReviewers().map((r) => stubOutput(r.id)),
			run: async (_key: string) => ({
				ok: true,
				error: undefined,
				output: "## Synthesis\nstub gate\n\n```json\n{\"status\":\"ok\",\"verdict\":\"approve\",\"issues\":[],\"dispositions\":[]}\n```",
			}),
		};
		const fn = new Function("runs", `return (async () => {\n${script}\n})();`); // eslint-disable-line no-new-func
		const result = await fn(runs);
		assert.ok(result && typeof result === "object", "script must return an object");
		assert.ok(Array.isArray(result.reviewers), "reviewers must be an array");
		assert.equal(result.reviewers.length, defaultReviewers().length);
		assert.ok(result.gate && typeof result.gate === "object", "gate must be an object");
		assert.match(result.gate.output, /```json/, "gate output carries the fenced verdict block");
		assert.ok(Array.isArray(result.reviewersShaped), "reviewersShaped must be an array");
		assert.equal(result.reviewersShaped.length, defaultReviewers().length);
	});

	test("gate task inlines the reviewers' Markdown reports (v0.8 data flow)", () => {
		const d = buildReviewDirective(baseInput());
		const script = scriptOf(d);
		const gateBlock = gateBlockOf(script);
		assert.match(gateBlock, /reviewerSections/);
		assert.match(gateBlock, /r\.output/);
		assert.match(gateBlock, /# Reviewer reports \(Markdown\)/);
		assert.doesNotMatch(gateBlock, /reviewerInputs/);
	});

	test("per-reviewer budgets are pinned and inherited", () => {
		const d = buildReviewDirective(baseInput());
		const script = scriptOf(d);
		const allBlock = runsAllOf(script);
		assert.match(
			allBlock,
			new RegExp(`toolBudget: \\{ soft: ${LEAN_BUDGETS.defaultToolBudget.soft}, hard: ${LEAN_BUDGETS.defaultToolBudget.hard} \\}`),
		);
		assert.match(
			allBlock,
			new RegExp(`toolBudget: \\{ soft: ${LEAN_BUDGETS.historyToolBudget.soft}, hard: ${LEAN_BUDGETS.historyToolBudget.hard} \\}`),
		);
		assert.match(
			allBlock,
			new RegExp(`turnBudget: \\{ maxTurns: ${LEAN_BUDGETS.turnBudget.maxTurns}, graceTurns: ${LEAN_BUDGETS.turnBudget.graceTurns} \\}`),
		);
	});

	test("gate child carries budgets, model, and the fenced-JSON finish instruction", () => {
		const d = buildReviewDirective(baseInput({ gateThinking: "low" }));
		const script = scriptOf(d);
		const gateBlock = gateBlockOf(script);
		assert.match(gateBlock, /model: "anthropic\/claude-haiku-4-5:low"/);
		assert.match(
			gateBlock,
			new RegExp(`toolBudget: \\{ soft: ${LEAN_BUDGETS.gateToolBudget.soft}, hard: ${LEAN_BUDGETS.gateToolBudget.hard} \\}`),
		);
		assert.match(
			gateBlock,
			new RegExp(`turnBudget: \\{ maxTurns: ${LEAN_BUDGETS.gateTurnBudget.maxTurns}, graceTurns: ${LEAN_BUDGETS.gateTurnBudget.graceTurns} \\}`),
		);
		assert.match(gateBlock, /dispositions/);
		assert.match(gateBlock, /fenced json block/);
	});

	test("agent names use pi-review.* namespace and never builtin reviewer", () => {
		const d = buildReviewDirective(baseInput());
		const script = scriptOf(d);
		for (const id of defaultReviewers().map((r) => r.id)) {
			assert.match(script, new RegExp(`agent: "${leanAgentName(id)}"`));
			assert.match(script, new RegExp(`key: "${id}"`));
		}
		assert.doesNotMatch(script, /agent: "reviewer"/);
	});
});

describe("pi-subagents ≥0.55 read-only task classification", () => {
	/**
	 * Mirror of pi-subagents' task-intent classifier (src/runs/shared/
	 * task-intent.ts): a task with a blanket read-only declaration is
	 * classified read-only, which (a) lets a read-only agent (gate:
	 * `tools: read`) launch at all — 0.55.0 rejects "implementation task +
	 * no mutation-capable tools" — and (b) keeps acceptance at the lightweight
	 * attested level. If pi-subagents changes these heuristics, update the
	 * mirror AND re-verify against the installed package.
	 */
	const REVIEW_ONLY = [
		/\breview only\b/i,
		/\bsuggest fixes only\b/i,
		/\bonly return findings\b/i,
		/\breturn findings only\b/i,
	];
	const NO_EDIT_PROHIBITION =
		/\b(?:do not|don't|must not)\s+(?:edit|modify|write(?:\s+to)?|touch|change)\b((?:(?!\b(?:but|and|then)\b)[^.;,:!?\n–—-])*)/gi;
	const GENERIC_PROHIBITION_OBJECT =
		/^\s*(?:(?:any|all|the|these|those|your|our|existing|project|product|source|sources|config|configs|repo|repository)[\s/,-]*)*(?:files?|code|codebase|sources?|anything|repo(?:sitory)?)?\s*$/i;

	function isBlankReadOnly(task: string): boolean {
		if (REVIEW_ONLY.some((p) => p.test(task))) return true;
		NO_EDIT_PROHIBITION.lastIndex = 0;
		let m: RegExpExecArray | null;
		while ((m = NO_EDIT_PROHIBITION.exec(task)) !== null) {
			if (GENERIC_PROHIBITION_OBJECT.test(m[1] ?? "")) return true;
		}
		return false;
	}

	/** Extract every task text from the script (v0.7.3 array-join form). */
	function taskLiteralsOf(script: string): string[] {
		const out: string[] = [];
		const re = /(?:task: |const gateTask = )\[\n((?:\s*"(?:\\.|[^"\\])*",?\n)+)\s*\]\.join\(" "\)/g;
		let m: RegExpExecArray | null;
		while ((m = re.exec(script)) !== null) {
			const parts = [...m[1]!.matchAll(/"((?:\\.|[^"\\])*)",?\n/g)].map((p) => JSON.parse(`"${p[1]}"`));
			out.push(parts.join(" "));
		}
		return out;
	}

	test("gate + reviewer tasks are blanket read-only (gate never rejected at launch)", () => {
		const d = buildReviewDirective(baseInput());
		const script = scriptOf(d);
		const tasks = taskLiteralsOf(script);
		// One static reviewer task per reviewer + one gate task prefix.
		assert.ok(tasks.length >= defaultReviewers().length + 1, `expected >= ${defaultReviewers().length + 1} task literals, got ${tasks.length}`);
		for (const t of tasks) {
			assert.ok(isBlankReadOnly(t), `task must carry a blanket read-only declaration: ${t.slice(0, 90)}…`);
		}
	});

	test("gate task carries the verification duty + anti-amplification rules", () => {
		const d = buildReviewDirective(baseInput());
		const script = scriptOf(d);
		const gateLiteral = script.slice(script.indexOf("const gateTask = "));
		assert.match(gateLiteral, /The full diff is at/);
		assert.match(gateLiteral, /Never raise a candidate above 8 without your own verification evidence/);
		assert.match(gateLiteral, /do NOT silently drop it/);
		assert.match(gateLiteral, /unverified:/);
	});

	test("FALSE_POSITIVE_GUIDANCE carries no bare write verbs (the 'did not modify' regression)", () => {
		// Real failure: "Pre-existing issues on lines the author did not
		// modify" — the bare "modify" hit GENERAL_IMPLEMENTATION_PATTERNS and
		// got the read-only gate rejected by pi-subagents 0.55.0.
		assert.doesNotMatch(FALSE_POSITIVE_GUIDANCE, /\b(implement|edit|modify|refactor|update|remove|replace|delete|create)\b/i);
	});

	test("P0: no nested async functions (pi-subagents AST walker rejects them)", () => {
		// Real failure (2026-08-26 session): the gate was launched as
		// `gate: await (async () => {...})()`. Every copy that survived the
		// syntax stage then died at upstream AST validation — "workflowScript
		// does not support nested async functions". The upstream walker
		// (scripted-workflow.ts) rejects async functions outside its wrapper.
		// Our generator is fully controlled output, so ANY occurrence of the
		// `async` keyword in the script is a violation (the runtime wraps the
		// body in an async IIFE itself; sync arrows for .map() are fine).
		const d = buildReviewDirective(baseInput());
		const script = scriptOf(d);
		assert.doesNotMatch(script, /\basync\b/, "workflowScript must not contain any async functions");
		// And the gate launch is top-level (wrapped in a try/catch with a
		// one-shot fallback since v0.8.1).
		assert.match(script, /^let gateRun;$/m);
		assert.doesNotMatch(script, /gate: await/);
	});
});

describe("buildReviewDirective — directive copy", () => {
	const reviewers: ReviewerSpec[] = [
		fakeReviewer("bugbot"),
		fakeReviewer("history-context"),
	];

	test("hard rules pin single subagent call and forbid re-review", () => {
		const d = buildReviewDirective(baseInput({ reviewers }));
		assert.match(d, /Call `subagent` \*\*exactly one\*\* time/);
		assert.match(d, /Do not retry/);
		assert.match(d, /never one call per reviewer/);
		assert.match(d, /pi_review_report/);
	});

	test("Step 1 points at deterministic manifest, not LLM-obtained diff", () => {
		const d = buildReviewDirective(baseInput({ reviewers }));
		assert.ok(d.includes(MANIFEST));
		assert.ok(d.includes(DIFF));
		assert.ok(d.includes(WORKSPACE));
	});

	test("lite mode keeps the single-wave guarantee", () => {
		const d = buildReviewDirective(
			baseInput({ reviewers: [fakeReviewer("lite-review")], lite: true }),
		);
		const script = scriptOf(d);
		assert.equal((script.match(/runs\.all\(\[/g) ?? []).length, 1);
		assert.doesNotMatch(script, /runs\.run\('gate'\)/);
		assert.match(script, /gate: null/);
	});
});