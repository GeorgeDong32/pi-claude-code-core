/*
 * pi host compatibility probes (SPEC CMP-01..06).
 *
 * Declares every pi dependency the economy modules lean on as an explicit
 * probe instead of an implicit assumption — the failure mode this exists to
 * prevent is the upstream SoL-Pi one (a pi upgrade silently breaking a
 * mechanism with no error and no warning).
 *
 * This module never imports pi runtime objects (CMP-06): everything it
 * inspects is injected, so it is unit-testable under plain node:test.
 */

/** Minimum pi version the economy modules' semantics were verified against. */
export const MIN_PI_VERSION = "0.87.0";

export interface PiCompatInputs {
	/** pi package VERSION string (imported by the caller). */
	readonly version: string;
	/** createWriteToolDefinition et al., or undefined when absent. */
	readonly toolFactories?: unknown;
	/** withFileMutationQueue export, or undefined when absent. */
	readonly mutationQueue?: unknown;
}

export interface PiCompat {
	readonly version: string;
	readonly versionOk: boolean;
	readonly toolFactories: boolean;
	readonly mutationQueue: boolean;
	/** Non-empty list of what is missing, for the footer/warn line. */
	readonly problems: readonly string[];
}

/** Parse "1.2.3[-tag]" into [major, minor, patch]; NaN fields sort low. */
function versionParts(version: string): [number, number, number] {
	const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
	if (!match) return [Number.NaN, Number.NaN, Number.NaN];
	return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** >= comparison on the numeric triples; NaN compares as "not ok". */
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
	// B4: a probe counts as a DEPENDENCY only when its input was provided —
	// observation-pack probes version alone and must not see tool-factory
	// noise. Absent (undefined) inputs are simply not this caller's deps.
	if (inputs.toolFactories !== undefined && !toolFactories) {
		problems.push("mutation tool factories unavailable");
	}
	// B4: mutationQueue is pure diagnostics now (FUS-03: the official queue
	// deadlocks as the outer layer, so it gates nothing) — boolean stays for
	// the host-health record, problems stays actionable-only.
	return { version: inputs.version, versionOk, toolFactories, mutationQueue, problems };
}

/**
 * B4: the ONE degrade tail both economy modules share — warn once, publish
 * the footer line, and tell the caller to stop registering. Pure function:
 * the publish and notify channels are injected callbacks, so the self-disable
 * path ("pi upgraded underneath us") is unit-testable without a bus.
 */
export function degradeEconomyModule(args: {
	compat: PiCompat;
	label: string;
	/** Footer sink — in production `(line) => coreBus().publish({ display: { footer: [line] } })`. */
	publish: (footerLine: string) => void;
	/** Console sink override (tests). Defaults to console.warn. */
	notify?: (message: string) => void;
}): boolean {
	if (args.compat.problems.length === 0) return true;
	const message = `[${args.label}] disabled: ${args.compat.problems.join("; ")}`;
	if (args.notify) args.notify(message);
	else console.warn(message);
	args.publish(`${args.label} requires pi >=${MIN_PI_VERSION}`);
	return false;
}
