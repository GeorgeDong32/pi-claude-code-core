import { homedir } from "node:os";
import { join } from "node:path";

import { readJson } from "../../lib/settings.ts";
import type { ControllerMode } from "./types.ts";

export interface SignalWeights {
	runClosed: number;
	goalStep: number;
	user: number;
	gitCommit: number;
	verified: number;
	idleGap: number;
	plainTurn: number;
	toolTurn: number;
}

export interface RexFlowLedgerSettings {
	enabled: boolean;
	boardPath?: string;
}

export interface LedgerSettings {
	rexFlow: RexFlowLedgerSettings;
}

export interface CompactionSettings {
	mode: ControllerMode;
	precomputeRatio: number;
	applyRatio: number;
	targetPostRatio: number;
	hardFitRatio: number;
	overflowFitRatio: number;
	summaryTokenEstimate: number;
	unknownOverheadTokens: number;
	keepSlackTokens: number;
	summaryModel: string | null;
	summaryThinking: "off" | "minimal" | "default";
	summaryMaxTokens: number | null;
	fallbackDeadlineMs: number;
	minNarrativeChars: number;
	minPrefixChars: number;
	maxSummaryChars: number;
	idleGapMs: number;
	refusedCooldownTurns: number;
	degradeAfterRefusals: number;
	conflictEditDegradeAfter: number;
	minPrecomputeGapTurns: number;
	reconcileScanMax: number;
	directivesMax: number;
	perDirectiveMax: number;
	maxDirectiveLines: number;
	maxOpenItems: number;
	standingPatterns: string[];
	ledger: LedgerSettings;
	weights: SignalWeights;
	lambda: number;
}

export const DEFAULT_COMPACTION_CORE_SETTINGS: CompactionSettings = Object.freeze({
	mode: "on",
	precomputeRatio: 0.6,
	applyRatio: 0.75,
	targetPostRatio: 0.45,
	hardFitRatio: 0.9,
	overflowFitRatio: 0.75,
	summaryTokenEstimate: 12_000,
	unknownOverheadTokens: 8_000,
	keepSlackTokens: 40_000,
	summaryModel: null,
	summaryThinking: "off",
	summaryMaxTokens: null,
	fallbackDeadlineMs: 150_000,
	minNarrativeChars: 400,
	minPrefixChars: 100,
	maxSummaryChars: 40_000,
	idleGapMs: 600_000,
	refusedCooldownTurns: 15,
	degradeAfterRefusals: 3,
	conflictEditDegradeAfter: 2,
	minPrecomputeGapTurns: 3,
	reconcileScanMax: 50,
	directivesMax: 5_000,
	perDirectiveMax: 1_500,
	maxDirectiveLines: 100,
	maxOpenItems: 60,
	standingPatterns: [
		"不要", "禁止", "必须", "一律", "始终", "只能", "不得", "别",
		"never", "always", "must", "do not", "don't", "only", "without",
	],
	ledger: { rexFlow: { enabled: true } },
	weights: Object.freeze({
		runClosed: 100,
		goalStep: 90,
		user: 80,
		gitCommit: 60,
		verified: 55,
		idleGap: 50,
		plainTurn: 30,
		toolTurn: 10,
	}),
	lambda: 20,
});

function num(value: unknown, fallback: number, min: number, minInclusive = false): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	const ok = minInclusive ? value >= min : value > min;
	return ok ? value : fallback;
}

export type RatioGroup = Pick<
	CompactionSettings,
	"targetPostRatio" | "precomputeRatio" | "applyRatio" | "hardFitRatio" | "overflowFitRatio"
>;

export function validateRatioGroup(partial: Partial<RatioGroup>): { ratios: RatioGroup; reverted: boolean } {
	const d = DEFAULT_COMPACTION_CORE_SETTINGS;
	const unit = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v > 0 && v < 1;
	let violated = false;
	const merged: RatioGroup = {
		targetPostRatio: d.targetPostRatio,
		precomputeRatio: d.precomputeRatio,
		applyRatio: d.applyRatio,
		hardFitRatio: d.hardFitRatio,
		overflowFitRatio: d.overflowFitRatio,
	};
	for (const key of ["targetPostRatio", "precomputeRatio", "applyRatio", "hardFitRatio", "overflowFitRatio"] as const) {
		const raw = partial[key];
		if (raw === undefined) continue;
		if (key === "overflowFitRatio") {
			if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) merged.overflowFitRatio = raw;
			else violated = true;
		} else if (key === "hardFitRatio") {
			if (typeof raw === "number" && Number.isFinite(raw) && raw > 0 && raw <= 1) merged.hardFitRatio = raw;
			else violated = true;
		} else if (unit(raw)) merged[key] = raw;
		else violated = true;
	}
	const orderOk = merged.targetPostRatio < merged.precomputeRatio && merged.precomputeRatio < merged.applyRatio;
	const fitOk = merged.overflowFitRatio <= merged.hardFitRatio;
	if (!violated && orderOk && fitOk) return { ratios: merged, reverted: false };
	return {
		ratios: {
			targetPostRatio: d.targetPostRatio,
			precomputeRatio: d.precomputeRatio,
			applyRatio: d.applyRatio,
			hardFitRatio: d.hardFitRatio,
			overflowFitRatio: d.overflowFitRatio,
		},
		reverted: true,
	};
}

