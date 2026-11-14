/**
 * Load / persist permission rules from global + project scopes.
 *
 * E8a (spec 2026-11-15-cleanup-hardening): the no-op
 * ensureLocalPermissionsGitignored was deleted (it read .gitignore but
 * never wrote); the gitignored-tip detection now asks `git check-ignore`
 * (full pattern grammar) and falls back to the old exact-line comparison
 * when git is unavailable or errors.
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { readJson, readJsonCached, writeJsonAtomic } from "../../lib/settings.ts"
import path from "node:path"
import {
	getConfigPath,
	setConfigPath,
	loadPermissionModesConfig,
	type PermissionModesConfig,
} from "./config.ts"
import { getProjectId } from "./path-safety.ts"
import {
	type PermissionBehavior,
	type PermissionRule,
	type PermissionsConfig,
	mergePermissionRules,
	rulesFromPermissionsConfig,
} from "./permissions.ts"
import {
	permissionRuleValueFromString,
	permissionRuleValueToString,
} from "./permission-rule-parser.ts"

export type PermissionRuleDestination = "global" | "project" | "local"

export function setGlobalConfigPathForTests(p: string): void {
	setConfigPath(p)
}

export function getProjectPermissionsDir(cwd: string): string {
	const id = getProjectId(cwd)
	return path.join(cwd, ".pi", "projects", id)
}

export function getProjectPermissionsPath(
	cwd: string,
	local = false,
): string {
	const dir = getProjectPermissionsDir(cwd)
	return path.join(
		dir,
		local ? "permissions.local.json" : "permissions.json",
	)
}

function readJsonFile(filePath: string): PermissionsConfig | null {
	// shared settings-JSON primitive (P0-LB-01); shape extraction unchanged,
	// malformed files keep the historical console.warn diagnostic.
	// C1 (arch review 2026-10-18): cached read — this fires on every tool
	// call via loadMergedPermissionRules; both write paths go through
	// writeJsonAtomic, which drops the cache entry. (The global side has had
	// its own mtime cache in config.ts for years — this closes the gap.)
	const parsed = readJsonCached<{ permissions?: PermissionsConfig } & PermissionsConfig>(
		filePath,
		{} as { permissions?: PermissionsConfig } & PermissionsConfig,
		(reason) => {
			if (reason === "malformed" || reason === "non-object") {
				console.warn(`[permission-modes] Failed to read ${filePath}: invalid JSON`)
			}
		},
	)
	if (parsed.permissions) return parsed.permissions
	if (parsed.allow || parsed.deny || parsed.ask) return parsed
	return null
}

function loadGlobalPermissions(): PermissionRule[] {
	const config = loadPermissionModesConfig()
	const perms = config.permissions
	if (!perms) return []
	return rulesFromPermissionsConfig(perms, "global")
}

function loadProjectPermissions(
	cwd: string,
	local: boolean,
): PermissionRule[] {
	const filePath = getProjectPermissionsPath(cwd, local)
	const perms = readJsonFile(filePath)
	if (!perms) return []
	return rulesFromPermissionsConfig(
		perms,
		local ? "local" : "project",
	)
}

export function loadMergedPermissionRules(cwd: string): PermissionRule[] {
	return mergePermissionRules(
		loadGlobalPermissions(),
		loadProjectPermissions(cwd, false),
		loadProjectPermissions(cwd, true),
	)
}

function normalizeRuleString(rule: string): string {
	return permissionRuleValueToString(permissionRuleValueFromString(rule))
}

function writePermissionsToFile(
	filePath: string,
	behavior: PermissionBehavior,
	newRules: string[],
	isGlobalConfig: boolean,
): boolean {
	try {
		mkdirSync(path.dirname(filePath), { recursive: true })

		// original behavior: a malformed existing file aborts the write
		// (warn + false) instead of silently overwriting with {}
		let corrupted = false
		let data = readJson<Record<string, unknown>>(filePath, {}, (reason) => {
			if (reason === "malformed" || reason === "non-object") corrupted = true
		})
		if (corrupted) {
			console.warn(`[permission-modes] Failed to write ${filePath}: invalid JSON`)
			return false
		}

		const existing =
			(isGlobalConfig
				? ((data.permissions as PermissionsConfig | undefined) ??
					(data as PermissionsConfig))
				: ((data.permissions as PermissionsConfig | undefined) ??
					(data as PermissionsConfig))) ?? {}

		const behaviorList = [...(existing[behavior] ?? [])]
		const normalizedSet = new Set(
			behaviorList.map((r) => normalizeRuleString(String(r))),
		)

		for (const rule of newRules) {
			const norm = normalizeRuleString(rule)
			if (!normalizedSet.has(norm)) {
				behaviorList.push(norm)
				normalizedSet.add(norm)
			}
		}

		const updatedPerms: PermissionsConfig = {
			...existing,
			[behavior]: behaviorList,
		}

		if (isGlobalConfig) {
			data.permissions = updatedPerms
		} else {
			data = { permissions: updatedPerms }
		}

		writeJsonAtomic(filePath, data)
		return true
	} catch (err) {
		console.warn(`[permission-modes] Failed to write ${filePath}:`, err)
		return false
	}
}

export function addPermissionRule(opts: {
	rule: string
	behavior: PermissionBehavior
	destination: PermissionRuleDestination
	cwd: string
}): boolean {
	const norm = normalizeRuleString(opts.rule)

	if (opts.destination === "global") {
		return writePermissionsToFile(
			getConfigPath(),
			opts.behavior,
			[norm],
			true,
		)
	}

	const filePath = getProjectPermissionsPath(
		opts.cwd,
		opts.destination === "local",
	)

	// E8a: the former ensureLocalPermissionsGitignored(opts.cwd) call for
	// destination === "local" lived here — it read .gitignore and wrote
	// nothing (dead code, deleted).
	return writePermissionsToFile(filePath, opts.behavior, [norm], false)
}

/**
 * E8a (spec 2026-11-15-cleanup-hardening): is the local permissions file
 * covered by the repo's ignore rules? Primary detector is
 * `git check-ignore -q <entry>` run in cwd — it honors the full pattern
 * grammar, so a `.pi/` directory pattern covers the file (the old
 * exact-line comparison false-positived on it). git missing or erroring
 * (e.g. exit 128 outside a repo) falls back to the old exact-line
 * .gitignore comparison.
 */
