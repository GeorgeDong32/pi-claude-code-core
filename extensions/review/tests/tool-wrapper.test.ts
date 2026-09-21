/**
 * Tests for src/tool-wrapper.ts — v0.8.6 report delivery contract.
 *
 * The report tool no longer pushes a rendered card into chat; its result
 * text must carry the FULL markdown plus an explicit verbatim-output
 * instruction so the main agent echoes the report as plain chat text.
 */
import { strict as assert } from "node:assert";
import { describe, test } from "node:test";

import { buildReportReply } from "../src/tool-wrapper.js";
import type { ReportToolSuccess } from "../src/report-tool.js";

function fakeSuccess(markdown: string): ReportToolSuccess {
	return {
		ok: true,
		runId: "run-test",
		verdict: "comment",
		markdown,
		report: {
			totals: { bySeverity: { blocker: 0, major: 1, minor: 2, nit: 3 } },
		},
	} as unknown as ReportToolSuccess;
}

describe("buildReportReply (v0.8.6 chat-verbatim delivery)", () => {
	test("carries the full markdown verbatim", () => {
		const md = "## pi-review — PR #1\n\n**Verdict: COMMENT** (0 blocker · 1 major · 2 minor · 3 nit)\n\nbody line";
		const reply = buildReportReply(fakeSuccess(md));
		assert.ok(reply.includes(md), "reply must embed the full markdown");
	});

	test("includes the summary anchor with severity counts", () => {
		const reply = buildReportReply(fakeSuccess("x"));
		assert.ok(reply.includes("pi-review result: comment · 0 blocker · 1 major · 2 minor · 3 nit"));
	});

	test("includes an explicit verbatim-output instruction", () => {
		const reply = buildReportReply(fakeSuccess("x"));
		assert.match(reply, /verbatim as your final chat message/);
		assert.match(reply, /no summarizing/i);
		assert.match(reply, /runId run-test/);
	});
});
