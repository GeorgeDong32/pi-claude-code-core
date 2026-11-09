/*
 * Validation-gate tests (SPEC SC §5.5 SUM-04/SUM-09, task W1).
 *
 * Requirement → test map:
 *   SUM-09 → "classifySubCall pins pi's prompt shapes"
 *   SUM-04 (layer 1) → "validateSubCall matrix"
 *   SUM-04 (layer 2) → "validateAssembled: normal / empty / E3 / truncated /
 *       overlong / split variants / call-set" (BLK-4 shapes: history-ok +
 *       prefix-empty, prefix-ok + history-empty, both-ok)
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
	classifySubCall,
	stripFileSections,
	stripLedgerBlock,
	validateAssembled,
	validateSubCall,
	type ValidationThresholds,
} from "../validate.ts";
import type { SubCallRecord } from "../types.ts";

const T: ValidationThresholds = { minNarrativeChars: 400, minPrefixChars: 100, maxSummaryChars: 40_000 };

const narrative = (chars: number) =>
	`# Work\n${"n".repeat(Math.max(0, chars - 200))}\n## State\n${"m".repeat(150)}`;

test("classifySubCall pins pi's prompt shapes (SUM-09, SC-HOST-09)", () => {
	assert.equal(classifySubCall("<conversation>\nuser: hi"), "history");
	assert.equal(classifySubCall("# Conversation Summary\n..."), "turn-prefix");
	assert.equal(classifySubCall("Some future prompt shape"), "unknown");
});

function subCall(over: Partial<SubCallRecord> = {}): SubCallRecord {
	return {
		kind: "history",
		stopReason: "stop",
		narrativeText: "x".repeat(500),
		hasToolCall: false,
		usage: { input: 1000, output: 600, reasoning: 0 },
		...over,
	};
}

test("validateSubCall matrix (layer 1)", () => {
	// Normal.
	assert.deepEqual(validateSubCall(subCall(), T), { ok: true, failures: [] });
	// ① stopReason length/error/aborted — defensive (pi already throws).
	for (const stopReason of ["length", "error", "aborted"]) {
		const verdict = validateSubCall(subCall({ stopReason }), T);
		assert.equal(verdict.ok, false);
		assert.ok(verdict.failures.includes("sub:stopReason"));
	}
	// ② narrative below the kind threshold (turn-prefix uses minPrefixChars).
	assert.ok(validateSubCall(subCall({ narrativeText: "x".repeat(399) }), T).failures.includes("sub:narrative"));
	const prefix = validateSubCall(subCall({ kind: "turn-prefix", narrativeText: "y".repeat(99) }), T);
	assert.ok(prefix.failures.includes("sub:narrative"));
	// ③ reasoning-only: reasoning ≥ 0.9·output AND narrative below threshold.
	const reasoningOnly = validateSubCall(
		subCall({ narrativeText: "", usage: { input: 1000, output: 1000, reasoning: 950 } }),
		T,
	);
	assert.ok(reasoningOnly.failures.includes("sub:reasoning-only"));
	const reasoningHeavyButWritten = validateSubCall(
		subCall({ usage: { input: 1000, output: 1000, reasoning: 950 } }),
		T,
	);
	assert.equal(reasoningHeavyButWritten.ok, true); // narrative long enough ⇒ pass
	// ④ toolCall blocks.
	assert.ok(validateSubCall(subCall({ hasToolCall: true }), T).failures.includes("sub:toolCall"));
});

// E3 observed shape: a long path listing and nothing else (~970 chars).
const fileList = (count: number, prefix: string) =>
	Array.from({ length: count }, (_, i) => `- ${prefix}/some/deeper/module-${i}/file-${i}.ts`).join("\n");
const readFiles = `<read-files>\n${fileList(16, "/repo-a")}\n</read-files>`;
const modifiedFiles = `<modified-files>\n${fileList(8, "/repo-a")}\n</modified-files>`;

test("validateAssembled: normal summary passes everything", () => {
	const verdict = validateAssembled(
		{ summary: narrative(600), isSplitTurn: false, hasHistory: true, subCalls: [subCall()] },
		T,
	);
	assert.deepEqual(verdict, { ok: true, failures: [] });
});

test("validateAssembled: E3 fixture — file-listing-only (970-char shape) is rejected", () => {
	// E3 observed shape: summary reduced to a bare file list (~970 chars).
	const fileListingOnly = `${readFiles}\n${modifiedFiles}`;
	assert.equal(fileListingOnly.length > 900, true);
	const verdict = validateAssembled(
		{ summary: fileListingOnly, isSplitTurn: false, hasHistory: true, subCalls: [subCall()] },
		T,
	);
	assert.equal(verdict.ok, false);
	assert.ok(verdict.failures.includes("assembled:file-listing-only"));
	assert.ok(verdict.failures.includes("assembled:narrative"));
});

test("validateAssembled: empty and truncated summaries fail", () => {
	const empty = validateAssembled({ summary: "", isSplitTurn: false, hasHistory: true, subCalls: [subCall()] }, T);
	assert.equal(empty.ok, false);
	assert.ok(empty.failures.includes("assembled:narrative"));

	const noHeadings = validateAssembled(
		{ summary: "x".repeat(500), isSplitTurn: false, hasHistory: true, subCalls: [subCall()] },
		T,
	);
	assert.ok(noHeadings.failures.includes("assembled:headings"));

	const oneHeading = validateAssembled(
		{ summary: `# Only\n${"x".repeat(500)}`, isSplitTurn: false, hasHistory: true, subCalls: [subCall()] },
		T,
	);
	assert.ok(oneHeading.failures.includes("assembled:headings"));
});

test("validateAssembled: overlong summary fails max-length", () => {
	const long = `# A\n${"x".repeat(41_000)}`;
	const verdict = validateAssembled(
		{ summary: long, isSplitTurn: false, hasHistory: true, subCalls: [subCall()] },
		{ ...T, maxSummaryChars: 40_000 },
	);
	assert.ok(verdict.failures.includes("assembled:max-length"));
});

test("validateAssembled: split-turn matrix (BLK-4 shapes)", () => {
	const history = subCall({ kind: "history" });
	const prefix = subCall({ kind: "turn-prefix", narrativeText: "y".repeat(150) });
	const SEP = "\n\n---\n\n**Turn Context (split turn):**\n\n";
	const prefixBody = `# Turn\n${"p".repeat(150)}`;

	// Both sub-calls fine + separator present with real body ⇒ pass.
	const ok = validateAssembled(
		{ summary: narrative(600) + SEP + prefixBody, isSplitTurn: true, hasHistory: true, subCalls: [history, prefix] },
		T,
	);
	assert.deepEqual(ok, { ok: true, failures: [] });

	// History ok, turn-prefix sub-call reasoning-only ⇒ layer-1 rejection.
	const prefixEmpty = subCall({ kind: "turn-prefix", narrativeText: "", usage: { input: 100, output: 500, reasoning: 490 } });
	const localEmpty = validateSubCall(prefixEmpty, T);
	assert.ok(localEmpty.failures.includes("sub:reasoning-only"));

	// Prefix ok, history sub-call empty ⇒ layer-1 rejection.
	const historyEmpty = subCall({ kind: "history", narrativeText: "" });
	assert.ok(validateSubCall(historyEmpty, T).failures.includes("sub:reasoning-only"));

	// Assembled with a separator whose body is too short ⇒ layer-2 rejection.
	const thinPrefix = validateAssembled(
		{ summary: narrative(600) + SEP + "short", isSplitTurn: true, hasHistory: true, subCalls: [history, prefix] },
		T,
	);
	assert.ok(thinPrefix.failures.includes("assembled:split-prefix-body"));

	// Missing separator entirely.
	const noSep = validateAssembled(
		{ summary: narrative(600), isSplitTurn: true, hasHistory: true, subCalls: [history, prefix] },
		T,
	);
	assert.ok(noSep.failures.includes("assembled:split-missing-section"));
});

test("validateAssembled ⑨: call-set must match the preparation expectation", () => {
	const history = subCall({ kind: "history" });
	const prefix = subCall({ kind: "turn-prefix", narrativeText: "y".repeat(150) });
	// Expected {history, turn-prefix}, observed only history.
	const missing = validateAssembled(
		{ summary: narrative(600), isSplitTurn: true, hasHistory: true, subCalls: [history] },
		{ ...T, minNarrativeChars: 1, minPrefixChars: 1, maxSummaryChars: 100_000 },
	);
	assert.ok(missing.failures.includes("assembled:call-set"));
	// Unknown shape observed.
	const unknown = subCall({ kind: "unknown" });
	const weird = validateAssembled(
		{ summary: narrative(600), isSplitTurn: false, hasHistory: true, subCalls: [unknown] },
		{ ...T, minNarrativeChars: 1, minPrefixChars: 1, maxSummaryChars: 100_000 },
	);
	assert.ok(weird.failures.includes("assembled:call-set"));
	// Exactly right.
	const SEP = "\n\n---\n\n**Turn Context (split turn):**\n\n";
	const prefixBody = `# Turn\n${"p".repeat(150)}`;
	const right = validateAssembled(
		{ summary: narrative(600) + SEP + prefixBody, isSplitTurn: true, hasHistory: true, subCalls: [history, prefix] },
		T,
	);
	assert.equal(right.ok, true);
});

test("stripFileSections / stripLedgerBlock helpers", () => {
	assert.equal(stripFileSections(`${readFiles}core${modifiedFiles}`), "core");
	const withLedger = `${narrative(600)}\n<cc-core-ledger v="1">\n## Open work\n- x\n</cc-core-ledger>`;
	const stripped = stripLedgerBlock(withLedger);
	assert.ok(!stripped.includes("cc-core-ledger"));
	assert.ok(stripped.startsWith("# Work"));
});
