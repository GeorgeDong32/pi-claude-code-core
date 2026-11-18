
import { existsSync, mkdirSync } from "node:fs"
import { readJson, writeJsonAtomic } from "../../lib/settings.ts"
import { parseModelId as parseModelIdShared } from "../../lib/model-id.ts"
import { homedir } from "node:os"
import { join } from "node:path"

export interface ModeConfig {
	model?: string
	effort?: string
	skills?: string[]
	tools?: string[]
}

export interface ModelProfile {
	ask?: string | ModeConfig
	plan?: string | ModeConfig
	auto?: string | ModeConfig
	bypass?: string | ModeConfig
}

export interface ModelProfilesConfig {
	active?: string
	[key: string]: ModelProfile | string | undefined
}

let _modelsPath: string = join(
	homedir(),
	".pi",
	"agent",
	"model-profiles.json",
)

export function getModelsPath(): string {
	return _modelsPath
}

export function setModelsPath(p: string): void {
	_modelsPath = p
}

export const modelsPath: string = _modelsPath

export function parseModelId(
	raw: string,
): { provider: string; model: string; thinkingLevel?: string } | null {
	const parsed = parseModelIdShared(raw)
	if (!parsed) return null
	return parsed.effort === undefined
		? { provider: parsed.provider, model: parsed.modelId }
		: { provider: parsed.provider, model: parsed.modelId, thinkingLevel: parsed.effort }
}

function readConfigFromDisk(): ModelProfilesConfig {
	return readJson<ModelProfilesConfig>(_modelsPath, {}, (reason) => {
		if (reason === "malformed" || reason === "non-object") {
			console.warn(`[permission-modes] Failed to load ${_modelsPath}: invalid JSON`)
		}
	})
}

/**
 * Load and parse the model profiles config file. Returns an empty object if
 * the file doesn't exist or is malformed. Never throws.
 */
export function loadModelProfiles(): ModelProfilesConfig {
	return readConfigFromDisk()
}

/**
 * Ensure the model profiles config file exists. If missing, creates it with
 * defaults — pre-filled with the user's default model from
 * `~/.pi/agent/settings.json` (`defaultProvider` / `defaultModel`) if
 * available.
 *
 * Called once on session start and on `/reload`. Never throws — failures are
 * logged and the in-memory defaults are returned.
 */
export function ensureModelProfilesConfig(): ModelProfilesConfig {
	if (existsSync(_modelsPath)) return readConfigFromDisk()

	let defaultModelId = ""
	const settings = readJson<Record<string, unknown>>(
		join(homedir(), ".pi", "agent", "settings.json"),
		{},
	)
	const provider = settings.defaultProvider || ""
	const model = settings.defaultModel || ""
	if (provider && model) defaultModelId = `${provider}/${model}`

	const defaults: ModelProfilesConfig = {
		active: "default",
		default: {
			ask: defaultModelId,
			plan: defaultModelId,
			auto: defaultModelId,
		},
	}

	try {
		writeJsonAtomic(_modelsPath, defaults, { mode: 0o600 })
		console.log(`[permission-modes] Created ${_modelsPath} with defaults`)
	} catch (err) {
		console.warn(
			`[permission-modes] Failed to create ${_modelsPath}:`,
			err,
		)
	}

	return defaults
}

function modelFromProfileEntry(
	entry: string | ModeConfig | undefined,
): string | undefined {
	if (entry === undefined) return undefined
	if (typeof entry === "string") return entry
	return entry.model
}

export function resolveModelForMode(
	config: ModelProfilesConfig,
	mode: "ask" | "plan" | "auto" | "bypass",
): string | undefined {
	const profileName = config.active || "default"
	const profile = config[profileName] as ModelProfile | undefined
	const fromActive = modelFromProfileEntry(profile?.[mode])
	if (fromActive) return fromActive

	if (profileName !== "default") {
		const def = config["default"] as ModelProfile | undefined
		return modelFromProfileEntry(def?.[mode])
	}
	return undefined
}

export function resolveEffortForMode(
	config: ModelProfilesConfig,
	mode: "ask" | "plan" | "auto" | "bypass",
): string | undefined {
	const profileName = config.active || "default"
	const profile = config[profileName] as ModelProfile | undefined
	const fromActive = effortFromProfileEntry(profile?.[mode])
	if (fromActive) return fromActive

	if (profileName !== "default") {
		const def = config["default"] as ModelProfile | undefined
		const fromDefault = effortFromProfileEntry(def?.[mode])
		if (fromDefault) return fromDefault
	}
	return undefined
}

function effortFromProfileEntry(
	entry: string | ModeConfig | undefined,
): string | undefined {
	if (entry === undefined) return undefined
	if (typeof entry === "string") {
		return parseModelId(entry)?.thinkingLevel
	}
	const trimmed = entry.effort?.trim()
	if (trimmed) return trimmed
	if (entry.model) return parseModelId(entry.model)?.thinkingLevel
	return undefined
}

export function getActiveProfileName(config: ModelProfilesConfig): string {
	return config.active || "default"
}

export function listProfiles(config: ModelProfilesConfig): string[] {
	return Object.keys(config).filter(
		(k) => k !== "active" && typeof config[k] === "object",
	)
}

function normalizeModeEntry(
	entry: string | ModeConfig | undefined,
): ModeConfig {
	if (entry === undefined) return { skills: ["*"], tools: ["*"] }
	if (typeof entry === "string") return { model: entry, skills: ["*"], tools: ["*"] }
	return {
		model: entry.model,
		effort: entry.effort,
		skills: entry.skills ?? ["*"],
		tools: entry.tools ?? ["*"],
	}
}

export function resolveModeConfig(
	config: ModelProfilesConfig,
	mode: "ask" | "plan" | "auto" | "bypass",
): ModeConfig {
	const profileName = config.active || "default"

	const profile = config[profileName] as ModelProfile | undefined
	if (profile) {
		const entry = profile[mode]
		if (entry !== undefined) return normalizeModeEntry(entry)
	}

	if (profileName !== "default") {
		const def = config["default"] as ModelProfile | undefined
		if (def) {
			const entry = def[mode]
			if (entry !== undefined) return normalizeModeEntry(entry)
		}
	}

	return { skills: ["*"], tools: ["*"] }
}

export function resolveSkillFilter(
	config: ModelProfilesConfig,
	mode: "ask" | "plan" | "auto" | "bypass",
): string[] {
	return resolveModeConfig(config, mode).skills ?? ["*"]
}

export function resolveToolFilter(
	config: ModelProfilesConfig,
	mode: "ask" | "plan" | "auto",
): string[] | "*" {
	const mc = resolveModeConfig(config, mode)
	const raw = mc.tools ?? ["*"]
	if (raw.length === 1 && raw[0] === "*") return "*"
	return [...new Set([...raw, "read"])]
}

export function profileExists(
	config: ModelProfilesConfig,
	name: string,
): boolean {
	return typeof config[name] === "object" && config[name] !== null
}
