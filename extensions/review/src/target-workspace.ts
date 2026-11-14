/**
 * Target workspace prep — clone (or worktree) the target repository so
 * reviewer children can read its source, history and unchanged files.
 *
 * Real failure (PR #18689): reviewers shared cwd with the plugin repo, so
 * `history-context` and `code-comments` had no relevant code. The plugin now
 *   - for PRs: shallow-clones `owner/repo` into a scratch dir (gh first so
 *     private repos use the gh credential), checks out the PR head from
 *     FETCH_HEAD, and verifies the landed SHA against the diff's head SHA.
 *   - for local-git dirty: uses the user's cwd directly (already correct).
 *   - for local-git clean vs default branch: uses the user's cwd after
 *     `git fetch origin <base>`.
 *
 * The workspace is **read-only by convention**: reviewers are not given
 * write tools and the plugin never modifies it.
 *
 * A failed PR clone is a hard error (not a silent fallback to the user's
 * cwd): a fresh GitHub diff plus a stale local checkout is the #1 false
 * positive source observed in the field (diff@new, files@old).
 *
 * R2 (2026-11-15): the inner HEAD-mismatch guard no longer silently passes
 * when the one retry fetch itself fails — `retry.exitCode !== 0` throws
 * ("retry fetch failed", distinct copy), as does a retry that still lands
 * on a different head ("head moved"). Both clean up the scratch root first.
 *
 * FX-5 (2026-11-14): PR-path clone/fetch commands carry hard ceilings
 * (PR_CLONE_TIMEOUT_MS / PR_HEAD_FETCH_TIMEOUT_MS) and
 * GIT_TERMINAL_PROMPT=0 so a stalled network or a credential prompt can
 * never hang /review — failures surface through the existing hard-error
 * throws with "timed out" in stderr.
 */
import { runCmd } from "./run-cmd.js";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parsePrRepo } from "./review-report.js";

// FX-5 (2026-11-14): PR-path commands get hard ceilings for the same reason
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


/** Allocate a scratch root under the OS tmpdir; created on disk. */
export function allocateWorkspaceRoot(prefix = "pi-review-ws"): string {
	const root = join(
		tmpdir(),
		`${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
	);
	mkdirSync(root, { recursive: true });
	return root;
}

/** Best-effort cleanup; ignores errors. */
export function removeWorkspaceRoot(path: string): void {
	try {
		rmSync(path, { recursive: true, force: true });
	} catch {
		/* ignore */
	}
}

export interface WorkspaceResult {
	/** Absolute path reviewers should use as cwd. */
	workspacePath: string;
	/** True when `git log` / `blame` will work in the workspace. */
	historyAvailable: boolean;
	/** Optional failure note — when set, reviewers must `skipped` the affected lane. */
	warning?: string;
	/** Whether we cloned (true) or reused the user cwd (false). */
	cloned: boolean;
	/** HEAD SHA landed in the workspace, when determinable. */
	workspaceHeadSha?: string;
}

/**
 * Resolve the right workspace for a given target. `cwd` is the user's cwd.
 * Pure function with side effects limited to fs + git/gh subprocesses.
 */
export async function prepareWorkspace(input: {
	cwd: string;
	target: {
		kind: "pr" | "local-git";
		prRef?: string;
		/** Diff-side head SHA to verify the checkout against. */
		expectedHeadSha?: string;
	};
}): Promise<WorkspaceResult> {
	const { cwd, target } = input;

	if (target.kind === "local-git") {
		// Reuse the user's cwd; reviewers will read source directly.
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

	// Clone (gh first so private repos ride the gh credential; plain https
	// fallback for anonymous/public setups). depth 50 keeps history-context
	// usable without a full clone.
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

	// Fetch the PR head into FETCH_HEAD and detach onto it (no named branch →
	// nothing stale can survive between runs).
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
		// One refetch — a force-push may have raced the clone. R2: a FAILED
		// retry is a hard error too — the old guard treated an empty
		// retryHead as "no mismatch" and silently reviewed an unverified
		// checkout, exactly the diff@new / files@old false-positive class.
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

