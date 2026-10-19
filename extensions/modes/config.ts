/**
 * Permission-modes extension config (`~/.pi/agent/permission-modes.json`).
 * Pure fs helpers — no pi dependency.
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
		return readJsonCached<PermissionModesConfig>(getConfigPath(), {}, (reason) => {
			if (reason === "malformed" || reason === "non-object") {
				console.warn(`[permission-modes] Failed to load ${getConfigPath()}: invalid JSON`)
			}
		})
	} catch {
		return {}
	}
}
