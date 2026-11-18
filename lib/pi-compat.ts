
export const MIN_PI_VERSION = "0.87.0";

export interface PiCompatInputs {
	readonly version: string;
	readonly toolFactories?: unknown;
	readonly mutationQueue?: unknown;
}

export interface PiCompat {
	readonly version: string;
	readonly versionOk: boolean;
	readonly toolFactories: boolean;
	readonly mutationQueue: boolean;
	readonly problems: readonly string[];
}

function versionParts(version: string): [number, number, number] {
	const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
	if (!match) return [Number.NaN, Number.NaN, Number.NaN];
	return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function versionAtLeast(version: string, minimum: string): boolean {
	const [vMajor, vMinor, vPatch] = versionParts(version);
	const [mMajor, mMinor, mPatch] = versionParts(minimum);
	if (Number.isNaN(vMajor) || Number.isNaN(mMajor)) return false;
	if (vMajor !== mMajor) return vMajor > mMajor;
	if (vMinor !== mMinor) return vMinor > mMinor;
	return vPatch >= mPatch;
}

function allFunctions(values: unknown): boolean {
	const candidate = values as Record<string, unknown> | undefined;
	if (!candidate) return false;
	return Object.values(candidate).every((value) => typeof value === "function");
}

export function probePiCompat(inputs: PiCompatInputs): PiCompat {
	const versionOk = versionAtLeast(inputs.version, MIN_PI_VERSION);
	const toolFactories = allFunctions(inputs.toolFactories);
	const mutationQueue = typeof inputs.mutationQueue === "function";
	const problems: string[] = [];
	if (!versionOk) problems.push(`pi ${inputs.version} < ${MIN_PI_VERSION}`);
	if (inputs.toolFactories !== undefined && !toolFactories) {
		problems.push("mutation tool factories unavailable");
	}
	// B4: mutationQueue is pure diagnostics now (FUS-03: the official queue
	// deadlocks as the outer layer, so it gates nothing) — boolean stays for
	// the host-health record, problems stays actionable-only.
	return { version: inputs.version, versionOk, toolFactories, mutationQueue, problems };
}

/**
 * SPEC 2026-10-07 P1-1 §4.4: the PURE-DATA assessment both economy modules
 * share — no console, no publish. Callers warn at load time and publish the
 * footer line from their first session_start handler (bus invariant 3: no
 * publishing outside event handlers). `enabled` true means keep registering.
 */
export function assessEconomyModule(compat: PiCompat, label: string): {
	enabled: boolean;
	warning?: string;
	footerLine?: string;
} {
	if (compat.problems.length === 0) return { enabled: true };
	return {
		enabled: false,
		warning: `[${label}] disabled: ${compat.problems.join("; ")}`,
		footerLine: `${label} requires pi >=${MIN_PI_VERSION}`,
	};
}

export function degradeEconomyModule(args: {
	compat: PiCompat;
	label: string;
	publish: (footerLine: string) => void;
	notify?: (message: string) => void;
}): boolean {
	const assessment = assessEconomyModule(args.compat, args.label);
	if (assessment.enabled) return true;
	if (args.notify) args.notify(assessment.warning!);
	else console.warn(assessment.warning);
	args.publish(assessment.footerLine!);
	return false;
}
