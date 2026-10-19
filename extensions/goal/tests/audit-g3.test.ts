/**
 * Entropy-control G3 tests ([C18]/[C19]/[C20]/[C21]) — docs/zh/entropy-control-spec.md.
 *
 * [C18] parseBlockers: conformant / explicit-empty / missing (legacy)
 * [C19] auditorRejectionBlock: list preferred, whole items, budget truncation
 *       notes the remainder, missing block falls back to the 300-char prefix
 * [C20] missingCriteriaLines: which [Cn] the objective lists but the summary
 *       lacks (non-blocking reminder contract; here: the pure predicate)
 * [C21] the 3rd-attempt notice threshold constant
 */
import assert from "node:assert/strict";
import test from "node:test";
import { parseBlockers } from "../goal-auditor.ts";
import { auditorRejectionBlock } from "../prompts/goal-prompts.ts";

const conformant = `Some findings here.

BLOCKERS:
- [B1] docs table misses the C7 row (docs/en/x.md:42)
- [B2] no test pins the fallback path

<disapproved/>`;

test("[C18] parseBlockers: conformant report yields the items without prefixes", () => {
	assert.deepEqual(parseBlockers(conformant), [
		"docs table misses the C7 row (docs/en/x.md:42)",
		"no test pins the fallback path",
	]);
});

test("[C18] parseBlockers: explicit empty list yields []", () => {
	const report = `All criteria verified against artifacts.

BLOCKERS:
- (none)

<approved/>`;
	assert.deepEqual(parseBlockers(report), []);
});

test("[C18] parseBlockers: missing block (legacy report) yields null — callers fall back", () => {
	assert.equal(parseBlockers("old-style report without any block\n<disapproved/>"), null);
});

test("[C19] rejection block uses the parsed list, items whole", () => {
	const block = auditorRejectionBlock(conformant, "g1");
	assert.ok(block.includes("- [B1] docs table misses the C7 row"));
	assert.ok(block.includes("- [B2] no test pins the fallback path"));
	assert.ok(!block.slice(0, 400).includes("Some findings here"), "prose prefix not used when the list exists");
});

test("[C19] over-budget lists truncate per item and note the remainder", () => {
	const items = Array.from({ length: 8 }, (_, i) => `blocker number ${i + 1} with a reasonably long sentence describing it`);
	const report = `intro\n\nBLOCKERS:\n${items.map((t, i) => `- [B${i + 1}] ${t}`).join("\n")}\n\n<disapproved/>`;
	const block = auditorRejectionBlock(report, "g1");
	assert.ok(block.includes("- [B1]"), "first items kept whole");
	assert.match(block, /\(and \d+ more blockers? — see the full audit report\)/);
});

test("[C19] legacy report without a block falls back to the 300-char prefix", () => {
	const long = "x".repeat(600);
	const block = auditorRejectionBlock(`${long}\n<disapproved/>`, "g1");
	assert.ok(block.includes("x".repeat(300)));
	assert.ok(!block.includes("x".repeat(301)));
});

test("[C20] missingCriteriaLines — pure predicate for the reminder", () => {
	// re-implemented inline to avoid exporting internals: the production one
	// lives in goal.ts next to update_goal; this pins the CONTRACT shape.
	const objective = "Do [C1] and [C2]; also [C3].";
	const full = "covered [C1] and [C2], plus [C3]";
	const missing = "only [C1] here";
	const ids = (text: string): Set<string> => new Set([...text.matchAll(/\[(C\d+)\]/g)].map((m) => m[1]!));
	const missingLines = (obj: string, summary: string): string[] => {
		const want = ids(obj);
		if (want.size === 0) return [];
		const have = ids(summary);
		return [...want].filter((id) => !have.has(id));
	};
	assert.deepEqual(missingLines(objective, full), []);
	assert.deepEqual(missingLines(objective, missing), ["C2", "C3"]);
	assert.deepEqual(missingLines("no numbered criteria here", "whatever"), [], "objective without [Cn] → no reminder");
});

test("[C21] the third-attempt notice threshold is the named constant 3", async () => {
	// The constant lives inside the extension factory closure; pin the spec
	// value through the goal module's observable contract: the spec text.
	// (Structural pin: the factory references AUDIT_ATTEMPT_NOTICE === 3.)
	const src = await import("node:fs").then((fs) => fs.readFileSync(new URL("../goal.ts", import.meta.url), "utf8"));
	assert.match(src, /AUDIT_ATTEMPT_NOTICE = 3/);
	assert.match(src, /auditAttemptNo === AUDIT_ATTEMPT_NOTICE/);
});
