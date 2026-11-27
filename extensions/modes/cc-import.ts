import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import * as path from "node:path"
import { readJson } from "../../lib/settings.ts"
import { permissionRuleValueFromString } from "./permission-rule-parser.ts"
import { addPermissionRule, getProjectPermissionsPath } from "./permissions-loader.ts"
import { getConfigPath } from "./config.ts"
import type { PermissionBehavior } from "./permissions.ts"

export type CcSourceScope = "user" | "project" | "local" | "history"

export interface CcRuleMapping {
	scope: CcSourceScope
	behavior: PermissionBehavior
	ccRule: string
	coreRule: string
	note?: string
}

export interface CcSkippedRule {
	scope: CcSourceScope
	behavior: PermissionBehavior
	ccRule: string
	reason: string
}

export interface CcSourceFile {
	scope: CcSourceScope
	filePath: string
	exists: boolean
	behaviors: PermissionBehavior[]
}

export interface CcImportPlan {
	sources: CcSourceFile[]
	rules: CcRuleMapping[]
	skipped: CcSkippedRule[]
}

const PI_ABSENT_CC_TOOLS = new Set(["websearch", "task", "taskoutput", "taskstop", "killshell", "killbash", "bashoutput", "notebookedit", "todowrite", "todoread"])

export function mapCcRule(ccRule: string): { coreRule: string; note?: string } | null {
	const trimmed = ccRule.trim()
	if (!trimmed) return null
	const parsed = permissionRuleValueFromString(trimmed)
	if (!parsed) return null
	const tool = parsed.toolName
	const content = parsed.ruleContent

	if (tool.startsWith("mcp__")) {
		const rest = tool.slice("mcp__".length)
		if (!rest) return null
		const single = rest.replace(/__/g, "_")
		if (single.endsWith("_*") || !single.includes("_")) {
			const server = single.replace(/\*$/, "").replace(/_$/, "")
			return { coreRule: `mcp(${server}_*)` }
		}
		return { coreRule: `mcp(${single})` }
	}

	const lower = tool.toLowerCase()
	if (lower === "webfetch" && content !== undefined) {
		return { coreRule: `webfetch(${content})` }
	}
	if (lower === "webfetch") return { coreRule: "webfetch" }

	if (content === undefined && !/^[A-Za-z][A-Za-z0-9_.-]*$/.test(tool)) {
		return null
	}

	const note = content === undefined && PI_ABSENT_CC_TOOLS.has(lower)
		? "no matching pi tool; rule stays inert"
		: undefined
	return { coreRule: trimmed, note }
}

function ccSettingsPaths(home: string, cwd: string): Array<{ scope: CcSourceScope; filePath: string }> {
	return [
		{ scope: "user", filePath: path.join(home, ".claude", "settings.json") },
		{ scope: "project", filePath: path.join(cwd, ".claude", "settings.json") },
		{ scope: "local", filePath: path.join(cwd, ".claude", "settings.local.json") },
	]
}

function behaviorsFromPermissions(perms: unknown): Partial<Record<PermissionBehavior, string[]>> {
	if (!perms || typeof perms !== "object" || Array.isArray(perms)) return {}
	const out: Partial<Record<PermissionBehavior, string[]>> = {}
	for (const behavior of ["allow", "deny", "ask"] as PermissionBehavior[]) {
		const list = (perms as Record<string, unknown>)[behavior]
		if (Array.isArray(list)) {
			out[behavior] = list.map((r) => String(r)).filter((r) => r.length > 0)
		}
	}
	return out
}

