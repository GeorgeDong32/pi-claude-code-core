/**
 * P2-BUS-02 — goal/review channels on the capability bus.
 *
 * goal: restoring a focused active goal from session entries publishes
 * active:true; /goal-pause flips paused; readCoreStatus() sees both.
 * review: the pi_review_report tool completing publishes done+lastRunAt
 * (running is published by the /review command path, exercised in
 * P2-REL smoke). All reads go through the published types reader.
 */
import { describe, expect, it, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FakeHost, clearCoreGlobals, snapshotCoreGlobals } from "../contracts/fake-host.ts";
import { resetCoreBusForTests } from "../../extensions/bus.ts";
import { targets } from "../contracts/targets.ts";
import { readCoreStatus } from "../../types/core-status.mjs";
import type { CoreStatus } from "../../types/index.d.mts";
// the .mjs runtime has no sibling declaration (deliberate split-name layout,
// see DEVIATIONS #13) — assert the published contract type at the boundary
const reader = readCoreStatus as (g?: unknown) => CoreStatus;
import { normalizeGoalRecord } from "../../extensions/goal/goal-record.ts";

let globalsSnapshot: Record<string, unknown>;

beforeEach(() => {
	globalsSnapshot = snapshotCoreGlobals();
	clearCoreGlobals();
	resetCoreBusForTests();
});

function snapshotFromGlobal(): Record<string, unknown> {
	return (globalThis as Record<string, unknown>).__piClaudeCodeCore as Record<string, unknown>;
}

describe("P2-BUS-02 goal/review channels", () => {
	it("goal: restored focused goal publishes active; /goal-pause flips paused; reader sees it", async () => {
		const goalRecord = normalizeGoalRecord({ objective: "ship the core", status: "active" });
		expect(goalRecord).not.toBeNull();

		const host = new FakeHost();
		targets.goal.factory(host.asPi());
		const cwd = mkdtempSync(join(tmpdir(), "bus-goal-"));
		// the restore path reads the goal pool from disk (.pi/goals)
		const { ensureDirectory, atomicWriteGoalFile, serializeGoalFile, makeActiveGoalPath, GOALS_DIR } =
			await import("../../extensions/goal/storage/goal-files.js");
		const fileCtx = { cwd };
		ensureDirectory(fileCtx, GOALS_DIR);
		atomicWriteGoalFile(fileCtx, GOALS_DIR, makeActiveGoalPath(goalRecord!), serializeGoalFile(goalRecord!));
		const ctx = host.makeCtx({
			cwd,
			ui: true,
			sessionEntries: [
				{ type: "custom", customType: "pi-goal-state", data: { version: 3, goal: goalRecord } },
				{ type: "custom", customType: "pi-goal-focus", data: { version: 1, focusedGoalId: goalRecord!.id, reason: "selected" } },
			],
		});
		await host.fire("session_start", {}, ctx);

		type GoalChannel = { active: boolean; paused?: boolean; summary: string | null };
		let snap = snapshotFromGlobal() as unknown as { goal: GoalChannel };
		expect(snap.goal.active).toBe(true);
		expect(snap.goal.paused).toBe(false);
		expect(snap.goal.summary).toContain("ship the core");
		expect(reader(globalThis).goal.active).toBe(true);

		const pause = host.commands.get("goal-pause");
		expect(pause).toBeDefined();
		await pause?.("", ctx);

		snap = snapshotFromGlobal() as unknown as { goal: GoalChannel };
		expect(snap.goal.active).toBe(true);
		expect(snap.goal.paused).toBe(true);
		expect(reader(globalThis).goal.paused).toBe(true);

		const resume = host.commands.get("goal-resume");
		expect(resume).toBeDefined();
		await resume?.("", ctx);
		snap = snapshotFromGlobal() as unknown as { goal: GoalChannel };
		expect(snap.goal.active).toBe(true);
		expect(snap.goal.paused).toBe(false);
		expect(reader(globalThis).goal.paused).toBe(false);
	});

	it("review: report tool completion publishes done + lastRunAt on the bus", async () => {
		const reviewReport = await import("../../extensions/review/src/review-report.js");
		const host = new FakeHost();
		targets.review.factory(host.asPi());
		const cwd = mkdtempSync(join(tmpdir(), "bus-review-"));

		const runId = "bus-e2e";
		const runDir = reviewReport.ensureRunDir(cwd, runId);
		const manifest = {
			runId,
			targetLabel: "local changes",
			targetKind: "local-git" as const,
			diffPath: join(runDir, "change.diff"),
			diffSha256: "a".repeat(64),
			changedFiles: ["a.ts"],
			docsOnly: false,
			rulePaths: [],
			historyAvailable: true,
			mode: "local-uncommitted" as const,
			workspacePath: cwd,
			runDir,
			createdAt: Date.now(),
		};
		reviewReport.writeManifest(runDir, manifest as never);

		const reviewerMd = "## Summary\nok\n\n## Findings\nNo findings.";
		const gateMd = `gate synthesis\n\n\`\`\`json\n${JSON.stringify({ verdict: "approve", issues: [] }, null, 1)}\n\`\`\`\n`;
		const workflowReturn = {
			reviewers: [{ key: "conventions", ok: true, output: reviewerMd, structuredOutput: { issues: [] } }],
			gate: { key: "gate", ok: true, output: gateMd, structuredOutput: { verdict: "approve", issues: [] } },
		};

		const before = Date.now();
		const reportTool = host.tools.get("pi_review_report");
		expect(reportTool).toBeDefined();
		await reportTool?.execute(
			"call-1",
			{ runId, workflowReturn },
			undefined,
			undefined,
			{ cwd },
		);

		const snap = snapshotFromGlobal() as { review: { status: string; lastRunAt: number | null } };
		expect(snap.review.status).toBe("done");
		expect(snap.review.lastRunAt).toBeGreaterThanOrEqual(before);
		const status = reader(globalThis).review;
		expect(status.status).toBe("done");
		expect(typeof status.lastRunAt).toBe("number");
	});
});
