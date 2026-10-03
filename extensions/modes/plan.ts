/**
 * modes/plan.ts — the plan concept: plan.md file management plus plan text
 * parsing. Carved out of the old modes/utils.ts grab-bag (arch review C3,
 * 2026-10-03); behavior unchanged. Owns: plan file path/IO (template,
 * ensure/read/write, symlink-annotated path checks), workspace path
 * resolution, and the todo-list text grammar (extract/mark/DONE/completion
 * signals, placeholder filtering, assistant Plan:-section sync).
 */
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { createHash } from "node:crypto"
import path from "node:path"
import { expandUserPath, getProjectId } from "./path-safety.ts"

export interface TodoItem {
	step: number;
	text: string;
	completed: boolean;
}

export function cleanStepText(text: string): string {
	let cleaned = text
		.replace(/\*{1,2}([^*]+)\*{1,2}/g, "$1") // strip bold/italic
		.replace(/`([^`]+)`/g, "$1") // strip inline code
		.replace(
			/^(Use|Run|Execute|Create|Write|Read|Check|Verify|Update|Modify|Add|Remove|Delete|Install)\s+(the\s+)?/i,
			"",
		)
		.replace(/\s+/g, " ")
		.trim();

	if (cleaned.length > 0) {
		cleaned = cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
	}
	if (cleaned.length > 50) {
		cleaned = `${cleaned.slice(0, 47)}...`;
	}
	return cleaned;
}

/** Extract a numbered list under a `Plan:` header into TodoItems. */
export function extractTodoItems(message: string): TodoItem[] {
	const items: TodoItem[] = [];
	const headerMatch = message.match(/\*{0,2}Plan:\*{0,2}\s*\n/i);
	if (!headerMatch) return items;

	const planSection = message.slice(message.indexOf(headerMatch[0]) + headerMatch[0].length);
	const numberedPattern = /^\s*(\d+)[.)]\s+\*{0,2}([^*\n]+)/gm;

	for (const match of planSection.matchAll(numberedPattern)) {
		const text = match[2]
			.trim()
			.replace(/\*{1,2}$/, "")
			.trim();
		if (text.length > 5 && !text.startsWith("`") && !text.startsWith("/") && !text.startsWith("-")) {
			const cleaned = cleanStepText(text);
			if (cleaned.length > 3) {
				items.push({ step: items.length + 1, text: cleaned, completed: false });
			}
		}
	}
	return items;
}

export function extractDoneSteps(message: string): number[] {
	const steps: number[] = [];
	for (const match of message.matchAll(/\[DONE:(\d+)\]/gi)) {
		const step = Number(match[1]);
		if (Number.isFinite(step)) steps.push(step);
	}
	return steps;
}

/** Mark any `[DONE:n]` steps found in `text` complete. Returns how many tags were seen. */
export function markCompletedSteps(text: string, items: TodoItem[]): number {
	const doneSteps = extractDoneSteps(text);
	for (const step of doneSteps) {
		const item = items.find((t) => t.step === step);
		if (item) item.completed = true;
	}
	return doneSteps.length;
}

