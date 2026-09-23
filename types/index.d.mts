/**
 * pi-claude-code-core capability bus — published types + total reader (P1-BUS-02).
 *
 * Hand-maintained declaration twin of types/core-status.mjs (published as pure JS + these
 * declarations via the `./types` subpath export). Shape compatibility with
 * extensions/bus.ts is guarded by test/lib/bus-types.test.ts.
 */
export interface LegacyPmCapability {
	version?: number;
	active?: boolean;
	mode?: string;
	workingStats?: unknown;
}

export interface CoreSnapshot {
	version: 1;
	revision: number;
	modes: {
		mode: "ask" | "plan" | "auto" | "bypass" | "";
		planPhase?: "exploring" | "refining" | "reviewing" | "executing";
		workingStats: string | null;
		/** DC1: presentation material single-sourced from MODE_META (icon/label/role per mode). */
		meta?: Readonly<Record<string, { icon: string; label: string; role: string }>>;
	};
	effort: { level: string | null; source: "env" | "session" | "profile" | "model-default" };
	goal: { active: boolean; paused?: boolean; summary: string | null; widget?: { focus: "focused" | "unfocused" | "none"; statusLine: string } };
	review: { status: "idle" | "running" | "done"; lastRunAt: number | null };
	/** DC3: bounded notification tail queue (monotonic ids, newest last, cap 20). */
	notifications?: ReadonlyArray<{ id: number; level: "info" | "warning" | "error"; msg: string }>;
	display?: { footer?: readonly string[] };
	contextBudget?: { rulesMax: number; memoryIndexMax: number; dynamicSteerMax: number };
	memory?: { yielded: boolean; dir?: string };
}

export type CoreCommand =
	| { kind: "setMode"; mode: string }
	| { kind: "setEffort"; level: string };

export interface CoreCommandResult {
	ok: boolean;
	reason?: string;
}

export interface CoreStatus {
	version: number;
	revision: number;
	modes: {
		mode: string;
		planPhase?: string;
		workingStats: string | null;
		meta?: Readonly<Record<string, { icon: string; label: string; role: string }>>;
	};
	effort: { level: string | null; source: string };
	goal: { active: boolean; paused?: boolean; summary: string | null; widget?: { focus: "focused" | "unfocused" | "none"; statusLine: string } };
	review: { status: string; lastRunAt: number | null };
	/** DC3: bounded notification tail queue (monotonic ids, newest last, cap 20). */
	notifications?: ReadonlyArray<{ id: number; level: "info" | "warning" | "error"; msg: string }>;
	display?: { footer?: readonly string[] };
	contextBudget?: { rulesMax: number; memoryIndexMax: number; dynamicSteerMax: number };
	memory?: { yielded: boolean; dir?: string };
}

export function readCoreStatus(g?: unknown): CoreStatus;
