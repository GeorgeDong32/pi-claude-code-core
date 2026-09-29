/*
 * Shared feature switches for the economy modules (SPEC DEC-02 / ASM-03).
 * File: ~/.pi/agent/core-economy.json — { version: 1, actionFusion: bool,
 * observationPack: bool }; both default to true when absent. A malformed file
 * degrades to defaults with one warning instead of blocking the load
 * (deliberately unlike upstream SoL-Pi's fail-fast).
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

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
	let raw: string;
	try {
		raw = readFileSync(configPath, "utf-8");
	} catch {
		return DEFAULT_CORE_ECONOMY;
	}
	try {
		const parsed = JSON.parse(raw) as Partial<CoreEconomyConfig>;
		return {
			actionFusion: typeof parsed.actionFusion === "boolean" ? parsed.actionFusion : true,
			observationPack: typeof parsed.observationPack === "boolean" ? parsed.observationPack : true,
		};
	} catch (error) {
		console.warn(`[core-economy] malformed config ignored (${(error as Error).message}); defaults apply`);
		return DEFAULT_CORE_ECONOMY;
	}
}
