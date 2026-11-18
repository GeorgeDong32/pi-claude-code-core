import { existsSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { DEFAULT_CONFIG, loadConfig, resolveModel } from "./config.js";
import { runCmd } from "./run-cmd.js";
import { buildReviewDirective } from "./directive.js";
import { resolveLeanBudgets } from "./lean-agents.js";
import { extractPrRef } from "./pr-ref.js";
import {
	RunManifest,
	WORKSPACE_TTL_MS,
	discoverRulePathsLocal,
	ensureRunDir,
	generateRunId,
	parseChangedFilesFromDiff,
	pruneStaleRuns,
	readManifest,
	sha256Hex,
	writeDiff,
	writeManifest,
} from "./review-report.js";
import {
	prepareWorkspace,
	removeWorkspaceRoot,
	type WorkspaceResult,
} from "./target-workspace.js";
import type { ReviewTarget } from "./types.js";

export interface PrepareRunInput {
	cwd: string;
	input?: string;
	lite?: boolean;
	gateModel?: string;
	/** Set false for dry-runs — pruning is a side effect a dry run must not have. */
	cleanup?: boolean;
	dryRun?: boolean;
}

export interface PreparedRun {
	runId: string;
	manifest: RunManifest;
	directive: string;
	directiveText: string;
	dryRun?: boolean;
}

export async function prepareRun(input: PrepareRunInput): Promise<PreparedRun | null> {
	const cwd = input.cwd;
	const { config } = loadConfig();
	const target = await resolveReviewTarget(input.cwd, { input: input.input });
	if (!target) return null;

	if (input.cleanup !== false) {
		pruneStaleRuns(cwd);
		pruneLegacyFlatArtifacts(cwd);
		pruneStaleWorkspaces();
	}

	const runId = generateRunId();
	const runDir = ensureRunDir(cwd, runId);

	const diffResult = await acquireDiff(cwd, target, runDir);
	if (target.kind === "local-git") {
		target.label = diffResult.mode === "local-uncommitted"
			? "uncommitted changes"
			: `vs ${target.probeNote ?? "main"}`;
	}
	const changedFiles = parseChangedFilesFromDiff(diffResult.diff);
	if (changedFiles.additions + changedFiles.deletions === 0) {
		try {
			rmSync(runDir, { recursive: true, force: true });
		} catch {
		}
		return null;
	}
	let workspaceResult: WorkspaceResult;
	if (input.dryRun && target.kind === "pr") {
		workspaceResult = {
			workspacePath: cwd,
			historyAvailable: false,
			cloned: false,
			warning: "not cloned (dry run)",
		};
	} else {
		workspaceResult = await prepareWorkspace({
			cwd,
			target: { kind: target.kind, prRef: target.prRef, expectedHeadSha: diffResult.headSha },
		});
		if (workspaceResult.cloned && diffResult.headSha && workspaceResult.workspaceHeadSha &&
			workspaceResult.workspaceHeadSha !== diffResult.headSha) {
			removeWorkspaceRoot(dirname(workspaceResult.workspacePath));
			workspaceResult = await prepareWorkspace({
				cwd,
				target: { kind: target.kind, prRef: target.prRef, expectedHeadSha: diffResult.headSha },
			});
			if (workspaceResult.workspaceHeadSha && workspaceResult.workspaceHeadSha !== diffResult.headSha) {
				throw new Error(
					`pi-review: workspace HEAD ${workspaceResult.workspaceHeadSha.slice(0, 12)} does not match diff head ${diffResult.headSha.slice(0, 12)} — the PR moved during preparation; re-run /review.`,
				);
			}
		}
	}

	const rulePaths = input.dryRun && target.kind === "pr"
		? []
		: discoverRulePathsLocal(workspaceResult.workspacePath);

	const manifest: RunManifest = {
		runId,
		targetLabel: target.label,
		targetKind: target.kind,
		prRef: target.prRef,
		diffPath: diffResult.path,
		diffSha256: sha256Hex(diffResult.diff),
		changedFiles: changedFiles.files,
		docsOnly: changedFiles.docsOnly,
		rulePaths,
		historyAvailable: workspaceResult.historyAvailable,
		mode: diffResult.mode,
		baseSha: diffResult.baseSha,
		headSha: diffResult.headSha,
		mergeBase: diffResult.mergeBase,
		workspacePath: workspaceResult.workspacePath,
		workspaceHeadSha: workspaceResult.workspaceHeadSha,
		workspaceWarning: workspaceResult.warning,
		workspaceCloned: workspaceResult.cloned,
		diffWarning: diffResult.warning,
		runDir,
		createdAt: Date.now(),
	};

	const gateModel = resolveModel(input.gateModel ?? config.gate.model, undefined);
	const profile: ChangeProfile = {
		docsOnly: changedFiles.docsOnly,
		rulePaths,
		historyAvailable: workspaceResult.historyAvailable,
	};
	const reviewers = input.lite
		? [{ id: "lite-review", label: "Lite Review", enabled: true, model: "inherit" }]
		: reviewersForRouting(target, config, profile);
	const skippedReasons = adaptiveSkips(profile);
	manifest.reviewerIds = reviewers.map((r) => r.id);
	const workspacePath = manifest.workspacePath;
	const manifestPath = join(runDir, "manifest.json");
	const diffPath = manifest.diffPath;
	const workflowPath = join(runDir, "workflow.js");
	const directive = buildReviewDirective({
		target,
		reviewers,
		gateModel,
		gateThinking: input.lite ? undefined : config.gate.thinking,
		gateEnabled: config.gate.enabled,
		threshold: config.gate.threshold,
		verdictPolicy: config.gate.verdictPolicy,
		lite: Boolean(input.lite),
		cwd,
		workspacePath,
		manifestPath,
		diffPath,
		workflowPath,
		budgets: resolveLeanBudgets(config.budgets),
	});
	if (!input.lite && config.routing.mode === "adaptive" && skippedReasons.length > 0) {
		const skippedByRouting: Array<{ id: string; reason: string }> = [];
		for (const [id, reason] of skippedReasons) {
			if (!reviewers.some((r) => r.id === id)) skippedByRouting.push({ id, reason });
		}
		manifest.skippedReviewers = skippedByRouting;
	}
	writeManifest(runDir, manifest);

	const directiveText = directive;

	return { runId, manifest, directive, directiveText, dryRun: input.dryRun === true || undefined };
}

export function loadManifestFor(cwd: string, runId: string): RunManifest {
	const runDir = join(cwd, ".pi", "pi-review", "runs", runId);
	return readManifest(runDir);
}


interface DiffAcquisitionResult {
	path: string;
	diff: string;
	mode: RunManifest["mode"];
	baseSha?: string;
	headSha?: string;
	mergeBase?: string;
	warning?: string;
}

async function acquireDiff(
	cwd: string,
	target: ReviewTarget,
	runDir: string,
): Promise<DiffAcquisitionResult> {
	if (target.kind === "pr" && target.prRef) {
		return acquirePrDiff(cwd, target.prRef, runDir);
	}
	return acquireLocalDiff(cwd, runDir);
}

async function acquirePrDiff(
	cwd: string,
	prRef: string,
	runDir: string,
): Promise<DiffAcquisitionResult> {
	const gh = await runCmd(
		"gh",
		["pr", "view", prRef, "--json", "number,baseRefName,baseRefOid,headRefOid,headRepository,headRepositoryOwner"],
		{ cwd, timeoutMs: PR_GH_TIMEOUT_MS, env: { GIT_TERMINAL_PROMPT: "0" } },
	);
	let prMeta: {
		number?: string;
		baseRefName?: string;
		baseRefOid?: string;
		headRefOid?: string;
		headRepository?: { name?: string };
		headRepositoryOwner?: { login?: string };
	} | null = null;
	if (gh.exitCode === 0 && gh.stdout.trim()) {
		try {
			prMeta = JSON.parse(gh.stdout);
		} catch {
			prMeta = null;
		}
	}

	// `gh pr diff` is the SINGLE diff authority: it is byte-for-byte what the
	// GitHub web UI renders for the PR (same base/merge-base semantics). A
	// locally computed `git diff origin/main...FETCH_HEAD` can diverge from
	// that (different merge-base, ref timing), which is exactly the
	// "diff does not match GitHub" failure class — so we never substitute our
	// own computation. On failure we stop and tell the user to fix gh.
	const ghDiff = await runCmd("gh", ["pr", "diff", prRef], {
		cwd,
		timeoutMs: PR_GH_TIMEOUT_MS,
		env: { GIT_TERMINAL_PROMPT: "0" },
	});
	if (ghDiff.exitCode !== 0) {
		throw new Error(
			`pi-review: gh pr diff failed for ${prRef} (${ghDiff.stderr.trim().slice(0, 200)}). gh pr diff is the single diff authority (it matches the GitHub web UI exactly), so there is no local fallback — check gh auth/install and re-run. Details: ${ghDiff.stdout.trim().slice(0, 200)}`,
		);
	}
	const path = writeDiff(runDir, ghDiff.stdout);
	return {
		path,
		diff: ghDiff.stdout,
		mode: "gh-pr-diff",
		baseSha: prMeta?.baseRefOid,
		headSha: prMeta?.headRefOid,
	};
}

const LOCAL_BASE_FETCH_TIMEOUT_MS = 15_000;

const PR_GH_TIMEOUT_MS = 60_000;

const UNTRACKED_FILE_MAX_BYTES = 1_000_000;

async function acquireLocalDiff(cwd: string, runDir: string): Promise<DiffAcquisitionResult> {
	const status = await runCmd("git", ["status", "--porcelain"], { cwd });
	if (status.stdout.trim().length > 0) {
		const tracked = (await runCmd("git", ["diff", "HEAD"], { cwd })).stdout;
		const untracked = (await runCmd("git", ["ls-files", "--others", "--exclude-standard"], { cwd })).stdout;
		const untrackedParts: string[] = [];
		let skippedOversize = 0;
		for (const f of untracked.trim() ? untracked.trim().split("\n") : []) {
			try {
				const size = statSync(join(cwd, f)).size;
				if (size > UNTRACKED_FILE_MAX_BYTES) {
					skippedOversize++;
					untrackedParts.push(
						`diff --git a/${f} b/${f}\nnew file mode 100644\n--- /dev/null\n+++ b/${f}\n@@ -0,0 +1 @@\n+Untracked file omitted from review: ${size} bytes exceeds the ${UNTRACKED_FILE_MAX_BYTES}-byte cap (content not read)\n`,
					);
					continue;
				}
				const buf = readFileSync(join(cwd, f));
				if (buf.subarray(0, 8000).includes(0)) {
					untrackedParts.push(`diff --git a/${f} b/${f}\nnew file mode 100644\nBinary file ${f} added (contents not shown)\n`);
					continue;
				}
				const lines = buf.toString("utf-8").split("\n");
				untrackedParts.push(
					`diff --git a/${f} b/${f}\nnew file mode 100644\n--- /dev/null\n+++ b/${f}\n@@ -0,0 +1,${lines.length} @@\n${lines.map((l) => `+${l}`).join("\n")}\n`,
				);
			} catch {
			}
		}
		const text = [tracked.trim(), ...untrackedParts].filter(Boolean).join("\n");
		if (text) {
			const path = writeDiff(runDir, text);
			return {
				path,
				diff: text,
				mode: "local-uncommitted",
				headSha: await safeRev(cwd, "HEAD"),
				warning: skippedOversize > 0
					? `${skippedOversize} untracked file${skippedOversize === 1 ? "" : "s"} over ${UNTRACKED_FILE_MAX_BYTES} bytes omitted from the diff (size noted, content not read)`
					: undefined,
			};
		}
	}

	const base = await detectDefaultBranch(cwd);
	if (!base) {
		const placeholder = `(no diff captured: clean tree, no default branch detected)\n`;
		const path = writeDiff(runDir, placeholder);
		return { path, diff: placeholder, mode: "local-vs-default" };
	}
	const baseFetch = await runCmd("git", ["fetch", "origin", base, "--quiet"], {
		cwd,
		timeoutMs: LOCAL_BASE_FETCH_TIMEOUT_MS,
		env: { GIT_TERMINAL_PROMPT: "0" },
	});
	let diffWarning: string | undefined;
	if (baseFetch.exitCode !== 0) {
		const timedOut = baseFetch.timedOut === true;
		const hasRemoteRef = (await runCmd("git", ["rev-parse", "--verify", `refs/remotes/origin/${base}`], { cwd })).exitCode === 0;
		if (hasRemoteRef) {
			diffWarning = timedOut
				? `git fetch origin ${base} timed out after ${LOCAL_BASE_FETCH_TIMEOUT_MS}ms — diffing against possibly-stale origin/${base}`
				: `git fetch origin ${base} failed — diffing against possibly-stale origin/${base}`;
		}
	}
	const compare = (await runCmd("git", ["rev-parse", "--verify", `origin/${base}`], { cwd })).exitCode === 0
		? `origin/${base}`
		: base;
	const diff = await runCmd("git", ["diff", `${compare}...HEAD`], { cwd });
	const text = diff.stdout.length > 0 ? diff.stdout : `(no diff vs ${compare})\n`;
	const path = writeDiff(runDir, text);
	return {
		path,
		diff: text,
		mode: "local-vs-default",
		baseSha: await safeRev(cwd, compare),
		headSha: await safeRev(cwd, "HEAD"),
		mergeBase: (await runCmd("git", ["merge-base", compare, "HEAD"], { cwd })).stdout.trim() || undefined,
		warning: diffWarning,
	};
}

async function safeRev(cwd: string, ref: string): Promise<string | undefined> {
	const r = await runCmd("git", ["rev-parse", ref], { cwd });
	if (r.exitCode !== 0) return undefined;
	return r.stdout.trim() || undefined;
}

async function detectDefaultBranch(cwd: string): Promise<string | null> {
	const sym = await runCmd("git", ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], { cwd });
	if (sym.exitCode === 0) {
		const v = sym.stdout.trim();
		return v.startsWith("origin/") ? v.slice("origin/".length) : v;
	}
	for (const candidate of ["main", "master"]) {
		const probe = await runCmd("git", ["rev-parse", "--verify", `refs/heads/${candidate}`], { cwd });
		if (probe.exitCode === 0) return candidate;
	}
	const head = await runCmd("git", ["symbolic-ref", "--short", "HEAD"], { cwd });
	if (head.exitCode === 0) return head.stdout.trim();
	return null;
}



