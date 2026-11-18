import { createHash } from "node:crypto";
export { setRunCmd, resetRunCmd } from "./run-cmd.js";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PR_REF_REGEX } from "./pr-ref.js";
import type { ReviewTarget } from "./types.js";

export const WORKSPACE_TTL_MS = 24 * 60 * 60 * 1000;

export interface RunManifest {
	runId: string;
	targetLabel: string;
	targetKind: ReviewTarget["kind"];
	prRef?: string;
	diffPath: string;
	diffSha256: string;
	changedFiles: string[];
	docsOnly: boolean;
	rulePaths: string[];
	historyAvailable: boolean;
	mode: "gh-pr-diff" | "git-pr-fallback" | "local-uncommitted" | "local-vs-default";
	baseSha?: string;
	headSha?: string;
	mergeBase?: string;
	workspacePath: string;
	workspaceHeadSha?: string;
	workspaceWarning?: string;
	workspaceCloned?: boolean;
	runDir: string;
	createdAt: number;
	skippedReviewers?: Array<{ id: string; reason: string }>;
	reviewerIds?: string[];
	diffWarning?: string;
}

export interface PrepInput {
	cwd: string;
	target: ReviewTarget;
	prRepo?: { owner: string; repo: string };
}

export function runDirFor(cwd: string, runId: string): string {
	return join(cwd, ".pi", "pi-review", "runs", runId);
}

export function ensureRunDir(cwd: string, runId: string): string {
	const runDir = runDirFor(cwd, runId);
	mkdirSync(runDir, { recursive: true });
	return runDir;
}

export function pruneStaleRuns(cwd: string, now = Date.now()): string[] {
	const runsRoot = join(cwd, ".pi", "pi-review", "runs");
	if (!existsSync(runsRoot)) return [];
	const removed: string[] = [];
	for (const entry of safeListDir(runsRoot)) {
		const path = join(runsRoot, entry);
		const stat = safeStat(path);
		if (!stat) continue;
		if (now - stat.mtimeMs > WORKSPACE_TTL_MS) {
			try {
				rmSync(path, { recursive: true, force: true });
				removed.push(path);
			} catch {
			}
		}
	}
	return removed;
}

function safeListDir(p: string): string[] {
	try {
		return readdirSync(p);
	} catch {
		return [];
	}
}

function safeStat(p: string): { mtimeMs: number } | null {
	try {
		return statSync(p);
	} catch {
		return null;
	}
}

export function generateRunId(now = Date.now()): string {
	const rand = Math.random().toString(16).slice(2, 8).padEnd(6, "0");
	return `${now.toString(36)}-${rand}`;
}


export function sha256Hex(buf: string | Buffer): string {
	return createHash("sha256").update(buf).digest("hex");
}

export function parseChangedFilesFromDiff(diff: string): {
	files: string[];
	docsOnly: boolean;
	additions: number;
	deletions: number;
} {
	const files: string[] = [];
	const seen = new Set<string>();
	let additions = 0;
	let deletions = 0;
	for (const line of diff.split("\n")) {
		if (line.startsWith("diff --git ")) {
			const m = line.match(/^diff --git a\/(.+) b\/(.+)$/);
			const file = m?.[2] ?? "";
			if (file && !seen.has(file)) {
				seen.add(file);
				files.push(file);
			}
		} else if (line.startsWith("+") && !line.startsWith("+++")) {
			additions++;
		} else if (line.startsWith("-") && !line.startsWith("---")) {
			deletions++;
		}
	}
	const docsOnly =
		files.length > 0 &&
		files.every((f) =>
			/\.(md|mdx|txt|rst)$/i.test(f) ||
			f.startsWith("docs/") ||
			f.startsWith(".agents/") ||
			f.startsWith(".pi/") ||
			f.includes("/docs/") ||
			/CHANGELOG|LICENSE|README/i.test(f),
		);
	return { files, docsOnly, additions, deletions };
}

export function discoverRulePathsLocal(cwd: string): string[] {
	const candidates = ["AGENTS.md", "CLAUDE.md", "CONVENTIONS.md", ".pi/conventions.md"];
	const found: string[] = [];
	for (const name of candidates) {
		if (existsSync(join(cwd, name))) found.push(name);
	}
	for (const rulesDir of [join(cwd, ".pi", "rules"), join(cwd, ".agents", "rules")]) {
		if (!existsSync(rulesDir)) continue;
	try {
		const list = readdirSync(rulesDir) as string[];
			for (const entry of list) {
				if (typeof entry === "string" && entry.endsWith(".md")) {
					found.push(
						rulesDir.includes(".agents/rules") ? join(".agents/rules", entry) : join(".pi/rules", entry),
					);
				}
			}
		} catch {
		}
	}
	return [...new Set(found)];
}

export function parsePrRepo(prRef: string): { owner: string; repo: string; number: string } | null {
	const m = prRef.match(PR_REF_REGEX);
	if (!m) return null;
	return { owner: m[1]!, repo: m[2]!, number: m[3]! };
}

/** Read a manifest from disk (paranoia: corrupted files throw). */
export function readManifest(runDir: string): RunManifest {
	const path = join(runDir, "manifest.json");
	const raw = readFileSync(path, "utf-8");
	return JSON.parse(raw) as RunManifest;
}

export function writeManifest(runDir: string, manifest: RunManifest): void {
	writeFileSync(join(runDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", "utf-8");
}

/** Write the diff body to a deterministic path inside the run dir. */
export function writeDiff(runDir: string, diff: string): string {
	const path = join(runDir, "change.diff");
	writeFileSync(path, diff, "utf-8");
	return path;
}

export function localScratchDir(prefix: string): string {
	const dir = join(tmpdir(), `pi-review-${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}
