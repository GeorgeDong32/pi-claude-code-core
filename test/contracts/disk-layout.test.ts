/**
 * P0-CT §4.5 — frozen disk-layout contracts (P0-CT-09).
 *
 * Each module's on-disk locations are pinned so the core merge can never
 * silently move them (existing user data + session replay compatibility).
 * Default-path constants are asserted via a query-suffixed dynamic import
 * (fresh module instance, immune to the test-time path redirects).
 */
import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { writeProjectPermissionsFile } from "../../extensions/modes/permissions-loader.ts";
import { getPlanFilePath } from "../../extensions/modes/plan.ts";
import { modelsPath } from "../../extensions/modes/profiles.ts";
import { GOALS_DIR, ARCHIVED_GOALS_DIR, makeActiveGoalPath } from "../../extensions/goal/storage/goal-files.ts";
import { GOAL_LEDGER_FILE } from "../../extensions/goal/goal-ledger.ts";
import { writeFastMode } from "../../extensions/effort/effort.js";
import { loadQueue, queueDir, writeQueueRecord, type QueueRecord } from "../../extensions/memory/queue.ts";

describe("P0-CT §4.5 frozen disk layout", () => {
	it("P0-CT-09 (pm): project permissions files live at .pi/projects/<id>/permissions{,.local}.json", () => {
		const root = mkdtempSync(join(tmpdir(), "ct-pm-"));
		writeProjectPermissionsFile(root, { allow: [] } as never, false);
		writeProjectPermissionsFile(root, { allow: [] } as never, true);
		// project id is derived from cwd by pm; assert the shape of the layout.
		const projectsDir = join(root, ".pi", "projects");
		const ids = readdirSync(projectsDir);
		expect(ids.length).toBe(1);
		expect(existsSync(join(projectsDir, ids[0], "permissions.json"))).toBe(true);
		expect(existsSync(join(projectsDir, ids[0], "permissions.local.json"))).toBe(true);
	});

	it("P0-CT-09 (pm): plan file path is .pi/projects/<id>/plan.md under cwd", () => {
		const cwd = mkdtempSync(join(tmpdir(), "ct-plan-"));
		const p = getPlanFilePath(cwd);
		expect(p.startsWith(join(cwd, ".pi", "projects"))).toBe(true);
		expect(p.endsWith(join("plan.md"))).toBe(true);
	});

	it("P0-CT-09 (pm): global config + model-profiles defaults point at ~/.pi/agent/", () => {
		// config.ts keeps its default in a module-level initializer with no
		// restore-capable setter, so pin the source line (any path change
		// rewrites it). profiles.ts snapshots its load-time default into the
		// modelsPath export, which is immune to the test-time redirect.
		const configSrc = readFileSync(
			new URL("../../extensions/modes/config.ts", import.meta.url),
			"utf-8",
		);
		expect(configSrc).toContain('join(homedir(), ".pi", "agent", "permission-modes.json")');
		expect(modelsPath).toBe(join(homedir(), ".pi", "agent", "model-profiles.json"));
	});

	it("P0-CT-09 (effort): fast-mode persists under the unchanged 'pi-effort' key inside settings.json", () => {
		const settingsPath = join(mkdtempSync(join(tmpdir(), "ct-eff-")), "settings.json");
		writeFastMode(settingsPath, true);
		const parsed = JSON.parse(readFileSync(settingsPath, "utf-8")) as Record<string, unknown>;
		expect(parsed["pi-effort"]).toEqual({ fastMode: true });
	});

	it("P0-CT-09 (memory): pending-extraction queue lives under <agentDir>/memory-queue with atomic v1 records (spec 2026-10-03)", () => {
		// default anchor: the frozen global location under ~/.pi/agent
		expect(queueDir(join(homedir(), ".pi", "agent"))).toBe(join(homedir(), ".pi", "agent", "memory-queue"));
		const agentDir = mkdtempSync(join(tmpdir(), "ct-mq-"));
		const rec: QueueRecord = {
			v: 1,
			sessionId: "s1234567890abcdef",
			projectsDir: "/proj/x",
			cwd: "/proj/x",
			savedAt: Date.now(),
			attempts: 0,
			parts: [{ role: "user", text: "tail" }],
		};
		writeQueueRecord(agentDir, rec);
		const files = readdirSync(queueDir(agentDir));
		expect(files).toHaveLength(1);
		expect(files[0]).toMatch(/^s1234567-\d+\.json$/); // 8-char session prefix + epoch
		expect(files.some((f) => f.endsWith(".tmp"))).toBe(false); // atomic write, no residue
		const staged = loadQueue(agentDir);
		expect(staged).toHaveLength(1);
		expect(staged[0]!.record.sessionId).toBe("s1234567890abcdef");
		// same-session merge: staging again replaces, never duplicates
		writeQueueRecord(agentDir, { ...rec, savedAt: Date.now() + 1 });
		expect(readdirSync(queueDir(agentDir))).toHaveLength(1);
	});

	it("P0-CT-09 (goal): goals dir, archive dir, active file naming, and ledger file are unchanged", () => {
		expect(GOALS_DIR).toBe(".pi/goals");
		expect(ARCHIVED_GOALS_DIR).toBe(".pi/goals/archived");
		expect(GOAL_LEDGER_FILE).toBe(".pi/goals/goal_events.jsonl");
		const active = makeActiveGoalPath({
			id: "abc123",
			createdAt: "2026-09-20T10:00:00.000Z",
		} as never);
		expect(active.startsWith(".pi/goals/active_goal_")).toBe(true);
		expect(active.endsWith("_abc123.md")).toBe(true);
	});

	it("P0-CT-09 (review): config default path and run dirs are unchanged", async () => {
		const reviewConfig = await import("../../extensions/review/src/config.js");
		reviewConfig.setConfigPath(undefined); // restore the default
		expect(reviewConfig.configPath()).toBe(join(homedir(), ".pi", "agent", "pi-review.json"));
		// run dir convention lives inside prepareRun; the frozen shape is
		// <cwd>/.pi/pi-review/runs/<runId>. No exported constructor exists, so
		// pin the source path segment (any layout change rewrites this line).
		const reviewRunSrc = readFileSync(
			new URL("../../extensions/review/src/review-run.ts", import.meta.url),
			"utf-8",
		);
		expect(reviewRunSrc.includes('join(cwd, ".pi", "pi-review", "runs", runId)')).toBe(true);
	});
});