import type { PiReviewConfig, ReviewerSpec } from "./types.js";

export interface ChangeProfile {
	docsOnly: boolean;
	rulePaths: string[];
	historyAvailable: boolean;
}

export function reviewersForRouting(
	target: ReviewTarget,
	config: PiReviewConfig,
	profile?: ChangeProfile,
): ReviewerSpec[] {
	const all = Object.values(config.reviewers).filter((r) => r.enabled);
	if (config.routing.mode !== "adaptive" || !profile) return all;

	const skippedReasons = adaptiveSkips(profile);
	if (skippedReasons.length === 0) return all;

	const reasons = new Map(skippedReasons);
	return all.filter((r) => !reasons.has(r.id));
}

export function adaptiveSkips(profile: ChangeProfile): Array<[string, string]> {
	const out: Array<[string, string]> = [];
	if (profile.rulePaths.length === 0) {
		out.push(["rulesheriff", "no rule files (AGENTS.md / CLAUDE.md / .pi rules)"]);
	}
	if (profile.docsOnly) {
		out.push(["bugbot", "docs-only change (no code to scan)"]);
		out.push(["security-review", "docs-only change (no code to scan)"]);
		out.push(["code-comments", "docs-only change (no inline comments to violate)"]);
	}
	if (!profile.historyAvailable) {
		out.push(["history-context", "no git history available in the target workspace"]);
	}
	return out;
}

