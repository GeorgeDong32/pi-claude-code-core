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
/** P3-RU-10: read-only budget split, published once by the rules module. */
export interface ContextBudgetPatch {
	contextBudget?: { rulesMax: number; memoryIndexMax: number; dynamicSteerMax: number };
}
/** DC3: notification tail queue (bounded, monotonic ids) — append via ui/notify. */
export interface NotificationsPatch {
	notifications: CoreSnapshot["notifications"];
}
/** P3-ME-06: yield state of the injection lane (optional channel). */
export interface MemoryPatch {
	memory?: { yielded: boolean; dir?: string };
}
/**
 * SPEC OBS-09: cumulative observation-pack savings (optional channel).
 * OBS-09-SITES: the optional `sites` field carries per-site display-only
 * savings for the requests where an observation was FIRST replaced
 * (previousSends === FULL_SENDS) — the single-shot semantics upstream
 * SoL-Pi flashes in showSolPiSavings. Each entry's optional toolCallId
 * correlates it with the visible tool row: the projection rewrites only
 * the provider request, so toolCallId is the only reliable row key.
 * Display layer only: never part of a provider request or the projected
 * messages (module invariant 9). Single-sourced from the published
 * snapshot type (twin-shape guard).
 */
export interface ObservationPatch {
	observation?: CoreSnapshot["observation"];
}
/** SPEC FUS-09: cumulative action-fusion savings (optional channel). */
export interface FusionPatch {
	fusion?: { fusedCount: number };
}

export type CorePatch = ModesPatch | EffortPatch | GoalPatch | ReviewPatch | DisplayPatch | ContextBudgetPatch | MemoryPatch | NotificationsPatch | ObservationPatch | FusionPatch;

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
	// P1-BUS-10 / DC5: the subscription point is DATA on the v2 snapshot —
	// snapshot.onChange(listener) registers, returns an unsubscribe. The
	// listener set lives here; each publish re-serves an equivalent register
	// function. deepFreeze skips functions, so the frozen invariant holds.
	const listeners = new Set<() => void>();
	const onChangeRegister = (fn: () => void): (() => void) => {
		listeners.add(fn);
		return () => {
			listeners.delete(fn);
		};
	};

	function deriveLegacy(snapshot: CoreSnapshot): void {
		// Legacy CCTUI key — a projection of the modes channel (PmCapability).
		g.__piPermissionModes = {
			version: 1,
			active: true,
			mode: snapshot.modes.mode,
			workingStats: snapshot.modes.workingStats,
			// DC1: presentation material (icon/label/role) rides the projection
			// so consumers stay single-sourced until they read the snapshot itself.
			meta: snapshot.modes.meta,
		};
		// DC5 gating flip: publishes are always-full now, so the legacy key
		// write is what stays presence-gated — written only for a live CCTUI
		// (its consumer). P0-CT-02's negative (without CCTUI the key stays
		// unset) keeps holding under the new semantics.
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
				version: 2,
				onChange: onChangeRegister,
				revision: current.revision + 1,
			});
			g.__piClaudeCodeCore = current;
			g.__piClaudeCodeCoreCmd = (cmd: CoreCommand) => bus.handleCommand(cmd);
			deriveLegacy(current);
			for (const listener of listeners) listener();
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