export function planCcImport(opts: { cwd: string; home?: string }): CcImportPlan {
	const home = opts.home ?? homedir()
	const plan: CcImportPlan = { sources: [], rules: [], skipped: [] }

	for (const { scope, filePath } of ccSettingsPaths(home, opts.cwd)) {
		if (!existsSync(filePath)) {
			plan.sources.push({ scope, filePath, exists: false, behaviors: [] })
			continue
		}
		const data = readJson<Record<string, unknown>>(filePath, {})
		const behaviors = behaviorsFromPermissions(data.permissions)
		plan.sources.push({
			scope,
			filePath,
			exists: true,
			behaviors: (Object.keys(behaviors) as PermissionBehavior[]).filter((b) => (behaviors[b] ?? []).length > 0),
		})
		for (const behavior of ["deny", "ask", "allow"] as PermissionBehavior[]) {
			for (const ccRule of behaviors[behavior] ?? []) {
				const mapped = mapCcRule(ccRule)
				if (mapped) {
					plan.rules.push({ scope, behavior, ccRule, coreRule: mapped.coreRule, note: mapped.note })
				} else {
					plan.skipped.push({ scope, behavior, ccRule, reason: "unrecognized rule syntax" })
				}
			}
		}
	}

	const claudeJsonPath = path.join(home, ".claude.json")
	if (existsSync(claudeJsonPath)) {
		const data = readJson<Record<string, unknown>>(claudeJsonPath, {})
		const projects = data.projects
		const allowed = projects && typeof projects === "object" && !Array.isArray(projects)
			? (projects as Record<string, { allowedTools?: unknown }>)[opts.cwd]?.allowedTools
			: undefined
		if (Array.isArray(allowed) && allowed.length > 0) {
			plan.sources.push({ scope: "history", filePath: claudeJsonPath, exists: true, behaviors: ["allow"] })
			for (const entry of allowed) {
				const ccRule = String(entry)
				const mapped = mapCcRule(ccRule)
				if (mapped) {
					plan.rules.push({ scope: "history", behavior: "allow", ccRule, coreRule: mapped.coreRule, note: mapped.note })
				} else {
					plan.skipped.push({ scope: "history", behavior: "allow", ccRule, reason: "unrecognized rule syntax" })
				}
			}
		} else {
			plan.sources.push({ scope: "history", filePath: claudeJsonPath, exists: true, behaviors: [] })
		}
	} else {
		plan.sources.push({ scope: "history", filePath: claudeJsonPath, exists: false, behaviors: [] })
	}

	return plan
}

const SCOPE_DESTINATION: Record<CcSourceScope, "global" | "project" | "local"> = {
	user: "global",
	project: "project",
	local: "local",
	history: "project",
}

function existingRulesAt(scope: CcSourceScope, cwd: string, home: string): Set<string> {
	if (scope === "user") {
		const p = getConfigPath()
		if (!existsSync(p)) return new Set()
		const data = readJson<Record<string, unknown>>(p, {})
		const perms = data.permissions as Record<string, unknown> | undefined
		const all: string[] = []
		for (const list of Object.values(perms ?? {})) {
			if (Array.isArray(list)) all.push(...list.map(String))
		}
		return new Set(all)
	}
	const p = getProjectPermissionsPath(cwd, scope === "local")
	if (!existsSync(p)) return new Set()
	const data = readJson<Record<string, unknown>>(p, {})
	const perms = data.permissions as Record<string, unknown> | undefined
	const all: string[] = []
	for (const list of Object.values(perms ?? {})) {
		if (Array.isArray(list)) all.push(...list.map(String))
	}
	return new Set(all)
}

export interface CcImportResult {
	imported: number
	skippedExisting: number
	failed: number
	perDestination: Record<string, number>
}

export function executeCcImport(plan: CcImportPlan, opts: { cwd: string; home?: string }): CcImportResult {
	const home = opts.home ?? homedir()
	const result: CcImportResult = { imported: 0, skippedExisting: 0, failed: 0, perDestination: {} }
	for (const rule of plan.rules) {
		const destination = SCOPE_DESTINATION[rule.scope]
		const existing = existingRulesAt(rule.scope, opts.cwd, home)
		if (existing.has(rule.coreRule)) {
			result.skippedExisting++
			continue
		}
		const ok = addPermissionRule({
			rule: rule.coreRule,
			behavior: rule.behavior,
			destination,
			cwd: opts.cwd,
		})
		if (ok) {
			result.imported++
			result.perDestination[destination] = (result.perDestination[destination] ?? 0) + 1
		} else {
			result.failed++
		}
	}
	return result
}

export function formatCcImportReport(plan: CcImportPlan, result?: CcImportResult): string {
	const lines: string[] = []
	lines.push("**Claude Code permission import**")
	lines.push("")
	lines.push("Sources:")
	for (const s of plan.sources) {
		lines.push(`- ${s.scope}: ${s.filePath}${s.exists ? "" : " (missing)"}${s.behaviors.length ? ` — ${s.behaviors.join("/")}` : ""}`)
	}
	lines.push("")
	lines.push("Rules to import:")
	if (plan.rules.length === 0) {
		lines.push("- (none)")
	}
	for (const r of plan.rules) {
		const note = r.note ? `  *(${r.note})*` : ""
		const arrow = r.ccRule === r.coreRule ? "" : ` → \`${r.coreRule}\``
		lines.push(`- [${r.scope}/${r.behavior}] \`${r.ccRule}\`${arrow}${note}`)
	}
	if (plan.skipped.length > 0) {
		lines.push("")
		lines.push("Skipped (cannot map):")
		for (const s of plan.skipped) {
			lines.push(`- [${s.scope}/${s.behavior}] \`${s.ccRule}\` — ${s.reason}`)
		}
	}
	if (result) {
		lines.push("")
		lines.push(
			`Imported ${result.imported} rule(s), skipped ${result.skippedExisting} already present, ${result.failed} failed.`,
		)
	}
	return lines.join("\n")
}
