import { homedir } from "node:os";
import { join } from "node:path";

import { readJson } from "./settings.ts";

export interface NotesIndexConfig {
	readonly enabled: boolean;
	// Absolute path of the notes directory; empty = the default project layer.
	readonly dir: string | undefined;
	// Directory whose pinned notes are injected in every project; empty = <agentDir>/memory.
	readonly pinnedDir: string | undefined;
}

export interface CoreEconomyConfig {
	readonly actionFusion: boolean;
	readonly observationPack: boolean;
	readonly notesIndex: NotesIndexConfig;
}

export const DEFAULT_CORE_ECONOMY: CoreEconomyConfig = Object.freeze({
	actionFusion: true,
	observationPack: true,
	notesIndex: Object.freeze({ enabled: true, dir: undefined, pinnedDir: undefined }),
});

function stringField(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

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
	const raw = parsed.notesIndex as Partial<NotesIndexConfig> | undefined;
	const notesIndex = raw && typeof raw === "object" ? raw : {};
	return {
		actionFusion: typeof parsed.actionFusion === "boolean" ? parsed.actionFusion : true,
		observationPack: typeof parsed.observationPack === "boolean" ? parsed.observationPack : true,
		notesIndex: {
			enabled: typeof notesIndex.enabled === "boolean" ? notesIndex.enabled : true,
			dir: stringField(notesIndex.dir),
			pinnedDir: stringField(notesIndex.pinnedDir),
		},
	};
}
