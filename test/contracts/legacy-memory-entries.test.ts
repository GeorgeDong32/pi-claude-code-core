import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";

import { sessionsDirFor } from "../../lib/agent-paths.ts";
import { sessionRecall } from "../../extensions/session-recall/session-recall.ts";

const FIXTURE = new URL("./fixtures/legacy-memory-entries.jsonl", import.meta.url).pathname;

let home: string;
let project: string;
let prevHome: string | undefined;

beforeEach(() => {
	prevHome = process.env.HOME;
	home = mkdtempSync(join(tmpdir(), "legacy-home-"));
	project = mkdtempSync(join(tmpdir(), "legacy-proj-"));
	process.env.HOME = home;
});
afterEach(() => {
	if (prevHome === undefined) delete process.env.HOME;
	else process.env.HOME = prevHome;
	rmSync(home, { recursive: true, force: true });
	rmSync(project, { recursive: true, force: true });
});

// The memory module that produced these entry shapes was removed; session
// files written before that still carry them, and loading, branching and
// session_recall must keep working.
describe("legacy memory entries in existing session files", () => {
	it("loads through the real SessionManager with every entry, branch chain and custom message intact", () => {
		const dir = sessionsDirFor(project, home);
		mkdirSync(dir, { recursive: true });
		const file = join(dir, "2026-10-02T04-59-49-000Z_01a20e0e-0000-4000-8000-00000000legacy.jsonl");
		copyFileSync(FIXTURE, file);

		const sm = SessionManager.open(file, undefined, project);
		const entries = sm.getEntries();
		expect(entries.map((e) => (e.type === "custom_message" || e.type === "custom" ? `${e.type}:${(e as { customType?: string }).customType}` : e.type))).toEqual([
			"message",
			"custom_message:pi-memory-recall",
			"message",
			"custom:cc-core-memory-stats",
			"custom_message:pi-memory-status",
		]);
		const branch = sm.getBranch();
		expect(branch).toHaveLength(5);
		for (let i = 1; i < branch.length; i += 1) {
			expect(branch[i]!.parentId).toBe(branch[i - 1]!.id);
		}
		const projected = sm.buildSessionProjection().messages as Array<Record<string, unknown>>;
		expect(projected.map((m) => m.customType).filter(Boolean)).toEqual(["pi-memory-recall", "pi-memory-status"]);
		const stats = entries.find((e) => (e as { customType?: string }).customType === "cc-core-memory-stats") as { data?: { indexRows?: number } };
		expect(stats.data?.indexRows).toBe(79);
	});

	it("session_recall still finds the user and assistant text around them", async () => {
		const dir = sessionsDirFor(project, home);
		mkdirSync(dir, { recursive: true });
		copyFileSync(FIXTURE, join(dir, "2026-10-02T04-59-49-000Z_01a20e0e-0000-4000-8000-00000000legacy.jsonl"));
		const result = await sessionRecall({ query: "deploy pipeline", cwd: project, home });
		expect(result.hits.map((h) => h.role)).toEqual(["user"]);
		expect(result.hits[0]!.text).toContain("deploy pipeline note");
		expect(result.skippedLines).toBe(0);
		expect(result.scannedFiles).toBe(1);
	});
});