function normalize(raw: Record<string, unknown>): { settings: CompactionSettings; warned: string[] } {
	const d = DEFAULT_COMPACTION_CORE_SETTINGS;
	const warned: string[] = [];
	const mode = raw.mode === "off" || raw.mode === "shadow" || raw.mode === "on" ? raw.mode : d.mode;
	const { ratios, reverted } = validateRatioGroup({
		targetPostRatio: raw.targetPostRatio as number,
		precomputeRatio: raw.precomputeRatio as number,
		applyRatio: raw.applyRatio as number,
		hardFitRatio: raw.hardFitRatio as number,
		overflowFitRatio: raw.overflowFitRatio as number,
	});
	if (reverted) warned.push("ratio group invalid; defaults apply");
	const thinking =
		raw.summaryThinking === "off" || raw.summaryThinking === "minimal" || raw.summaryThinking === "default"
			? raw.summaryThinking
			: d.summaryThinking;
	const patterns = Array.isArray(raw.standingPatterns)
		? raw.standingPatterns.filter((p): p is string => typeof p === "string" && p.length > 0)
		: d.standingPatterns;
	const ledgerRaw = (raw.ledger ?? {}) as Record<string, unknown>;
	const rexRaw = (ledgerRaw.rexFlow ?? {}) as Record<string, unknown>;
	const weightsRaw = (raw.weights ?? {}) as Record<string, unknown>;
	const weights = { ...d.weights };
	for (const key of Object.keys(weights) as Array<keyof SignalWeights>) {
		const value = weightsRaw[key];
		if (typeof value === "number" && Number.isFinite(value)) weights[key] = value;
	}
	return {
		settings: {
			mode,
			...ratios,
			summaryTokenEstimate: num(raw.summaryTokenEstimate, d.summaryTokenEstimate, 0),
			unknownOverheadTokens: num(raw.unknownOverheadTokens, d.unknownOverheadTokens, 0),
			keepSlackTokens: num(raw.keepSlackTokens, d.keepSlackTokens, 0),
			summaryModel: typeof raw.summaryModel === "string" && raw.summaryModel.length > 0 ? raw.summaryModel : d.summaryModel,
			summaryThinking: thinking,
			summaryMaxTokens: typeof raw.summaryMaxTokens === "number" && Number.isFinite(raw.summaryMaxTokens) && raw.summaryMaxTokens > 0 ? raw.summaryMaxTokens : d.summaryMaxTokens,
			fallbackDeadlineMs: num(raw.fallbackDeadlineMs, d.fallbackDeadlineMs, 0),
			minNarrativeChars: num(raw.minNarrativeChars, d.minNarrativeChars, 0),
			minPrefixChars: num(raw.minPrefixChars, d.minPrefixChars, 0),
			maxSummaryChars: num(raw.maxSummaryChars, d.maxSummaryChars, 0),
			idleGapMs: num(raw.idleGapMs, d.idleGapMs, 0),
			refusedCooldownTurns: num(raw.refusedCooldownTurns, d.refusedCooldownTurns, 0, true),
			degradeAfterRefusals: num(raw.degradeAfterRefusals, d.degradeAfterRefusals, 0, true),
			conflictEditDegradeAfter: num(raw.conflictEditDegradeAfter, d.conflictEditDegradeAfter, 0, true),
			minPrecomputeGapTurns: num(raw.minPrecomputeGapTurns, d.minPrecomputeGapTurns, 0, true),
			reconcileScanMax: num(raw.reconcileScanMax, d.reconcileScanMax, 0, true),
			directivesMax: num(raw.directivesMax, d.directivesMax, 0),
			perDirectiveMax: num(raw.perDirectiveMax, d.perDirectiveMax, 0),
			maxDirectiveLines: num(raw.maxDirectiveLines, d.maxDirectiveLines, 0, true),
			maxOpenItems: num(raw.maxOpenItems, d.maxOpenItems, 0, true),
			standingPatterns: patterns.length > 0 ? patterns : d.standingPatterns,
			ledger: {
				rexFlow: {
					enabled: typeof rexRaw.enabled === "boolean" ? rexRaw.enabled : d.ledger.rexFlow.enabled,
					...(typeof rexRaw.boardPath === "string" && rexRaw.boardPath.length > 0 ? { boardPath: rexRaw.boardPath } : {}),
				},
			},
			weights,
			lambda: num(raw.lambda, d.lambda, 0, true),
		},
		warned,
	};
}

let settingsPath: string | undefined;

export function setCompactionSettingsPath(path: string | undefined): void {
	settingsPath = path;
}

export function getCompactionSettingsPath(): string {
	return (settingsPath ??= join(homedir(), ".pi", "agent", "core-compaction.json"));
}

export function loadCompactionSettings(env: Record<string, string | undefined> = process.env): {
	settings: CompactionSettings;
	warned: string[];
} {
	const path = getCompactionSettingsPath();
	const fileWarned: string[] = [];
	const raw = readJson<Record<string, unknown>>(path, {}, (reason) => {
		if (reason !== "missing") fileWarned.push(`${reason} core-compaction.json ignored; defaults apply`);
	});
	const { settings, warned } = normalize(raw);
	const envMode = env["PI_CORE_COMPACTION"];
	let mode = settings.mode;
	let envWarn: string | undefined;
	if (envMode !== undefined) {
		if (envMode === "off" || envMode === "shadow" || envMode === "on") {
			mode = envMode;
		} else {
			envWarn = `PI_CORE_COMPACTION=${envMode} ignored (off|shadow|on)`;
		}
	}
	return {
		settings: { ...settings, mode },
		warned: envWarn ? [...fileWarned, ...warned, envWarn] : [...fileWarned, ...warned],
	};
}
