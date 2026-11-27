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

let configPath: string | undefined;

export function setCoreEconomyPath(path: string): void {
	configPath = path;
}

export function loadCoreEconomy(): CoreEconomyConfig {
	const path = (configPath ??= join(homedir(), ".pi", "agent", "core-economy.json"));
	const parsed = readJson<Partial<CoreEconomyConfig>>(path, {}, (reason) => {
		if (reason === "missing") return;
		console.warn(`[core-economy] ${reason} config ignored; defaults apply`);
	});
	return {
		actionFusion: typeof parsed.actionFusion === "boolean" ? parsed.actionFusion : true,
		observationPack: typeof parsed.observationPack === "boolean" ? parsed.observationPack : true,
	};
}
