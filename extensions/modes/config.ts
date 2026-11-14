/**
 * Permission-modes extension config (`~/.pi/agent/permission-modes.json`).
 * Pure fs helpers — no pi dependency.
 *
 * BH-R7 (2026-11-14): hand-edited config must never crash the extension —
 * `sanitizePermissionModesConfig` normalizes every rule list (string-only
 * filters for autoMode.allow/soft_deny/environment and
 * permissions.allow/deny/ask; non-array entries dropped with a one-shot
 * warning) and deletes non-object `autoMode`/`permissions` blocks. The
 * sanitizer caches by object identity (WeakMap) so repeated reads of the
 * same parsed config are free.
 */

import { readJsonCached } from "../../lib/settings.ts"
import { homedir } from "node:os"
import { join } from "node:path"

import type { AutoModeRules } from "./classifier-prompt.ts"

export type ClassifierStage = "tool" | "single" | "fast" | "both" | "thinking"

export const CLASSIFIER_STAGE_SUFFIXES: readonly ClassifierStage[] = [
	"tool",
	"single",
	"fast",
	"both",
	"thinking",
] as const

export interface ClassifierConfig {
	enabled: boolean
	model: string
	timeoutMs: number
	/** CC-style JSONL transcript lines instead of "User:" / "bash cmd" format. */
	jsonlTranscript?: boolean
	/** When true (default), classifier errors deny the action instead of local fallback. */
	failClosed?: boolean
	/** Classifier pipeline — see docs/prompts/auto-mode-prompts.md. Default `tool`. */
	stage?: ClassifierStage
	/** Inject AGENTS.md / CLAUDE.md into classifier context. */
	includeAgentsMd?: boolean
}

export interface PermissionModesConfig {
	classifier?: Partial<ClassifierConfig>
	/** CC auto-mode classifier allow / soft_deny / environment bullets. */
	autoMode?: AutoModeRules
	/** W5 (2026-11-07): bash path-target checks — "all" (default) | "safety"
	 * (W3 only) | "deny" (W4 only) | "off". PI_CORE_BASH_PATH_CHECKS env
	 * overrides. Applies without /reload (read per adjudication). */
	bashPathChecks?: "all" | "safety" | "deny" | "off"
	permissions?: {
		allow?: string[]
		deny?: string[]
		ask?: string[]
	}
}

// C2 (arch review 2026-10-18), review R1 P1-1: this file is part of the
// FROZEN disk layout (~/.pi/agent/permission-modes.json, invariant 7 +
// P0-CT-09), so the root must stay homedir()-based — NOT the host
// getAgentDir(), which honors PI_CODING_AGENT_DIR and would silently
// relocate every existing user's permissions. Lazy init keeps imports
// side-effect free; the shape stays deliberately different from effort's
// host-following settings.json (two legal semantics, see DEVIATIONS).
let _configPath: string | undefined

export function getConfigPath(): string {
	return (_configPath ??= join(homedir(), ".pi", "agent", "permission-modes.json"))
}

export function setConfigPath(p: string): void {
	_configPath = p
}

const DEFAULT_CLASSIFIER: ClassifierConfig = {
	enabled: true,
	model: "anthropic/claude-haiku-4-5",
	timeoutMs: 15000,
	failClosed: true,
	stage: "tool",
	includeAgentsMd: true,
}

export function resolveClassifierConfig(
	config: PermissionModesConfig,
): ClassifierConfig {
	const c = config.classifier ?? {}
	return {
		enabled: c.enabled ?? DEFAULT_CLASSIFIER.enabled,
		model: c.model ?? DEFAULT_CLASSIFIER.model,
		timeoutMs: c.timeoutMs ?? DEFAULT_CLASSIFIER.timeoutMs,
		jsonlTranscript: c.jsonlTranscript ?? false,
		failClosed: c.failClosed ?? DEFAULT_CLASSIFIER.failClosed,
		stage: c.stage ?? DEFAULT_CLASSIFIER.stage,
		includeAgentsMd: c.includeAgentsMd ?? DEFAULT_CLASSIFIER.includeAgentsMd,
	}
}

