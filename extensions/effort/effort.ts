import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { Model, ThinkingLevel } from "@earendil-works/pi-ai";
import { readJson, readJsonCached, writeJsonAtomic } from "../../lib/settings.js";

export const ALL_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export const ALL_LEVELS_WITHOUT_XHIGH = ["off", "minimal", "low", "medium", "high"] as const;

/**
 * B5 (cherry-batch2): clamp a requested level to the model's nearest
 * SUPPORTED tier. Equidistant → the lower side (lower tiers spend fewer
 * tokens and fail smaller — the conservative direction). "off" is always
 * legal. An unresolvable model returns undefined — the CALLER keeps the
 * status-quo reject (today /effort with a null model refuses; clamp-style
 * must not widen that).
 */
export function clampToSupported(
  level: EffortLevel,
  model: EffortModel | null | undefined,
): { level: EffortLevel; clamped: boolean } | undefined {
  if (level === "off") return { level, clamped: false };
  if (!model) return undefined;
  const available = getAvailableThinkingLevels(model);
  if (available.includes(level)) return { level, clamped: false };
  const ranks = ALL_LEVELS as readonly EffortLevel[];
  const requested = ranks.indexOf(level);
  let best: EffortLevel | undefined;
  let bestDist = Number.POSITIVE_INFINITY;
  for (const candidate of available) {
    const dist = Math.abs(ranks.indexOf(candidate) - requested);
    if (dist < bestDist || (dist === bestDist && ranks.indexOf(candidate) < ranks.indexOf(best!))) {
      best = candidate;
      bestDist = dist;
    }
  }
  if (best === undefined) return { level: "off", clamped: true };
  return { level: best, clamped: true };
}

export const USER_LEVELS = ["minimal", "low", "medium", "high", "xhigh"] as const satisfies readonly ThinkingLevel[];

export const SEMANTIC_ALIASES = ["min", "max"] as const;

export const FAST_MODE_ACTIONS = ["on", "off"] as const;

export type EffortLevel = (typeof ALL_LEVELS)[number];
export type EffortAlias = (typeof SEMANTIC_ALIASES)[number];
export type FastModeAction = (typeof FAST_MODE_ACTIONS)[number];

export function toThinkingLevel(level: EffortLevel): ThinkingLevel | "off" {
  return level;
}

export function isEffortLevel(value: string): value is EffortLevel {
  return ALL_LEVELS.includes(value as EffortLevel);
}

export function isEffortAlias(value: string): value is EffortAlias {
  return SEMANTIC_ALIASES.includes(value as EffortAlias);
}

export type EffortCommand =
  | { kind: "set-session"; level: EffortLevel }
  | { kind: "set-min" }
  | { kind: "set-max" }
  | { kind: "reset" };

export type FastCommand = { kind: "fast-set"; enabled: boolean } | { kind: "fast-toggle" };

export type EffortModel = Pick<Model<any>, "id" | "reasoning" | "thinkingLevelMap">;


function levenshteinDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;

  const dp: number[] = new Array(n + 1);
  for (let j = 0; j <= n; j++) dp[j] = j;

  for (let i = 1; i <= m; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const temp = dp[j];
      if (a[i - 1] === b[j - 1]) {
        dp[j] = prev;
      } else {
        dp[j] = Math.min(prev + 1, dp[j] + 1, dp[j - 1] + 1);
      }
      prev = temp;
    }
  }
  return dp[n];
}

function suggestClosest(input: string, candidates: readonly string[]): string | null {
  let best: string | null = null;
  let bestDist = Infinity;
  for (const candidate of candidates) {
    const dist = levenshteinDistance(input, candidate);
    if (dist < bestDist && dist <= 2) {
      bestDist = dist;
      best = candidate;
    }
  }
  return best;
}

const EFFORT_TOKEN_CANDIDATES = [...USER_LEVELS, ...SEMANTIC_ALIASES];


export function parseEffortCommand(args: string): EffortCommand {
  const tokens = args.trim().split(/\s+/).filter(Boolean);

  if (tokens.length !== 1) {
    throw new Error(USAGE);
  }

  const [first] = tokens;
  if (first === "max") return { kind: "set-max" };
  if (first === "min") return { kind: "set-min" };
  if (first === "reset") return { kind: "reset" };
  if ((USER_LEVELS as readonly string[]).includes(first)) return { kind: "set-session", level: first as EffortLevel };

  const suggestion = suggestClosest(first, EFFORT_TOKEN_CANDIDATES);
  const hint = suggestion ? ` Did you mean "${suggestion}"?` : "";
  throw new Error(`Unknown effort level "${first}".${hint}\n${USAGE}`);
}

