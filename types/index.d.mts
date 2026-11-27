/**
 * TYPE-ONLY entry: the runtime reader is withdrawn — consumers duck-type the
 * snapshot on `globalThis.__piClaudeCodeCore` (or `snapshot.onChange`-subscribe).
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
	/** Per-bus-instance random id; constant across that instance's publishes,
	 * different after /reload. Consumers use it to detect a bus swap and
	 * re-subscribe; old snapshots may lack the field. */
	instance?: string;
	/** Data-carried subscription point — snapshot.onChange(fn) registers, returns unsubscribe. v2+ only. */
	onChange?: (fn: () => void) => () => void;
	modes: {
		mode: "ask" | "plan" | "auto" | "bypass" | "";
		planPhase?: "exploring" | "refining" | "reviewing" | "executing";
		workingStats: string | null;
		/** Presentation material single-sourced from MODE_META (icon/label/role per mode). */
		meta?: Readonly<Record<string, { icon: string; label: string; role: string }>>;
		/** Raw usage numbers, derived from the SAME working-stats snapshot as
		 * the workingStats string. Finite non-negative only; a missing required
		 * cumulative field omits the whole object; unknown optionals are ABSENT,
		 * never faked as 0. */
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
	/** Bounded notification tail queue (monotonic ids, newest last, cap 20). */
	notifications?: ReadonlyArray<{ id: number; level: "info" | "warning" | "error"; msg: string }>;
	display?: { footer?: readonly string[] };
	contextBudget?: { rulesMax: number; memoryIndexMax: number; dynamicSteerMax: number };
	memory?: { yielded: boolean; dir?: string };
	/** Optional per-site display-only savings (first-replacement requests only). */
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
