/**
 * pi-claude-code-core capability bus — published types (pure type-only entry).
 *
 * D4=B (user 2026-10-08, spec 2026-10-07 P1-1 §4.3): the `./types` subpath is
 * TYPE-ONLY — the runtime reader (`readCoreStatus`) and its `CoreStatus`
 * interface are withdrawn. Consumers duck-type the snapshot on
 * `globalThis.__piClaudeCodeCore` (or `snapshot.onChange`-subscribe); the
 * declaration twin of extensions/bus.ts is guarded by test/lib/bus-types.test.ts.
 */
export interface LegacyPmCapability {
	version?: number;
	active?: boolean;
	mode?: string;
	workingStats?: unknown;
}

export interface CoreSnapshot {
	version: number;
	revision: number;
	/** XPKG-03 (2026-10-07 P1-1): per-bus-instance random id; constant across
	 * that instance's publishes, different after /reload. Consumers use it to
	 * detect a bus swap and re-subscribe; old snapshots may lack the field. */
	instance?: string;
	/** DC5 (P1-BUS-10): data-carried subscription point — snapshot.onChange(fn) registers, returns unsubscribe. v2+ only. */
	onChange?: (fn: () => void) => () => void;
	modes: {
		mode: "ask" | "plan" | "auto" | "bypass" | "";
		planPhase?: "exploring" | "refining" | "reviewing" | "executing";
		workingStats: string | null;
		/** DC1: presentation material single-sourced from MODE_META (icon/label/role per mode). */
		meta?: Readonly<Record<string, { icon: string; label: string; role: string }>>;
		/** XPKG-08 (SPEC 2026-10-07 P2-4): raw usage numbers, derived from
		 * the SAME working-stats snapshot as the workingStats string. Finite
		 * non-negative only; a missing required cumulative field omits the
		 * whole object; unknown optionals are ABSENT, never faked as 0. */
		usage?: {
			input: number;
			output: number;
			cacheRead: number;
			cacheWrite: number;
			cost: number;
			tps?: number;
			ctxTokens?: number;
			ctxPercent?: number;
			contextWindow?: number;
		};
	};
	effort: { level: string | null; source: "env" | "session" | "profile" | "model-default" };
	goal: { active: boolean; paused?: boolean; summary: string | null; widget?: { focus: "focused" | "unfocused" | "none"; statusLine: string; goal?: { objective: string; status: string; sisyphus: boolean; stopReason?: string; pauseReason?: string; pauseSuggestedAction?: string; activePath?: string; archivedPath?: string; tokensUsed: number; activeSeconds: number; costUsed?: number }; openGoalCount?: number } };
	review: { status: "idle" | "running" | "done"; lastRunAt: number | null };
	/** DC3: bounded notification tail queue (monotonic ids, newest last, cap 20). */
	notifications?: ReadonlyArray<{ id: number; level: "info" | "warning" | "error"; msg: string }>;
	display?: { footer?: readonly string[] };
	contextBudget?: { rulesMax: number; memoryIndexMax: number; dynamicSteerMax: number };
	memory?: { yielded: boolean; dir?: string };
	/** OBS-09-SITES: optional per-site display-only savings (first-replacement requests only). */
	observation?: { tokensAvoided: number; placeholders: number; sites?: ReadonlyArray<{ tool: string; id: string; avoidedTokens: number; toolCallId?: string }> };
	fusion?: { fusedCount: number };
}

export type CoreCommand =
	| { kind: "setMode"; mode: string }
	| { kind: "setEffort"; level: string };

export interface CoreCommandResult {
	ok: boolean;
	reason?: string;
}