export function parseFastCommand(args: string): FastCommand {
  const tokens = args.trim().split(/\s+/).filter(Boolean);

  if (tokens.length === 0) return { kind: "fast-toggle" };

  if (tokens.length !== 1) {
    throw new Error(FAST_USAGE);
  }

  const [first] = tokens;
  if (first === "on") return { kind: "fast-set", enabled: true };
  if (first === "off") return { kind: "fast-set", enabled: false };

  const suggestion = suggestClosest(first, FAST_MODE_ACTIONS);
  const hint = suggestion ? ` Did you mean "${suggestion}"?` : "";
  throw new Error(`Unknown fast mode "${first}".${hint}\n${FAST_USAGE}`);
}


export function getAvailableThinkingLevels(model: EffortModel | null | undefined): EffortLevel[] {
  if (!model) return ["off"];
  return getSupportedThinkingLevels(model as Model<any>).filter(isEffortLevel);
}

export function getUserFacingLevels(model: EffortModel | null | undefined): EffortLevel[] {
  return getAvailableThinkingLevels(model).filter((l) => l !== "off");
}

export function resolveMinLevel(model: EffortModel | null | undefined): EffortLevel | undefined {
  if (!model?.reasoning) return undefined;
  return getUserFacingLevels(model)[0];
}

export function resolveMaxLevel(model: EffortModel | null | undefined): EffortLevel | undefined {
  if (!model?.reasoning) return undefined;
  const levels = getUserFacingLevels(model);
  return levels[levels.length - 1];
}

export function resolveEffortLevel(
  value: EffortLevel | EffortAlias,
  model: EffortModel | null | undefined
): EffortLevel | undefined {
  if (value === "min") return resolveMinLevel(model);
  if (value === "max") return resolveMaxLevel(model);
  return value;
}

export function cycleLevel(current: string, model: EffortModel | null | undefined): EffortLevel | undefined {
  const levels = getUserFacingLevels(model);
  if (levels.length === 0) return undefined;
  const idx = levels.indexOf(current as EffortLevel);
  if (idx === -1) return levels[0];
  return levels[(idx + 1) % levels.length];
}

export function cycleLevelWithOff(current: string, model: EffortModel | null | undefined): EffortLevel | undefined {
	const levels = getUserFacingLevels(model);
	if (levels.length === 0) return undefined;
	const withOff = ["off", ...levels] as EffortLevel[];
	const idx = withOff.indexOf(current as EffortLevel);
	if (idx === -1) return withOff[0]!;
	return withOff[(idx + 1) % withOff.length]!;
}

/** C5 (arch review): the shared shortcut decision — pure, so the
 * zero-explicit-write guard is testable without a runtime. "noop" = the
 * model supports no other level: the handler notifies and MUST NOT call
 * owner.setExplicit (the old probe loop pinned a clamped value into the
 * explicit slot and suppressed profile effort for the whole session). */
export type CycleDecision =
	| { kind: "write"; next: EffortLevel }
	| { kind: "noop"; current: string }
	| { kind: "unavailable" };

export function decideCycleShortcut(
	current: string,
	model: EffortModel | null | undefined,
	opts: { includeOff: boolean },
): CycleDecision {
	const next = opts.includeOff ? cycleLevelWithOff(current, model) : cycleLevel(current, model);
	if (!next) return { kind: "unavailable" };
	if (next === current) return { kind: "noop", current };
	return { kind: "write", next };
}



export function readSettingsObject(settingsPath: string): Record<string, unknown> {
  return readJsonCached<Record<string, unknown>>(settingsPath, {}, (reason) => {
    if (reason === "malformed" || reason === "non-object") {
      throw new Error("settings.json is not a JSON object");
    }
  });
}

function writeSettingsObject(settingsPath: string, settings: Record<string, unknown>): void {
  writeJsonAtomic(settingsPath, settings);
}

function readPiEffortSettings(settings: Record<string, unknown>): Record<string, unknown> {
  const value = settings["pi-effort"];
  return value && typeof value === "object" && !Array.isArray(value) ? { ...(value as Record<string, unknown>) } : {};
}

export function getFastMode(settingsPath: string): boolean {
  try {
    const settings = readSettingsObject(settingsPath);
    const piEffort = readPiEffortSettings(settings);
    return piEffort.fastMode === true;
  } catch {
    return false;
  }
}

export function writeFastMode(settingsPath: string, enabled: boolean): void {
  const settings = readSettingsObject(settingsPath);
  const piEffort = readPiEffortSettings(settings);
  piEffort.fastMode = enabled;
  settings["pi-effort"] = piEffort;
  writeSettingsObject(settingsPath, settings);
}


export const USAGE = "Usage: /effort {min|minimal|low|medium|high|xhigh|max}";
export const FAST_USAGE = "Usage: /fast [on|off]";
