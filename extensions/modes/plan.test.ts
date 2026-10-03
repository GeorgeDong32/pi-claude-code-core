/**
 * plan file/text tests — carved from utils.test.ts (arch review C3).
 */
import { describe, expect, it, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { TodoItem, extractPlanSection, extractTodoItems, filterSubstantivePlanItems, getPlanFilePath, isCompletionSignal, isPlaceholderPlanItem, isPlanFilePath, markCompletedSteps, shouldSyncAssistantPlanToFile } from "./plan.ts";

describe("extractTodoItems", () => {
	it("extracts numbered items under a Plan: header", () => {
		const msg = `
Plan:
1. First step description here
2. Second step description here
3. Third step description here
`;
		const items = extractTodoItems(msg);
		expect(items.length).toBe(3);
		expect(items[0]).toMatchObject({ step: 1, completed: false });
		expect(items[1].step).toBe(2);
		expect(items[2].step).toBe(3);
	});

	it("returns empty array when no Plan: header", () => {
		expect(extractTodoItems("Just some text without a plan")).toEqual([]);
	});

	it("returns empty array for empty input", () => {
		expect(extractTodoItems("")).toEqual([]);
	});

	it("handles Plan: with bold markers", () => {
		const msg = `**Plan:**\n1. Step one text\n2. Step two text`;
		const items = extractTodoItems(msg);
		expect(items.length).toBe(2);
	});

	it("skips very short items", () => {
		const msg = `Plan:\n1. ok\n2. This is a real step\n`;
		const items = extractTodoItems(msg);
		// very short items may be filtered; depends on threshold (we filter < 3 chars after cleaning)
		const texts = items.map((i) => i.text);
		expect(texts.some((t) => t.includes("real step"))).toBe(true);
	});
});

describe("markCompletedSteps", () => {
	let items: TodoItem[]

	beforeEach(() => {
		items = [
			{ step: 1, text: "First", completed: false },
			{ step: 2, text: "Second", completed: false },
			{ step: 3, text: "Third", completed: false },
		]
	})

	it("marks a single [DONE:n] step", () => {
		markCompletedSteps("Finished [DONE:1]", items);
		expect(items[0].completed).toBe(true);
		expect(items[1].completed).toBe(false);
	});

	it("marks multiple [DONE:n] steps", () => {
		markCompletedSteps("Done with [DONE:1] and [DONE:2]", items);
		expect(items[0].completed).toBe(true);
		expect(items[1].completed).toBe(true);
		expect(items[2].completed).toBe(false);
	});

	it("ignores non-existent step numbers", () => {
		markCompletedSteps("Done [DONE:99]", items);
		expect(items.every((i) => !i.completed)).toBe(true);
	});

	it("handles out-of-order tags", () => {
		markCompletedSteps("Done [DONE:3] [DONE:1]", items);
		expect(items[0].completed).toBe(true);
		expect(items[2].completed).toBe(true);
	});

	it("returns 0 for no tags", () => {
		expect(markCompletedSteps("nothing here", items)).toBe(0);
	});
});

describe("isCompletionSignal", () => {
	it("matches common completion phrases", () => {
		expect(isCompletionSignal("The task is complete.")).toBe(true);
		expect(isCompletionSignal("All done.")).toBe(true);
		expect(isCompletionSignal("Plan complete.")).toBe(true);
		expect(isCompletionSignal("Everything is finished.")).toBe(true);
		expect(isCompletionSignal("I'm done.")).toBe(true);
	});

	it("does not match unrelated text", () => {
		expect(isCompletionSignal("Working on it...")).toBe(false);
		expect(isCompletionSignal("Let me check the file.")).toBe(false);
	});

	it("returns false for empty text", () => {
		expect(isCompletionSignal("")).toBe(false);
	});
});

describe("plan helpers", () => {
	it("filters placeholder plan items", () => {
		expect(isPlaceholderPlanItem("(pending)")).toBe(true)
		expect(filterSubstantivePlanItems([
			{ step: 1, text: "(pending)", completed: false },
			{ step: 2, text: "Implement feature", completed: false },
		])).toHaveLength(1)
	})

	it("extractPlanSection returns only plan block", () => {
		const section = extractPlanSection("Intro\n\nPlan:\n1. Do thing\n\nDone.")
		expect(section).toContain("Plan:")
		expect(section).not.toContain("Intro")
	})

	it("isPlanFilePath uses cwd", () => {
		const cwd = "/proj"
		const planPath = getPlanFilePath(cwd)
		expect(isPlanFilePath(planPath, cwd)).toBe(true)
		expect(isPlanFilePath("plan.md", cwd)).toBe(false)
	})

	it("isPlanFilePath expands tilde paths", () => {
		const home = homedir()
		const cwd = join(home, "proj")
		const planPath = getPlanFilePath(cwd)
		const tildePath = `~${planPath.slice(home.length)}`
		expect(isPlanFilePath(tildePath, cwd)).toBe(true)
	})

	it("rejects symlinked plan file targets", () => {
		const cwd = mkdtempSync(join(tmpdir(), "pm-plan-sym-"))
		const planPath = getPlanFilePath(cwd)
		mkdirSync(dirname(planPath), { recursive: true })
		const outside = join(tmpdir(), `outside-plan-${Date.now()}.md`)
		writeFileSync(outside, "outside")
		symlinkSync(outside, planPath)
		expect(isPlanFilePath(planPath, cwd)).toBe(false)
		rmSync(cwd, { recursive: true, force: true })
		rmSync(outside, { force: true })
	})

	it("shouldSyncAssistantPlanToFile guards hand-edited content", () => {
		expect(shouldSyncAssistantPlanToFile(null)).toBe(true)
		expect(shouldSyncAssistantPlanToFile("# My custom notes\nno plan header")).toBe(
			false,
		)
		expect(
			shouldSyncAssistantPlanToFile(
				"<!-- permission-modes:plan -->\nPlan:\n1. (pending)",
			),
		).toBe(true)
	})
})