function isLocalPermissionsGitignored(cwd: string, entry: string): boolean {
	const check = spawnSync("git", ["check-ignore", "-q", entry], {
		cwd,
		stdio: "ignore",
	})
	if (!check.error && (check.status === 0 || check.status === 1)) {
		return check.status === 0
	}
	const gitignorePath = path.join(cwd, ".gitignore")
	if (!existsSync(gitignorePath)) return false
	try {
		return readFileSync(gitignorePath, "utf-8")
			.split("\n")
			.some((line) => line.trim() === entry)
	} catch {
		return false
	}
}

export function warnIfLocalPermissionsNotGitignored(
	cwd: string,
	notify?: (msg: string) => void,
): void {
	const localPath = getProjectPermissionsPath(cwd, true)
	if (!existsSync(localPath)) return
	const entry = path.relative(cwd, localPath)
	if (!isLocalPermissionsGitignored(cwd, entry)) {
		notify?.(
			`Tip: add ${entry} to .gitignore to keep personal permission rules private`,
		)
	}
}

/** For tests: write raw project permissions file. */
export function writeProjectPermissionsFile(
	cwd: string,
	perms: PermissionsConfig,
	local = false,
): void {
	const filePath = getProjectPermissionsPath(cwd, local)
	writeJsonAtomic(filePath, { permissions: perms })
}

/** For tests: write global permission-modes.json permissions block. */
export function writeGlobalPermissionsConfig(
	perms: PermissionsConfig,
	configPath?: string,
): void {
	const filePath = configPath ?? getConfigPath()
	const data = readJson<PermissionModesConfig>(filePath, {})
	data.permissions = perms
	writeJsonAtomic(filePath, data)
}
