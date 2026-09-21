/**
 * Capability bus (P1-BUS-01..04, DESIGN-BUS "Design 1.5").
 *
 * `globalThis.__piClaudeCodeCore` = frozen pure-data snapshot (no functions).
 * Whole-snapshot replace + freeze + monotonic revision. The same synchronous
 * batch derives the legacy keys (`__piPermissionModes`, `__pmWorkingStats`)
 * from the new snapshot, so the two can never disagree (P1-BUS-03/05).
 *
 * Publishing happens only inside pi event handlers (no await gaps — single
 * threaded atomicity). No timers, no polling (P1-BUS-04). Presence gating
 * (whether expensive stats formatting happens at all) stays inside the modes
 * module as an implementation detail.
 *
 * v2 extension note (P1-BUS-10): if the future /core panel needs realtime
 * refresh, add an `onChange?: () => void` DATA field to a v2 snapshot (the
 * subscription point itself is data, version-gated) — do NOT bolt on an
 * event system.
 */
// Type-only import of the published declarations: erased at transform, so
// bundlers never resolve the .d.mts at runtime.
import type { CoreSnapshot, CoreStatus, CoreCommand, CoreCommandResult } from "../types/index.d.mts";

export type { CoreSnapshot, CoreStatus, CoreCommand, CoreCommandResult };

// ---- explicit per-channel patches (P0-SK-05 spike ② shape) -----------------

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
/** Optional channel: omitted keys keep the previous value. */
export interface DisplayPatch {
	display?: { footer?: readonly string[] };
}

export type CorePatch = ModesPatch | EffortPatch | GoalPatch | ReviewPatch | DisplayPatch;

type CommandHandler = (cmd: CoreCommand) => CoreCommandResult;

export interface CoreBus {
	publish(patch: CorePatch): CoreSnapshot;
	snapshot(): CoreSnapshot;
	/** Register the handler for a command kind (later registration wins). */
	registerCommand(kind: CoreCommand["kind"], handler: CommandHandler): void;
	handleCommand(cmd: CoreCommand): CoreCommandResult;
	/**
	 * Teardown for extension unload/tests: removes the core-owned global keys.
	 * Legacy `__piPermissionModes` intentionally SURVIVES shutdown (pinned by
	 * P0-CT-03) — this only clears the new-protocol keys.
	 */
	dispose(): void;
}

function initialSnapshot(): CoreSnapshot {
	return {
		version: 1,
		revision: 0,
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

export function createCoreBus(): CoreBus {
	let current: CoreSnapshot = deepFreeze(initialSnapshot());
	const commandHandlers = new Map<string, CommandHandler>();

	function deriveLegacy(snapshot: CoreSnapshot): void {
		// Legacy CCTUI key — a projection of the modes channel (PmCapability).
		g.__piPermissionModes = {
			version: 1,
			active: true,
			mode: snapshot.modes.mode,
			workingStats: snapshot.modes.workingStats,
		};
		// Written only once stats exist — mirrors pm 2.8.0 behavior pinned by
		// P0-CT-02 (without CCTUI presence the key must stay unset).
		if (snapshot.modes.workingStats !== null) {
			g.__pmWorkingStats = `(${snapshot.modes.workingStats})`;
		}
	}

	const bus: CoreBus = {
		publish(patch: CorePatch): CoreSnapshot {
			current = deepFreeze({ ...current, ...patch, revision: current.revision + 1 });
			g.__piClaudeCodeCore = current;
			g.__piClaudeCodeCoreCmd = (cmd: CoreCommand) => bus.handleCommand(cmd);
			deriveLegacy(current);
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
			current = deepFreeze(initialSnapshot());
			commandHandlers.clear();
		},
	};
	return bus;
}

// Shared bus for the running pi process (assembly installs it first; modules
// resolve the same instance, and standalone loads — contract tests — lazily
// create their own).
let sharedBus: CoreBus | undefined;

export function initCoreBus(): CoreBus {
	if (!sharedBus) sharedBus = createCoreBus();
	return sharedBus;
}

export function getCoreBus(): CoreBus | undefined {
	return sharedBus;
}

/** Module-facing accessor: lazily attaches a bus when loaded standalone. */
export function coreBus(): CoreBus {
	return initCoreBus();
}

/**
 * Test-only: drop the shared bus so a fresh factory call starts from an
 * empty snapshot (contract-suite isolation; production never resets).
 */
export function resetCoreBusForTests(): void {
	if (sharedBus) sharedBus.dispose();
	sharedBus = undefined;
}