export function resolveAutoModeConfig(
	config: PermissionModesConfig,
): AutoModeRules | undefined {
	const rules = config.autoMode
	if (!rules) return undefined
	if (
		!rules.allow?.length &&
		!rules.soft_deny?.length &&
		!rules.environment?.length
	) {
		return undefined
	}
	return rules
}

// (path, mtimeMs) cache (plan2 A1c): the config is read twice per turn
// (classifier + autoMode resolution) and again through the global-permissions
// loader; it changes rarely, so re-read only when the mtime moves. Since the
// C1 hot-path batch this rides the shared readJsonCached primitive
// (lib/settings.ts) — whose write side (writeJsonAtomic) also invalidates the
// entry, closing the same-mtime rewrite window. Callers treat the result as
// read-only — the cached object is shared.

export function loadPermissionModesConfig(): PermissionModesConfig {
	try {
		// shared settings-JSON primitive (P0-LB-01): {} fallback; malformed
		// files keep the historical console.warn diagnostic
		return sanitizePermissionModesConfig(
			readJsonCached<PermissionModesConfig>(getConfigPath(), {}, (reason) => {
				if (reason === "malformed" || reason === "non-object") {
					console.warn(`[permission-modes] Failed to load ${getConfigPath()}: invalid JSON`)
				}
			}),
		)
	} catch {
		return {}
	}
}

// BH-R7 (spec 2026-11-14-backtest-hardening): a non-string element inside
// any rule array used to throw TypeError downstream (pattern.trim /
// ruleString.trim on a number), failing CLOSED every bash call in every
// mode. Filter at load and warn once; the sanitized view is identity-stable
// per underlying cached object (WeakMap) so callers can keep comparing.
const sanitizedConfigCache = new WeakMap<object, PermissionModesConfig>()
let warnedNonStringRule = false

function warnNonStringRuleOnce(message: string): void {
	if (warnedNonStringRule) return
	warnedNonStringRule = true
	console.warn(message)
}

function stringList(value: unknown, field: string): string[] | undefined {
	if (value === undefined) return undefined
	if (!Array.isArray(value)) {
		warnNonStringRuleOnce(`[permission-modes] ${field} is not an array; ignored`)
		return undefined
	}
	const filtered = value.filter((v): v is string => typeof v === "string")
	if (filtered.length !== value.length) {
		warnNonStringRuleOnce(
			`[permission-modes] ${field} contains non-string entries; they were ignored`,
		)
	}
	return filtered
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v)
}

export function sanitizePermissionModesConfig(
	config: PermissionModesConfig,
): PermissionModesConfig {
	const cached = sanitizedConfigCache.get(config)
	if (cached) return cached
	const next: PermissionModesConfig = { ...config }
	if (config.autoMode !== undefined) {
		if (isPlainObject(config.autoMode)) {
			const raw = config.autoMode as Record<string, unknown>
			next.autoMode = {
				...raw,
				allow: stringList(raw.allow, "autoMode.allow"),
				soft_deny: stringList(raw.soft_deny, "autoMode.soft_deny"),
				environment: stringList(raw.environment, "autoMode.environment"),
			} as PermissionModesConfig["autoMode"]
		} else {
			warnNonStringRuleOnce("[permission-modes] autoMode is not an object; ignored")
			delete next.autoMode
		}
	}
	if (config.permissions !== undefined) {
		if (isPlainObject(config.permissions)) {
			const raw = config.permissions as Record<string, unknown>
			next.permissions = {
				allow: stringList(raw.allow, "permissions.allow"),
				deny: stringList(raw.deny, "permissions.deny"),
				ask: stringList(raw.ask, "permissions.ask"),
			}
		} else {
			warnNonStringRuleOnce("[permission-modes] permissions is not an object; ignored")
			delete next.permissions
		}
	}
	sanitizedConfigCache.set(config, next)
	return next
}
