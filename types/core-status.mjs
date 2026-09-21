/**
 * pi-claude-code-core capability bus — published runtime reader.
 *
 * This module ships as the `./types` subpath runtime (plain ESM JS, no build
 * step) so consumers (CCTUI, panel, pi-subagents) can
 * `import { readCoreStatus } from "@georgedong32/pi-claude-code-core/types"`
 * with zero transform cost and a total reader instead of duck-typing
 * (P1-BUS-02). Types come from ./index.d.mts via the same subpath's
 * "types" condition.
 *
 * readCoreStatus NEVER throws on any input (P1-BUS-07): unknown versions,
 * garbage shapes and missing keys all fall back down the chain
 * new key → legacy `__piPermissionModes` → defaults.
 */

const DEFAULT_STATUS = {
	version: 0,
	revision: 0,
	modes: { mode: "", workingStats: null },
	effort: { level: null, source: "model-default" },
	goal: { active: false, summary: null },
	review: { status: "idle", lastRunAt: null },
};

function isObject(v) {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

function readModeChannel(raw) {
	if (!isObject(raw)) return { ...DEFAULT_STATUS.modes };
	return {
		mode: typeof raw.mode === "string" ? raw.mode : "",
		...(typeof raw.planPhase === "string" ? { planPhase: raw.planPhase } : {}),
		workingStats: typeof raw.workingStats === "string" ? raw.workingStats : null,
	};
}

function readEffortChannel(raw) {
	if (!isObject(raw)) return { ...DEFAULT_STATUS.effort };
	const sources = ["env", "session", "profile", "model-default"];
	return {
		level: typeof raw.level === "string" ? raw.level : null,
		source: sources.indexOf(raw.source) >= 0 ? raw.source : "model-default",
	};
}

function readGoalChannel(raw) {
	if (!isObject(raw)) return { ...DEFAULT_STATUS.goal };
	return {
		active: raw.active === true,
		...(typeof raw.paused === "boolean" ? { paused: raw.paused } : {}),
		summary: typeof raw.summary === "string" ? raw.summary : null,
	};
}

function readReviewChannel(raw) {
	if (!isObject(raw)) return { ...DEFAULT_STATUS.review };
	const statuses = ["idle", "running", "done"];
	return {
		status: statuses.indexOf(raw.status) >= 0 ? raw.status : "idle",
		lastRunAt: typeof raw.lastRunAt === "number" ? raw.lastRunAt : null,
	};
}

function readDisplayChannel(raw) {
	if (!isObject(raw) || !Array.isArray(raw.footer)) return undefined;
	return { footer: raw.footer.filter((s) => typeof s === "string") };
}

/**
 * Total reader for the core capability bus. Accepts a globalThis-like object
 * (default: the real globalThis); any input — undefined, garbage, future
 * versions with unknown shapes — yields a valid status object, never throws.
 */
export function readCoreStatus(g) {
	var host = g === undefined || g === null ? globalThis : g;
	try {
		var snap = host.__piClaudeCodeCore;
		if (isObject(snap) && typeof snap.version === "number" && snap.version >= 1) {
			return {
				version: snap.version,
				revision: typeof snap.revision === "number" ? snap.revision : 0,
				modes: readModeChannel(snap.modes),
				effort: readEffortChannel(snap.effort),
				goal: readGoalChannel(snap.goal),
				review: readReviewChannel(snap.review),
				display: readDisplayChannel(snap.display),
			};
		}
		// Legacy fallback: pm 2.8.x capability object.
		var legacy = host.__piPermissionModes;
		if (isObject(legacy)) {
			return {
				...DEFAULT_STATUS,
				version: typeof legacy.version === "number" ? legacy.version : 1,
				modes: {
					mode: typeof legacy.mode === "string" ? legacy.mode : "",
					workingStats: typeof legacy.workingStats === "string" ? legacy.workingStats : null,
				},
			};
		}
		return { ...DEFAULT_STATUS };
	} catch (_e) {
		return { ...DEFAULT_STATUS };
	}
}
