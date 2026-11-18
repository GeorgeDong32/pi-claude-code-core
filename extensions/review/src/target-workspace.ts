import { runCmd } from "./run-cmd.js";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parsePrRepo } from "./review-report.js";

// D-FX-1 gave the local base fetch one — a stalled network or a git
// credential prompt must never stall /review indefinitely (the https clone
// fallback for a private repo without gh would otherwise sit on a
// username/password prompt forever). Hard constants, deliberately not
// configurable (no new env/settings key, INV-10). Clone failures remain the
// documented hard error; a timed-out clone surfaces "timed out" through the
// same path.
const PR_CLONE_TIMEOUT_MS = 120_000;
const PR_HEAD_FETCH_TIMEOUT_MS = 60_000;
// gh passes env through to its inner git; suppressing terminal prompts is
// harmless for gh's own auth (gh errors instead of prompting when
// unauthenticated non-interactively).
const NO_CREDENTIAL_PROMPTS = { GIT_TERMINAL_PROMPT: "0" };


export function allocateWorkspaceRoot(prefix = "pi-review-ws"): string {
	const root = join(
		tmpdir(),
		`${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
	);
	mkdirSync(root, { recursive: true });
	return root;
}

export function removeWorkspaceRoot(path: string): void {
	try {
		rmSync(path, { recursive: true, force: true });
	} catch {
	}
}

export interface WorkspaceResult {
	workspacePath: string;
	historyAvailable: boolean;
	warning?: string;
	cloned: boolean;
	workspaceHeadSha?: string;
}

export async function prepareWorkspace(input: {
	cwd: string;
	target: {
		kind: "pr" | "local-git";
		prRef?: string;
		expectedHeadSha?: string;
	};
}): Promise<WorkspaceResult> {
	const { cwd, target } = input;

	if (target.kind === "local-git") {
		const inRepo = await isGitRepo(cwd);
		return {
			workspacePath: cwd,
			historyAvailable: inRepo,
			cloned: false,
			warning: inRepo ? undefined : "Not a git repository — history-context will skip.",
		};
	}

	if (target.kind !== "pr" || !target.prRef) {
		return {
			workspacePath: cwd,
			historyAvailable: false,
			cloned: false,
			warning: "PR target missing prRef — reviewers will see only the diff.",
		};
	}

	const parsed = parsePrRepo(target.prRef);
	if (!parsed) {
		return {
			workspacePath: cwd,
			historyAvailable: false,
			cloned: false,
			warning: "Could not parse PR URL — reviewers will see only the diff.",
		};
	}

	const root = allocateWorkspaceRoot();
	const cloneDir = join(root, `${parsed.repo}-${parsed.number}`);
	mkdirSync(cloneDir, { recursive: true });

	const url = `https://github.com/${parsed.owner}/${parsed.repo}.git`;
	const ghClone = await runCmd(
		"gh",
		["repo", "clone", `${parsed.owner}/${parsed.repo}`, cloneDir, "--", "--depth", "50"],
		{ cwd: root, timeoutMs: PR_CLONE_TIMEOUT_MS, env: NO_CREDENTIAL_PROMPTS },
	);
	const clone = ghClone.exitCode === 0
		? ghClone
		: await runCmd("git", ["clone", "--depth", "50", url, cloneDir], {
			cwd: root,
			timeoutMs: PR_CLONE_TIMEOUT_MS,
			env: NO_CREDENTIAL_PROMPTS,
		});
	if (clone.exitCode !== 0) {
		removeWorkspaceRoot(root);
		throw new Error(
			`pi-review: could not clone ${parsed.owner}/${parsed.repo} (${(ghClone.stderr || clone.stderr).trim().slice(0, 200)}). A fresh diff over a stale local checkout produces false positives, so the review stops here — check gh auth / network and re-run.`,
		);
	}

	const headFetch = await runCmd(
		"git",
		["fetch", "origin", `pull/${parsed.number}/head`, "--quiet"],
		{ cwd: cloneDir, timeoutMs: PR_HEAD_FETCH_TIMEOUT_MS, env: NO_CREDENTIAL_PROMPTS },
	);
	if (headFetch.exitCode !== 0) {
		removeWorkspaceRoot(root);
		throw new Error(
			`pi-review: git fetch pull/${parsed.number}/head failed (${headFetch.stderr.trim().slice(0, 200)}) — aborting instead of reviewing a mismatched checkout.`,
		);
	}
	const fetchHead = (await runCmd("git", ["rev-parse", "FETCH_HEAD"], { cwd: cloneDir })).stdout.trim();
	if (
		target.expectedHeadSha &&
		fetchHead &&
		fetchHead !== target.expectedHeadSha
	) {
		const retry = await runCmd(
			"git",
			["fetch", "origin", `pull/${parsed.number}/head`, "--quiet"],
			{ cwd: cloneDir, timeoutMs: PR_HEAD_FETCH_TIMEOUT_MS, env: NO_CREDENTIAL_PROMPTS },
		);
		if (retry.exitCode !== 0) {
			removeWorkspaceRoot(root);
			throw new Error(
				`pi-review: retry fetch of PR ${parsed.number} head failed (${retry.stderr.trim().slice(0, 200)}) — the first fetch mismatched the diff's head SHA, so the checkout cannot be verified; aborting instead of reviewing a mismatched pair.`,
			);
		}
		const retryHead = (await runCmd("git", ["rev-parse", "FETCH_HEAD"], { cwd: cloneDir })).stdout.trim();
		if (retryHead !== target.expectedHeadSha) {
			removeWorkspaceRoot(root);
			throw new Error(
				`pi-review: PR ${parsed.number} head moved to ${retryHead.slice(0, 12) || "(undeterminable)"} while the diff was captured at ${target.expectedHeadSha.slice(0, 12)} — re-run /review to get a consistent pair.`,
			);
		}
	}
	const headCheckout = await runCmd("git", ["checkout", "--detach", "FETCH_HEAD"], { cwd: cloneDir });
	if (headCheckout.exitCode !== 0) {
		removeWorkspaceRoot(root);
		throw new Error(
			`pi-review: checkout of PR ${parsed.number} head failed (${headCheckout.stderr.trim().slice(0, 200)}).`,
		);
	}

	const workspaceHeadSha = await safeHead(cloneDir);
	return { workspacePath: cloneDir, historyAvailable: true, cloned: true, workspaceHeadSha };
}

async function safeHead(cwd: string): Promise<string | undefined> {
	const r = await runCmd("git", ["rev-parse", "HEAD"], { cwd });
	if (r.exitCode !== 0) return undefined;
	return r.stdout.trim() || undefined;
}

async function isGitRepo(cwd: string): Promise<boolean> {
	const r = await runCmd("git", ["rev-parse", "--git-dir"], { cwd });
	return r.exitCode === 0;
}

