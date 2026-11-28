import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { sessionsDirFor } from "../../lib/agent-paths.ts";
import {
	MAX_BYTES_PER_FILE,
	MAX_FILES_PER_QUERY,
	MAX_TOTAL_BYTES_PER_QUERY,
	READ_CHUNK,
	readLines,
	readLinesBounded,
	recallTransparencyLine,
	sessionRecall,
} from "../../extensions/session-recall/session-recall.ts";

let home: string;
let project: string;
let prevHome: string | undefined;

beforeEach(() => {
	prevHome = process.env.HOME;
	home = mkdtempSync(join(tmpdir(), "recall-home-"));
	project = mkdtempSync(join(tmpdir(), "recall-proj-"));
	process.env.HOME = home;
});

afterEach(() => {
	if (prevHome === undefined) delete process.env.HOME;
	else process.env.HOME = prevHome;
	rmSync(home, { recursive: true, force: true });
	rmSync(project, { recursive: true, force: true });
});

describe("P3-ME-07 session_recall", () => {
	function writeSession(name: string, lines: unknown[]): void {
		// C8/R2-P1: the sessions dir uses pi's WRAPPING-dash naming — compute
		const dir = sessionsDirFor(project, home);
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, name),
			lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n") + "\n",
		);
	}

	it("matches user/assistant text, ignores toolResult, counts bad lines, filters by time and limit", async () => {
		writeSession("a.jsonl", [
			{ type: "message", timestamp: "2026-09-20T10:00:00Z", message: { role: "user", content: [{ type: "text", text: "fix the deploy pipeline" }] } },
			"not-json-garbage",
			{ type: "message", timestamp: "2026-09-21T10:00:00Z", message: { role: "assistant", content: [{ type: "text", text: "deploy pipeline fixed" }] } },
			{ type: "message", message: { role: "toolResult", content: [{ type: "text", text: "deploy pipeline output" }] } },
		]);

		const result = await sessionRecall({ query: "deploy pipeline", cwd: project, home });
		expect(result.skippedLines).toBe(1);
		expect(result.hits.length).toBe(2);
		expect(result.hits.map((h) => h.role)).toEqual(["user", "assistant"]);

		const since = await sessionRecall({ query: "deploy pipeline", cwd: project, home, since: "2026-09-21" });
		expect(since.hits.length).toBe(1);
		expect(since.hits[0].role).toBe("assistant");

		const limited = await sessionRecall({ query: "deploy pipeline", cwd: project, home, limit: 1 });
		expect(limited.hits.length).toBe(1);

		const empty = await sessionRecall({ query: "anything", cwd: "/nonexistent-project", home });
		expect(empty.hits).toHaveLength(0);
		expect(empty.scannedFiles).toBe(0);
	});

	it("sessionsDirFor matches pi's SessionManager naming: double dashes on both ends, no leading slash", () => {
		// pi: `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--` (session-manager.js)
		expect(sessionsDirFor("/Users/x/Coding/proj", "/h")).toBe("/h/.pi/agent/sessions/--Users-x-Coding-proj--");
		expect(sessionsDirFor("/Users/x/Coding/proj/", "/h")).toBe("/h/.pi/agent/sessions/--Users-x-Coding-proj--");
	});

	it("C8: readLinesBounded yields prefix lines, marks truncation, drops the partial tail", async () => {
		const dir = join(home, "bounded");
		mkdirSync(dir, { recursive: true });
		const small = join(dir, "small.jsonl");
		writeFileSync(small, '{"a":1}\n{"a":2}\n');
		const exact = join(dir, "exact.jsonl");
		const twoLine = '{"a":1}\n{"a":2}\n';
		writeFileSync(exact, twoLine);
		const big = join(dir, "big.jsonl");
		const filler = `{"pad":"${"x".repeat(60)}"}`;
		writeFileSync(big, Array.from({ length: 40 }, () => filler).join("\n") + "\n");

		const full = readLinesBounded(small, 1024);
		const lines: string[] = [];
		let meta = { bytes: 0, truncated: false };
		while (true) {
			const n = await full.next();
			if (n.done) { meta = n.value; break; }
			lines.push(n.value.line);
		}
		expect(lines).toEqual(['{"a":1}', '{"a":2}']);
		expect(meta.truncated).toBe(false);

		const exactReader = readLinesBounded(exact, twoLine.length);
		let exactMeta = { bytes: 0, truncated: false };
		while (true) {
			const n = await exactReader.next();
			if (n.done) { exactMeta = n.value; break; }
		}
		expect(exactMeta.truncated).toBe(false);

		const capped = readLinesBounded(big, 1000);
		const cappedLines: string[] = [];
		let cappedMeta = { bytes: 0, truncated: false };
		while (true) {
			const n = await capped.next();
			if (n.done) { cappedMeta = n.value; break; }
			cappedLines.push(n.value.line);
		}
		expect(cappedMeta.truncated).toBe(true);
		expect(cappedMeta.bytes).toBeLessThanOrEqual(1000);
		expect(cappedLines.length).toBeGreaterThan(0);
		expect(cappedLines.length).toBeLessThan(40);
	});

	it("C8: caps surface via transparency — size truncation and budget exhaustion (injected reader)", async () => {
		const mk = (lines: string[], bytes: number, truncated: boolean) =>
			async function* (): AsyncGenerator<{ line: string; number: number }, { bytes: number; truncated: boolean }> {
				for (const [i, l] of lines.entries()) yield { line: l, number: i + 1 };
				return { bytes, truncated };
			};
		const entry = (text: string) => JSON.stringify({ type: "message", message: { role: "user", content: text } });
		const listFiles = async () => ["newest.jsonl", "old.jsonl"];
		const hit = entry("needle found here");
		const miss = entry("nothing relevant");

		const byBasename = (map: Record<string, { lines: string[]; bytes: number; truncated: boolean }>) =>
			async function* (path: string): AsyncGenerator<{ line: string; number: number }, { bytes: number; truncated: boolean }> {
				const spec = map[path.split("/").pop()!];
				for (const [i, l] of spec.lines.entries()) yield { line: l, number: i + 1 };
				return { bytes: spec.bytes, truncated: spec.truncated };
			};
		const r1 = await sessionRecall({
			query: "needle",
			cwd: project,
			home,
			deps: {
				listSessionFiles: listFiles,
				readLinesBounded: byBasename({
					"newest.jsonl": { lines: [hit], bytes: MAX_BYTES_PER_FILE, truncated: true },
					"old.jsonl": { lines: [miss], bytes: 10, truncated: false },
				}) as never,
			},
		});
		expect(r1.hits).toHaveLength(1);
		expect(r1.truncatedSizeFiles).toBe(1);
		expect(r1.budgetExhausted).toBe(false);
		expect(recallTransparencyLine(r1)).toContain("truncated_size=1");
		expect(recallTransparencyLine(r1)).toContain("budget=ok");
		expect(recallTransparencyLine(r1)).not.toContain("narrow the query");

		const r2 = await sessionRecall({
			query: "needle",
			cwd: project,
			home,
			deps: { listSessionFiles: listFiles, readLinesBounded: mk([miss], MAX_TOTAL_BYTES_PER_QUERY, true) as never },
		});
		expect(r2.scannedFiles).toBe(1);
		expect(r2.budgetExhausted).toBe(true);
		expect(recallTransparencyLine(r2)).toContain("budget=exhausted");
		expect(recallTransparencyLine(r2)).toContain("narrow the query");

		const many = Array.from({ length: MAX_FILES_PER_QUERY + 5 }, (_, i) => `f${i}.jsonl`);
		const r3 = await sessionRecall({
			query: "needle",
			cwd: project,
			home,
			deps: { listSessionFiles: async () => many, readLinesBounded: mk([miss], 10, false) as never },
		});
		expect(r3.scannedFiles).toBe(MAX_FILES_PER_QUERY);
		expect(r3.budgetExhausted).toBe(true);
	});

	it("C8/code-R1: hitting the limit CLOSES the reader generator (no abandoned fd)", async () => {
		let finallyRuns = 0;
		const hitLine = JSON.stringify({ type: "message", message: { role: "user", content: "needle found here" } });
		const lines = [hitLine, hitLine, hitLine];
		const reader = async function* (): AsyncGenerator<{ line: string; number: number }, { bytes: number; truncated: boolean }> {
			try {
				for (const [i, l] of lines.entries()) yield { line: l, number: i + 1 };
				return { bytes: 42, truncated: false };
			} finally {
				finallyRuns++; // runs on natural completion AND on iterator.return()
			}
		};
		const r = await sessionRecall({
			query: "needle",
			cwd: project,
			home,
			limit: 1,
			deps: { listSessionFiles: async () => ["only.jsonl"], readLinesBounded: reader as never },
		});
		expect(r.hits).toHaveLength(1);
		expect(finallyRuns).toBe(1);
	});
});

