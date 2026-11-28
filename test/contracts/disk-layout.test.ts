import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { writeProjectPermissionsFile } from "../../extensions/modes/permissions-loader.ts";
import { getPlanFilePath } from "../../extensions/modes/plan.ts";
import { modelsPath } from "../../extensions/modes/profiles.ts";
import { GOALS_DIR, ARCHIVED_GOALS_DIR, makeActiveGoalPath } from "../../extensions/goal/storage/goal-files.ts";
import { GOAL_LEDGER_FILE } from "../../extensions/goal/goal-ledger.ts";
import { writeFastMode } from "../../extensions/effort/effort.js";
import { defaultNotesDir, projectsDirFor, sanitizePath } from "../../lib/agent-paths.ts";
import { stateRoot } from "../../extensions/bg-shell/launch.ts";
import { completionBatchText, MESSAGE_TYPE, stallText } from "../../extensions/bg-shell/notify.ts";
import type { Task } from "../../extensions/bg-shell/registry.ts";

describe("P0-CT §4.5 frozen disk layout", () => {
	it("P0-CT-09 (pm): project permissions files live at .pi/projects/<id>/permissions{,.local}.json", () => {
		const root = mkdtempSync(join(tmpdir(), "ct-pm-"));
		writeProjectPermissionsFile(root, { allow: [] } as never, false);
		writeProjectPermissionsFile(root, { allow: [] } as never, true);
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
		const configSrc = readFileSync(
			new URL("../../extensions/modes/config.ts", import.meta.url),
			"utf-8",
		);
					// C2 review R1 P1-1: the frozen root stays homedir()-based on purpose —
			expect(configSrc).toContain('join(homedir(), ".pi", "agent", "permission-modes.json")');
		expect(modelsPath).toBe(join(homedir(), ".pi", "agent", "model-profiles.json"));
	});

	it("P0-CT-09 (effort): fast-mode persists under the unchanged 'pi-effort' key inside settings.json", () => {
		const settingsPath = join(mkdtempSync(join(tmpdir(), "ct-eff-")), "settings.json");
		writeFastMode(settingsPath, true);
		const parsed = JSON.parse(readFileSync(settingsPath, "utf-8")) as Record<string, unknown>;
		expect(parsed["pi-effort"]).toEqual({ fastMode: true });
	});

	it("P0-CT-09 (notes): the default notes directory is the project layer keyed by the git root", () => {
		// Outside any repository the cwd itself is the key.
		expect(defaultNotesDir("/nonexistent/plain-dir", "/home/tester")).toBe(
			join("/home/tester", ".pi", "agent", "projects", "-nonexistent-plain-dir", "memory"),
		);
		// Inside a repository a subdirectory resolves to the root-keyed directory.
		const root = mkdtempSync(join(tmpdir(), "ct-notes-"));
		execFileSync("git", ["init", "-q", root]);
		const sub = join(root, "packages", "a");
		mkdirSync(sub, { recursive: true });
		// git reports the real path (tmpdir is a symlink on macOS)
		expect(projectsDirFor(sub, "/home/tester")).toBe(join("/home/tester", ".pi", "agent", "projects", sanitizePath(realpathSync(root))));
		expect(defaultNotesDir(sub, "/home/tester")).toBe(projectsDirFor(root, "/home/tester") + "/memory");
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
		reviewConfig.setConfigPath(undefined);
		expect(reviewConfig.configPath()).toBe(join(homedir(), ".pi", "agent", "pi-review.json"));
		const reviewRunSrc = readFileSync(
			new URL("../../extensions/review/src/review-run.ts", import.meta.url),
			"utf-8",
		);
		expect(reviewRunSrc.includes('join(cwd, ".pi", "pi-review", "runs", runId)')).toBe(true);
	});

	it("BG-DISK-01: bg-shell session logs live under ~/.pi/agent/cc-core/logs/bg-shell — the cc-core unified logs root (BG-P1)", () => {
		expect(stateRoot()).toBe(join(homedir(), ".pi", "agent", "cc-core", "logs", "bg-shell"));
	});

	it("BG-MSG-02: completion custom message customType 'cc-core-bg-shell' is frozen (followUp + triggerTurn, details {id, exitCode, state})", () => {
		expect(MESSAGE_TYPE).toBe("cc-core-bg-shell");
	});

	it("BG-MSG-02 (batch): N completions wake the model once — one message, one line per task in the frozen order", () => {
		const task = (id: string, description: string | undefined, state: Task["state"], exitCode: number | undefined, command: string): Task => ({
			id,
			description,
			state,
			reason: state === "killed" ? "timed out" : undefined,
			exitCode,
			command,
			cwd: "/",
			logPath: "/dev/null",
			pid: 1,
			nonce: "n",
			scanFrom: 0,
			startedAt: 0,
			endedAt: 4_000,
			readPosition: 0,
			notified: true,
			readFailures: 0,
			logSize: 0,
		});
		const text = completionBatchText([task("bg-1", "first", "exited", 0, "echo a"), task("bg-2", undefined, "killed", undefined, "sleep 9")]);
		expect(text).toBe(
			"Background tasks finished (2):\n- bg-1 (first) · exited (code 0) · ran 4.0s · echo a\n- bg-2 · killed (timed out) · ran 4.0s · sleep 9\nOutput: read each with TaskOutput (id: bg-1, bg-2).",
		);
	});

	it("BG-MSG-02 (stall): the nudge names the id, shows the tail and points at TaskStop/TaskOutput", () => {
		const task = {
			id: "bg-7",
			state: "running",
			startedAt: 0,
			command: "sh setup",
			description: undefined,
		} as unknown as Task;
		expect(stallText(task, "Continue?\n")).toBe(
			"Background task bg-7 appears to be waiting for interactive input (no output for 45s).\nLast output:\nContinue?\n\nThe command is likely blocked on an interactive prompt. Stop it with TaskStop (id: bg-7) and re-run with piped input (e.g. `echo y | command`) or a non-interactive flag if one exists; TaskOutput (id: bg-7) reads more.",
		);
	});
});
