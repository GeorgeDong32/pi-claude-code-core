/*
 * P0-2 (2026-11-24): obs_recall selection — `filter` (+`context`) and `tail`
 * over a stored object, the third protocol header line, and the error texts
 * the model sees. Pure primitives first, then the registered tool through the
 * real extension factory. node:test.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import createObservationPackExtension from "../index.ts";
import {
	observationPath,
	readRecallSelected,
	RecallSelectionError,
	RECALL_TOOL_NAME,
	SELECTION_MAX_BYTES,
} from "../observation.ts";
import { recallCallText, recallHeaderText, stripProtocolHeader, type RecallResultDetails } from "../renderers.ts";

const LIMITS = { maxBytes: 16 * 1024 - 512, maxLines: 400 - 2 };

async function storedObject(lines: string[]): Promise<{ root: string; id: string }> {
	const root = await mkdtemp(join(tmpdir(), "obs-sel-"));
	const id = `obs_${"a".repeat(24)}`;
	await mkdir(join(root, "objects"), { recursive: true });
	await writeFile(observationPath(root, id), `${lines.join("\n")}\n`, "utf8");
	return { root, id };
}

const LOG = [
	"$ pnpm test",
	"> vitest run",
	"✓ test/lib/a.test.ts",
	"",
	" FAIL  test/lib/b.test.ts > keeps the budget",
	"AssertionError: expected 5 to be 3",
	"  at test/lib/b.test.ts:42:9",
	" ✓ keeps the title",
	"Test Files  1 failed | 2 passed",
	"Tests  1 failed | 25 passed",
];

describe("readRecallSelected", () => {
	it("filter: matching lines with 1-based numbers, context lines marked by two spaces, default context 2", async () => {
		const { root, id } = await storedObject(LOG);
		const chunk = await readRecallSelected(observationPath(root, id), { offset: 0, filter: "FAIL" }, LIMITS);
		assert.equal(chunk.text, "3  ✓ test/lib/a.test.ts\n4  \n5:  FAIL  test/lib/b.test.ts > keeps the budget\n6  AssertionError: expected 5 to be 3\n7    at test/lib/b.test.ts:42:9\n");
		assert.equal(chunk.matchedLines, 1);
		assert.equal(chunk.totalLines, LOG.length);
		assert.equal(chunk.selection, '[selection: filter="FAIL" context=2 matched=1 of 10 lines]');
		assert.equal(chunk.eof, true);
	});

	it("filter: context 0 keeps only the matches; overlapping windows are merged and ordered", async () => {
		const { root, id } = await storedObject(LOG);
		const none = await readRecallSelected(observationPath(root, id), { offset: 0, filter: "passed", context: 0 }, LIMITS);
		assert.equal(none.text, "9: Test Files  1 failed | 2 passed\n10: Tests  1 failed | 25 passed\n");
		const merged = await readRecallSelected(observationPath(root, id), { offset: 0, filter: "FAIL|AssertionError", context: 1 }, LIMITS);
		assert.equal(merged.matchedLines, 2);
		assert.equal(merged.text, "4  \n5:  FAIL  test/lib/b.test.ts > keeps the budget\n6: AssertionError: expected 5 to be 3\n7    at test/lib/b.test.ts:42:9\n");
	});

	it("filter: zero matches reports coverage with an empty body; CJK lines are whole", async () => {
		const { root, id } = await storedObject(["中文日志一行", "nothing here", "失败：断言错误"]);
		const miss = await readRecallSelected(observationPath(root, id), { offset: 0, filter: "nomatch" }, LIMITS);
		assert.equal(miss.text, "");
		assert.equal(miss.matchedLines, 0);
		assert.equal(miss.selection, '[selection: filter="nomatch" context=2 matched=0 of 3 lines]');
		const cjk = await readRecallSelected(observationPath(root, id), { offset: 0, filter: "失败", context: 0 }, LIMITS);
		assert.equal(cjk.text, "3: 失败：断言错误\n");
	});

	it("filter: an invalid regex is a RecallSelectionError naming the pattern problem", async () => {
		const { root, id } = await storedObject(LOG);
		await assert.rejects(readRecallSelected(observationPath(root, id), { offset: 0, filter: "([" }, LIMITS), RecallSelectionError);
		await assert.rejects(readRecallSelected(observationPath(root, id), { offset: 0, filter: "([" }, LIMITS), /invalid regex/);
	});

	it("filter: the selection is paged by byte offset with the same limits, UTF-8 safe", async () => {
		const lines = Array.from({ length: 300 }, (_, i) => `行${i} 失败 ${"x".repeat(30)}`);
		const { root, id } = await storedObject(lines);
		const first = await readRecallSelected(observationPath(root, id), { offset: 0, filter: "失败", context: 0 }, { maxBytes: 2048, maxLines: 400 });
		assert.equal(first.eof, false);
		assert.ok(first.bytes <= 2048);
		const second = await readRecallSelected(observationPath(root, id), { offset: first.nextOffset, filter: "失败", context: 0 }, { maxBytes: 1 << 20, maxLines: 1000 });
		assert.equal(second.eof, true);
		const joined = first.text + second.text;
		assert.equal(joined.split("\n").filter((l) => l.length > 0).length, 300, "every matching line survives the two pages");
		assert.ok(!joined.includes("\uFFFD"), "no replacement characters at the page boundary");
		await assert.rejects(readRecallSelected(observationPath(root, id), { offset: 10_000_000, filter: "失败" }, LIMITS), /exceeds selection size/);
	});

	it("tail: the last N lines with their numbers; N beyond the length yields the whole object; non-positive N is refused", async () => {
		const { root, id } = await storedObject(LOG);
		const last = await readRecallSelected(observationPath(root, id), { offset: 0, tail: 2 }, LIMITS);
		assert.equal(last.text, "9: Test Files  1 failed | 2 passed\n10: Tests  1 failed | 25 passed\n");
		assert.equal(last.selection, "[selection: tail=2 of 10 lines]");
		assert.equal(last.matchedLines, undefined);
		const all = await readRecallSelected(observationPath(root, id), { offset: 0, tail: 500 }, LIMITS);
		assert.equal(all.text.split("\n").filter((l) => l.length > 0).length, 10);
		await assert.rejects(readRecallSelected(observationPath(root, id), { offset: 0, tail: 0 }, LIMITS), /positive integer/);
		await assert.rejects(readRecallSelected(observationPath(root, id), { offset: 0, tail: -3 }, LIMITS), /positive integer/);
	});

	it("objects above SELECTION_MAX_BYTES refuse selection and point at offset paging", async () => {
		const big = await mkdtemp(join(tmpdir(), "obs-big-"));
		const bigId = `obs_${"b".repeat(24)}`;
		await mkdir(join(big, "objects"), { recursive: true });
		await writeFile(observationPath(big, bigId), Buffer.alloc(SELECTION_MAX_BYTES + 1, 0x79));
		await assert.rejects(readRecallSelected(observationPath(big, bigId), { offset: 0, tail: 5 }, LIMITS), /page with offset instead/);
	});
});

type RegisteredTool = { name: string; parameters: { properties: Record<string, unknown> }; execute: (...args: unknown[]) => Promise<{ content: Array<{ type: string; text: string }>; details: Record<string, unknown> }> };

function captureTool(): RegisteredTool {
	let tool: RegisteredTool | undefined;
	const pi = {
		registerTool: (def: RegisteredTool) => {
			if (def.name === RECALL_TOOL_NAME) tool = def;
		},
		on: () => () => {},
		registerCommand: () => {},
		setStatus: () => {},
	} as unknown as ExtensionAPI;
	createObservationPackExtension({})(pi);
	return tool!;
}

describe("obs_recall through the extension factory", () => {
	it("exposes filter/context/tail and returns the three-line protocol header plus selection details", async () => {
		const tool = captureTool();
		assert.deepEqual(Object.keys(tool.parameters.properties).sort(), ["context", "filter", "id", "offset", "tail"]);
		const { id } = await storedObject(LOG);
		// the factory resolves objects under <sessionDir>/observation-pack/<sessionId>/
		const root = await mkdtemp(join(tmpdir(), "obs-sel-factory-"));
		await mkdir(join(root, "observation-pack", "sess-p02", "objects"), { recursive: true });
		await writeFile(observationPath(join(root, "observation-pack", "sess-p02"), id), `${LOG.join("\n")}\n`, "utf8");
		const ctx = { sessionManager: { getSessionDir: () => root, getSessionId: () => "sess-p02" } };
		const result = await tool.execute("tc", { id, filter: "FAIL|Tests" }, undefined, undefined, ctx as never);
		assert.ok(result.content[0]!.text.startsWith(`[obs_recall id=${id} offset=0 next_offset=`));
		const lines = result.content[0]!.text.split("\n");
		assert.match(lines[1]!, /^\[chunk_bytes=\d+ chunk_lines=8; use next_offset to continue\]$/);
		assert.equal(lines[2], '[selection: filter="FAIL|Tests" context=2 matched=2 of 10 lines]');
		assert.equal(result.content[0]!.text.split("\n").at(-2), "10: Tests  1 failed | 25 passed");
		assert.equal(result.details.matchedLines, 2);
		assert.equal(result.details.totalLines, 10);
		assert.equal(result.details.filter, "FAIL|Tests");
		const tail = await tool.execute("tc", { id, tail: 1 }, undefined, undefined, ctx as never);
		assert.equal(tail.content[0]!.text.split("\n")[2], "[selection: tail=1 of 10 lines]");
		assert.equal(tail.details.tail, 1);
	});

	it("plain offset paging keeps the two-line header and the old details shape (XPKG-04)", async () => {
		const tool = captureTool();
		const { id } = await storedObject(LOG);
		// the factory resolves objects under <sessionDir>/observation-pack/<sessionId>/
		const root = await mkdtemp(join(tmpdir(), "obs-sel-factory-"));
		await mkdir(join(root, "observation-pack", "sess-p02", "objects"), { recursive: true });
		await writeFile(observationPath(join(root, "observation-pack", "sess-p02"), id), `${LOG.join("\n")}\n`, "utf8");
		const ctx = { sessionManager: { getSessionDir: () => root, getSessionId: () => "sess-p02" } };
		const result = await tool.execute("tc", { id }, undefined, undefined, ctx as never);
		const lines = result.content[0]!.text.split("\n");
		assert.ok(lines[0]!.startsWith(`[obs_recall id=${id} offset=0 next_offset=`));
		assert.ok(lines[1]!.startsWith("[chunk_bytes="));
		assert.ok(!lines[2]!.startsWith("[selection: "));
		assert.deepEqual(Object.keys(result.details).sort(), ["bytes", "eof", "id", "lines", "nextOffset", "offset"]);
	});

	it("a bad regex and a bad tail come back as text, not as 'unknown observation id'", async () => {
		const tool = captureTool();
		const { id } = await storedObject(LOG);
		// the factory resolves objects under <sessionDir>/observation-pack/<sessionId>/
		const root = await mkdtemp(join(tmpdir(), "obs-sel-factory-"));
		await mkdir(join(root, "observation-pack", "sess-p02", "objects"), { recursive: true });
		await writeFile(observationPath(join(root, "observation-pack", "sess-p02"), id), `${LOG.join("\n")}\n`, "utf8");
		const ctx = { sessionManager: { getSessionDir: () => root, getSessionId: () => "sess-p02" } };
		const bad = await tool.execute("tc", { id, filter: "([" }, undefined, undefined, ctx as never);
		assert.match(bad.content[0]!.text, /^obs_recall: invalid regex/);
		const tail = await tool.execute("tc", { id, tail: 0 }, undefined, undefined, ctx as never);
		assert.equal(tail.content[0]!.text, "obs_recall: tail must be a positive integer");
	});
});

describe("renderers", () => {
	it("call text names the selection; result header shows coverage; the third protocol line is stripped", () => {
		assert.equal(recallCallText({ id: "obs_abcdefghijklmnopqrstuvwx", filter: "FAIL" }), 'Recall Observation obs_abcdefghijkl · filter "FAIL"');
		assert.equal(recallCallText({ id: "obs_abcdefghijklmnopqrstuvwx", filter: "FAIL", offset: 2048 }), 'Recall Observation obs_abcdefghijkl · filter "FAIL" · +2.0KB');
		assert.equal(recallCallText({ id: "obs_abcdefghijklmnopqrstuvwx", tail: 40 }), "Recall Observation obs_abcdefghijkl · tail 40");
		assert.equal(recallCallText({ id: "obs_abcdefghijklmnopqrstuvwx", offset: 0 }), "Recall Observation obs_abcdefghijkl · start");
		const details: RecallResultDetails = { bytes: 128, lines: 4, eof: true, matchedLines: 2, totalLines: 10 };
		assert.equal(recallHeaderText(details), "2/10 matched · 128B · 4 lines · end ✓");
		assert.equal(recallHeaderText({ bytes: 64, lines: 2, eof: true, tail: 2, totalLines: 10 }), "last 2 of 10 · 64B · 2 lines · end ✓");
		const text = "[obs_recall id=x offset=0 next_offset=4 eof=true]\n[chunk_bytes=4 chunk_lines=1; use next_offset to continue]\n[selection: tail=1 of 10 lines]\n10: Tests  1 failed | 25 passed\n";
		assert.equal(stripProtocolHeader(text, details), "10: Tests  1 failed | 25 passed\n");
		const plain = "[obs_recall id=x offset=0 next_offset=4 eof=true]\n[chunk_bytes=4 chunk_lines=1; use next_offset to continue]\nrow\n";
		assert.equal(stripProtocolHeader(plain, { bytes: 4 }), "row\n");
	});
});
