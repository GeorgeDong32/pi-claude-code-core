import { randomUUID } from "node:crypto";
import type { CoreSnapshot, CoreCommand, CoreCommandResult } from "../types/index.d.mts";

export type { CoreSnapshot, CoreCommand, CoreCommandResult };


export interface ModesPatch {
	modes: CoreSnapshot["modes"];
}
export interface EffortPatch {
	effort: CoreSnapshot["effort"];
}
export interface GoalPatch {
	goal: CoreSnapshot["goal"];
}
export interface ReviewPatch {
	review: CoreSnapshot["review"];
}
export interface DisplayPatch {
	display?: { footer?: readonly string[] };
}
export interface ContextBudgetPatch {
	contextBudget?: { rulesMax: number; memoryIndexMax: number; dynamicSteerMax: number };
}
export interface NotificationsPatch {
	notifications: CoreSnapshot["notifications"];
}
export interface MemoryPatch {
	memory?: { yielded: boolean; dir?: string };
}
export interface ObservationPatch {
	observation?: CoreSnapshot["observation"];
}
export interface FusionPatch {
	fusion?: { fusedCount: number };
}

export type CorePatch = ModesPatch | EffortPatch | GoalPatch | ReviewPatch | DisplayPatch | ContextBudgetPatch | MemoryPatch | NotificationsPatch | ObservationPatch | FusionPatch;

type CommandHandler = (cmd: CoreCommand) => CoreCommandResult;

export interface CoreBus {
	publish(patch: CorePatch): CoreSnapshot;
	snapshot(): CoreSnapshot;
	registerCommand(kind: CoreCommand["kind"], handler: CommandHandler): void;
	handleCommand(cmd: CoreCommand): CoreCommandResult;
	dispose(): void;
}

function initialSnapshot(instance: string): CoreSnapshot {
	return {
		version: 1,
		revision: 0,
		instance,
		modes: { mode: "", workingStats: null },
		effort: { level: null, source: "model-default" },
		goal: { active: false, summary: null },
		review: { status: "idle", lastRunAt: null },
	};
}

function deepFreeze<T>(value: T): T {
	if (value && typeof value === "object") {
		for (const k of Object.keys(value as object)) {
			deepFreeze((value as Record<string, unknown>)[k]);
		}
		Object.freeze(value);
	}
	return value;
}

const g = globalThis as Record<string, unknown>;

// pi loads extensions with jiti `moduleCache:false`, so /reload builds a NEW bus — consumers detect the swap by comparing the snapshot's `instance` and re-subscribe via its onChange.
export function createCoreBus(): CoreBus {
	const instance = randomUUID();
	let current: CoreSnapshot = deepFreeze(initialSnapshot(instance));
	const commandHandlers = new Map<string, CommandHandler>();
	const listeners = new Set<() => void>();
	const onChangeRegister = (fn: () => void): (() => void) => {
		listeners.add(fn);
		return () => {
			listeners.delete(fn);
		};
	};

	function deriveLegacy(snapshot: CoreSnapshot): void {
		g.__piPermissionModes = {
			version: 1,
			active: true,
			mode: snapshot.modes.mode,
			workingStats: snapshot.modes.workingStats,
			meta: snapshot.modes.meta,
		};
		const ccTuiLive = (g.__piCcTui as { active?: boolean } | undefined)?.active === true || g.__ccTuiActive === true;
		if (ccTuiLive && snapshot.modes.workingStats !== null) {
			g.__pmWorkingStats = `(${snapshot.modes.workingStats})`;
		}
	}

	const bus: CoreBus = {
		publish(patch: CorePatch): CoreSnapshot {
			current = deepFreeze({
				...current,
				...patch,
				instance,
				version: 2,
				onChange: onChangeRegister,
				revision: current.revision + 1,
			});
			g.__piClaudeCodeCore = current;
			g.__piClaudeCodeCoreCmd = (cmd: CoreCommand) => bus.handleCommand(cmd);
			deriveLegacy(current);
			for (const listener of listeners) {
				try {
					listener();
				} catch (error) {
					console.warn("[core-bus] listener failed:", error);
				}
			}
			return current;
		},
		snapshot: () => current,
		registerCommand(kind, handler) {
			commandHandlers.set(kind, handler);
		},
		handleCommand(cmd: CoreCommand): CoreCommandResult {
			try {
				const handler = commandHandlers.get(cmd.kind);
				if (!handler) return { ok: false, reason: "unknown-command" };
				return handler(cmd);
			} catch (error) {
				return { ok: false, reason: error instanceof Error ? error.message : String(error) };
			}
		},
		dispose() {
			delete g.__piClaudeCodeCore;
			delete g.__piClaudeCodeCoreCmd;
			listeners.clear();
			current = deepFreeze(initialSnapshot(instance));
			commandHandlers.clear();
		},
	};
	return bus;
}

let sharedBus: CoreBus | undefined;

export function initCoreBus(): CoreBus {
	if (!sharedBus) sharedBus = createCoreBus();
	return sharedBus;
}

export function getCoreBus(): CoreBus | undefined {
	return sharedBus;
}

export function coreBus(): CoreBus {
	return initCoreBus();
}

export function resetCoreBusForTests(): void {
	if (sharedBus) sharedBus.dispose();
	sharedBus = undefined;
}
