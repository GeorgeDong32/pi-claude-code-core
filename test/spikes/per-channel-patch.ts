/**
 * P0-SK-05 spike ② — publishCore with EXPLICIT per-channel patch types.
 *
 * Proves the DESIGN-BUS shape is writable under tsc strict without a
 * generic DeepPartial: each channel gets its own explicit patch interface,
 * publishCore takes their union, wrong shapes fail to compile (see the
 * @ts-expect-error proofs below — they are the executable part of this
 * spike: `bun run check` turns green only while the errors stay errors).
 *
 * P1-BUS-03 will lift the accepted subset of this file into
 * extensions/bus.ts; this spike stays as the shape feasibility record.
 */

// ---- snapshot (DESIGN-BUS "Design 1.5") -----------------------------------

export interface CoreSnapshot {
	version: 1;
	revision: number;
	modes: {
		mode: "ask" | "plan" | "auto" | "bypass" | "";
		planPhase?: "exploring" | "reviewing" | "executing";
		workingStats: string | null;
	};
	effort: {
		level: string | null;
		source: "env" | "session" | "profile" | "model-default";
	};
	goal: { active: boolean; summary: string | null };
	review: { status: "idle" | "running" | "done"; lastRunAt: number | null };
	display?: { footer?: readonly string[] };
}

// ---- explicit per-channel patches (no DeepPartial) ------------------------

/** Full-replacement patch for the modes channel. */
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

// ---- minimal publisher (shape demo; the real one lives in extensions/) ----

const EMPTY: CoreSnapshot = {
	version: 1,
	revision: 0,
	modes: { mode: "", workingStats: null },
	effort: { level: null, source: "model-default" },
	goal: { active: false, summary: null },
	review: { status: "idle", lastRunAt: null },
};

export function makeInitialSnapshot(): CoreSnapshot {
	return structuredCloneish(EMPTY);
}

/** Whole-snapshot replace + freeze + revision bump, per DESIGN-BUS. */
export function applyPatch(prev: CoreSnapshot, patch: CorePatch): CoreSnapshot {
	const next: CoreSnapshot = {
		...prev,
		...patch,
		revision: prev.revision + 1,
	};
	return deepFreeze(next);
}

function structuredCloneish(v: unknown): CoreSnapshot {
	return JSON.parse(JSON.stringify(v)) as CoreSnapshot;
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

// ---- compile-time proofs ---------------------------------------------------
// Each block must FAIL to compile; @ts-expect-error verifies the explicit
// patch union rejects the classic DeepPartial failure modes.

export const _spikeProofs = {
	// @ts-expect-error partial channel objects are rejected (must be whole)
	badPartialModes: { modes: { mode: "ask" } } satisfies CorePatch,
	// @ts-expect-error unknown channels are rejected
	badUnknownChannel: { turbo: { mode: "ask", workingStats: null } } satisfies CorePatch,
	// @ts-expect-error wrong literal type inside a channel is rejected
	badLiteral: { modes: { mode: "yolo", workingStats: null } } satisfies CorePatch,
	// @ts-expect-error version is not patchable through a channel
	badVersion: { version: 2 as const, modes: { mode: "ask", workingStats: null } } satisfies ModesPatch,
};

// Accepted shapes compile plainly:
export const _spikeOk = {
	okModes: { modes: { mode: "plan" as const, planPhase: "executing" as const, workingStats: null } } satisfies ModesPatch,
	okDisplayOmitted: {} satisfies DisplayPatch,
	okDisplayFooter: { display: { footer: ["modes:plan"] } } satisfies DisplayPatch,
};