function safeRead(path: string): string {
	return existsSync(path) ? readFileSync(path, "utf-8") : "";
}

export function pruneLegacyFlatArtifacts(cwd: string): string[] {
	const root = join(cwd, ".pi", "pi-review");
	const legacyNames = ["change.diff", "changed-files.txt", "change-kind.txt", "diff-meta.txt"];
	const removed: string[] = [];
	for (const name of legacyNames) {
		const p = join(root, name);
		try {
			if (existsSync(p)) {
				rmSync(p, { force: true });
				removed.push(p);
			}
		} catch {
		}
	}
	return removed;
}

export function pruneStaleWorkspaces(now = Date.now()): string[] {
	const removed: string[] = [];
	let entries: string[];
	try {
		entries = readdirSync(tmpdir());
	} catch {
		return removed;
	}
	for (const entry of entries) {
		if (!entry.startsWith("pi-review-ws-")) continue;
		const path = join(tmpdir(), entry);
		try {
			const stat = statSync(path);
			if (now - stat.mtimeMs > WORKSPACE_TTL_MS) {
				rmSync(path, { recursive: true, force: true });
				removed.push(path);
			}
		} catch {
		}
	}
	return removed;
}

async function resolveReviewTarget(
	cwd: string,
	opts: { input?: string },
): Promise<ReviewTarget | null> {
	const userContext = opts.input?.trim() || undefined;
	const prRef = userContext ? extractPrRef(userContext) : null;
	if (prRef) {
		return {
			kind: "pr",
			label: prLabel(prRef),
			userContext,
			prRef,
			hint: `Obtain PR ${prRef} yourself via gh and/or git. The plugin already prepared the target repo + diff.`,
		};
	}
	const git = await runCmd("git", ["rev-parse", "--git-dir"], { cwd }).then((r) => r.exitCode === 0);
	if (!git) return null;
	const base = await detectDefaultBranch(cwd);
	return {
		kind: "local-git",
		label: "",
		userContext,
		probeNote: base ?? "main",
	};
}

function prLabel(prRef: string): string {
	const n = prRef.match(/pull\/(\d+)/i)?.[1] ?? prRef.replace(/^#/, "");
	return `PR ${n}`;
}