const COMPLETION_SIGNALS: RegExp[] = [
	/\b(plan|task|work|job|everything|all)\s+(is\s+|are\s+|has\s+been\s+)?(complete|completed|done|finished)\b/i,
	/\ball\s+done\b/i,
	/\bno\s+(more|further)\s+(steps|tasks|actions|work)\b/i,
	/\b(i'?m|i\s+am)\s+(done|finished)\b/i,
	/\bfinished\b/i,
];

/** Heuristic: does the assistant text claim the work is finished? */
export function isCompletionSignal(text: string): boolean {
	return COMPLETION_SIGNALS.some((p) => p.test(text));
}

/** Stable hash of plan content for popup throttling. */
export function hashPlan(content: string): string {
	return createHash("sha256").update(content).digest("hex").slice(0, 16)
}

// ---- Plan file helpers (v2.0.0) -----------------------------------------

const PLAN_FILE_TEMPLATE = `# Plan

<!-- permission-modes:plan -->
Plan:
1. (pending)
<!-- /permission-modes:plan -->
`

export function getPlanFilePath(cwd: string): string {
	const id = getProjectId(cwd)
	return path.join(cwd, ".pi", "projects", id, "plan.md")
}

export function readPlanFile(cwd: string): string | null {
	try {
		const filePath = getPlanFilePath(cwd)
		if (!existsSync(filePath)) return null
		return readFileSync(filePath, "utf-8")
	} catch {
		return null
	}
}

export function writePlanFile(cwd: string, content: string): void {
	assertWritablePlanPath(cwd)
	const filePath = getPlanFilePath(cwd)
	mkdirSync(path.dirname(filePath), { recursive: true })
	writeFileSync(filePath, content, { mode: 0o644 })
}

export function ensurePlanFile(cwd: string): string {
	const filePath = getPlanFilePath(cwd)
	try {
		assertWritablePlanPath(cwd)
		if (!existsSync(filePath)) {
			mkdirSync(path.dirname(filePath), { recursive: true })
			writeFileSync(filePath, PLAN_FILE_TEMPLATE, { mode: 0o644 })
		}
	} catch (err) {
		console.warn("[permission-modes] Failed to ensure plan file:", err)
	}
	return filePath
}

function assertWritablePlanPath(cwd: string): void {
	const planPath = path.resolve(getPlanFilePath(cwd))
	const cwdResolved = path.resolve(cwd)
	if (planPathHasSymlinkAncestor(planPath, cwdResolved)) {
		throw new Error(`Refusing to write symlinked plan path: ${planPath}`)
	}
	try {
		if (existsSync(planPath) && lstatSync(planPath).isSymbolicLink()) {
			throw new Error(`Refusing to write symlinked plan file: ${planPath}`)
		}
	} catch (err) {
		if (err instanceof Error && err.message.startsWith("Refusing")) throw err
	}
}

export function resolveWorkspacePath(targetPath: string, cwd: string): string {
	if (!targetPath) return path.resolve(cwd)
	const p = expandUserPath(targetPath)
	return path.isAbsolute(p) ? path.resolve(p) : path.resolve(cwd, p)
}

export function isPlanFilePath(targetPath: string, cwd: string): boolean {
	if (!targetPath) return false
	const resolved = resolveWorkspacePath(targetPath, cwd)
	const planPath = path.resolve(getPlanFilePath(cwd))
	if (resolved !== planPath) return false
	if (planPathHasSymlinkAncestor(planPath, path.resolve(cwd))) return false
	if (!existsSync(planPath)) return true
	try {
		return realpathSync(resolved) === realpathSync(planPath)
	} catch {
		return false
	}
}

function planPathHasSymlinkAncestor(filePath: string, stopAt: string): boolean {
	const stop = path.resolve(stopAt)
	let current = path.resolve(filePath)
	while (true) {
		if (current === stop) break
		try {
			if (lstatSync(current).isSymbolicLink()) return true
		} catch {
			/* missing segment — ok while creating plan file */
		}
		const parent = path.dirname(current)
		if (parent === current) break
		current = parent
	}
	return false
}

export function isPlaceholderPlanItem(text: string): boolean {
	const t = text.trim().toLowerCase()
	return t === "(pending)" || t === "pending" || t.length <= 3
}

export function filterSubstantivePlanItems(items: TodoItem[]): TodoItem[] {
	return items.filter((item) => !isPlaceholderPlanItem(item.text))
}

/** Extract the `Plan:` section from an assistant message for plan.md sync. */
export function extractPlanSection(message: string): string | null {
	const headerMatch = message.match(/\*{0,2}Plan:\*{0,2}\s*\n/i)
	if (!headerMatch) return null
	const start = message.indexOf(headerMatch[0])
	const section = message.slice(start).trim()
	return section.length > 0 ? section : null
}

/** True when plan.md is missing, empty, or still the default placeholder template. */
export function shouldSyncAssistantPlanToFile(planContent: string | null): boolean {
	if (!planContent?.trim()) return true
	if (!planContent.includes("<!-- permission-modes:plan -->")) return false
	return filterSubstantivePlanItems(extractTodoItems(planContent)).length === 0
}
