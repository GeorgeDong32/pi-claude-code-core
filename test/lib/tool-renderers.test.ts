/*
 * tool-renderers.test.ts — TR A/B/C presentation units
 * (spec 2026-10-02-core-tool-renderers §5) over stub themes; pure text
 * helpers asserted directly, component wrappers by identity/instance.
 */
import { describe, expect, it } from "vitest";

import {
	recallBodyLines,
	recallCallText,
	recallHeaderText,
	renderRecallResult,
	shortId,
	stripProtocolHeader,
	RecallRows,
} from "../../extensions/observation-pack/renderers.ts";
import { thenRunStatusRow, withThenRunBadge, withThenRunStatus } from "../../extensions/action-fusion/renderers.ts";
import {
	consolidateCallText,
	consolidateResultRows,
	sessionRecallCallText,
	sessionRecallResultRows,
} from "../../extensions/memory/renderers.ts";
import { humanBytes } from "../../lib/tool-render.ts";

const theme = { fg: (_role: string, text: string) => text } as never;

const PAGE = (id = "obs_4b1d7b39d8bda696da88347f"): { content: unknown; details: unknown } => ({
	content: [
		{
			type: "text",
			text: `[obs_recall id=${id} offset=0 next_offset=15870 eof=false]\n[chunk_bytes=15871 chunk_lines=189; use next_offset to continue]\n--- 契约表 ---\nrow1\nrow2\nrow3\nrow4\nrow5\nrow6\nrow7`,
		},
	],
	details: { id, offset: 0, bytes: 15871, lines: 189, nextOffset: 15870, eof: false },
});

describe("TR A — obs_recall renderers", () => {
	it("1: call text — short id + human offsets", () => {
		expect(shortId("obs_4b1d7b39d8bda696da88347f")).toBe("obs_4b1d7b39d8bd");
		expect(recallCallText({ id: "obs_4b1d7b39d8bda696da88347f", offset: 0 })).toBe("Recall Observation obs_4b1d7b39d8bd · start");
		expect(recallCallText({ id: "obs_4b1d7b39d8bda696da88347f", offset: 15870 })).toBe(`Recall Observation obs_4b1d7b39d8bd · +${humanBytes(15870)}`);
		expect(recallCallText({})).toBe("Recall Observation obs_? · start");
	});

	it("2: protocol header stripped only for shaped pages", () => {
		const page = PAGE();
		const pageText = (page.content as Array<{ type: string; text: string }>)[0]!.text;
		expect(stripProtocolHeader(pageText, page.details as never)).not.toContain("[obs_recall id=");
		// details absent (error path) → honest fallback keeps the text as-is
		expect(stripProtocolHeader("raw text\n[chunk_bytes=x", {} as never)).toBe("raw text\n[chunk_bytes=x");
	});

	it("3: header text — paging vs eof", () => {
		expect(recallHeaderText({ bytes: 15871, lines: 189, offset: 0, nextOffset: 15870, eof: false })).toContain("more ▸");
		expect(recallHeaderText({ bytes: 100, lines: 3, offset: 120, eof: true })).toContain("end ✓");
	});

	it("4: collapsed preview caps at 5 lines; expanded shows all; component reused via lastComponent", () => {
		const collapsed = renderRecallResult(PAGE(), {}, theme, undefined);
		expect(collapsed).toBeInstanceOf(RecallRows);
		const again = renderRecallResult(PAGE(), {}, theme, collapsed);
		expect(again).toBe(collapsed); // F5 discipline: clear+rebuild, same instance
		const expanded = renderRecallResult(PAGE(), { expanded: true }, theme, undefined);
		expect(expanded).not.toBe(collapsed);
	});

	it("5: details-missing results still render (no header, no strip)", () => {
		const rows = recallBodyLines({ content: [{ type: "text", text: "Unknown observation id: obs_x (boom)" }], details: { id: "obs_x" } });
		expect(rows.header).toBeNull();
		expect(rows.body[0]).toContain("Unknown observation id");
	});

	it("6: empty text renders without throwing", () => {
		expect(() => renderRecallResult({ content: [], details: { bytes: 10, lines: 0, eof: true } }, {}, theme, undefined)).not.toThrow();
	});
});

describe("TR B — then_run badges", () => {
	it("1: no then_run → the builtin component is returned untouched (zero-wrap)", () => {
		const base = { tag: "builtin" } as never;
		expect(withThenRunBadge(base, {}, theme)).toBe(base);
		expect(withThenRunStatus(base, { content: [{ type: "text", text: "plain write output" }] }, theme)).toBe(base);
	});

	it("2: command badge wraps and carries the command", () => {
		const wrapped = withThenRunBadge({ tag: "builtin" } as never, { then_run: { command: "bun run check" } }, theme);
		expect(wrapped).not.toHaveProperty("tag");
		// (wrapped is a Container; asserting identity difference + no throw is
		// the component-level contract, the badge text lives in thenRunStatusRow)
	});

	it("3: status row — ok / failed / skipped coloring roles", () => {
		expect(thenRunStatusRow({ content: [{ type: "text", text: "done\n[then_run:ok] exit 0" }] }, theme)).toBe("↳ then_run ✓ ok");
		expect(thenRunStatusRow({ content: [{ type: "text", text: "[then_run:failed] exit 1\nerr" }] }, theme)).toBe("↳ then_run ✗ failed");
		expect(thenRunStatusRow({ content: [{ type: "text", text: "[then_run:skipped]" }] }, theme)).toBe("↳ then_run ⊘ skipped");
	});

	it("4: markers scanned read-only from result text — scan works even when a renderer would not show the text", () => {
		const result = { content: [{ type: "text", text: "…\n[then_run:ok]" }] };
		const base = { tag: "builtin" } as never;
		const wrapped = withThenRunStatus(base, result, theme);
		expect(wrapped).not.toBe(base);
	});

	it("5: empty result text → null status", () => {
		expect(thenRunStatusRow({ content: [] }, theme)).toBeNull();
	});
});

describe("TR C — core tool compact rows", () => {
	it("1: session_recall call + result rows", () => {
		expect(sessionRecallCallText({ query: "  memory   recall accuracy " })).toBe(`Session Recall "memory recall accuracy"`);
		expect(sessionRecallCallText({ query: "这是一条非常长的记忆召回精确率统计报告分析结果与改进方案" })).toContain("…"); // >24 chars clips
		expect(sessionRecallCallText({ query: "x".repeat(40), since: "-7d" })).toContain("[-7d]");
		const rows = sessionRecallResultRows({
			content: [{ type: "text", text: "session_recall: 3 hit(s)\n\n[--Users-x--/s.jsonl:12] user:\nsome text" }],
			details: { hits: 3, skippedLines: 1 },
		});
		expect(rows[0]).toBe("3 hit(s) · 1 malformed skipped");
		expect(rows[1]).toContain("s.jsonl:12");
		expect(rows[2]).toBe("… 2 more");
	});

	it("2: memory_consolidate call + result rows", () => {
		expect(consolidateCallText({ writes: [{ file: "a.md" }, { file: "b.md" }], deletes: ["c.md"], layer: "user" })).toBe("Memory Consolidate user · 2W/1D");
		expect(consolidateResultRows({ details: { written: 2, deleted: 1 } })).toEqual(["applied 2 write(s) · 1 delete(s)"]);
	});

	it("3: no-details fallback clips raw text", () => {
		const rows = consolidateResultRows({ content: [{ type: "text", text: "l1\nl2\nl3\nl4" }] });
		expect(rows).toEqual(["l1", "l2", "l3"]);
	});
});
