/*
 * Shared feature switches for the economy modules (SPEC DEC-02 / ASM-03).
 * File: ~/.pi/agent/core-economy.json — { version: 1, actionFusion: bool,
 * observationPack: bool }; both default to true when absent. A malformed file
 * degrades to defaults with one warning instead of blocking the load
 * (deliberately unlike upstream SoL-Pi's fail-fast).
 *
 * B2: reading goes through lib/settings.ts readJson (invariant 10 — one
 * JSON reader). Semantics preserved: missing stays silent; malformed /
 * empty / non-object warn once and degrade; per-field boolean normalization
 * stays here (the reader is generic, the schema is ours).
 */
import { homedir } from "node:os";
import { join } from "node:path";

import { readJson } from "./settings.ts";

export interface CoreEconomyConfig {
	readonly actionFusion: boolean;
	readonly observationPack: boolean;
}

export const DEFAULT_CORE_ECONOMY: CoreEconomyConfig = Object.freeze({
	actionFusion: true,
	observationPack: true,
});

let configPath = join(homedir(), ".pi", "agent", "core-economy.json");

/** Test seam: redirect the config file. */
export function setCoreEconomyPath(path: string): void {
	configPath = path;
}

export function loadCoreEconomy(): CoreEconomyConfig {
	const parsed = readJson<Partial<CoreEconomyConfig>>(configPath, {}, (reason) => {
		if (reason === "missing") return; // absent file = defaults, silently (as before)
		console.warn(`[core-economy] ${reason} config ignored; defaults apply`);
	});
	return {
		actionFusion: typeof parsed.actionFusion === "boolean" ? parsed.actionFusion : true,
		observationPack: typeof parsed.observationPack === "boolean" ? parsed.observationPack : true,
	};
}
