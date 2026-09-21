/**
 * thinking-level ownership chain (P1-EF-05, D5).
 *
 * Single owner arbitrating every thinking-level writer in core:
 *
 *   ① PI_CORE_EFFORT env pin (setFromEnv, read once at startup) — hard pin;
 *     explicit writes are refused while set
 *   ② explicit session choice (setExplicit from /effort command, picker or
 *     alt+t shortcut) — manual intent beats profile
 *   ③ mode profile `:effort` (setFromProfile)
 *   ④ model default (no slot set → owner never writes; pi keeps its default)
 *
 * Priority ① > ② > ③ > ④. The effective value is pushed down through
 * `pi.setThinkingLevel` — this module is the ONLY place in core allowed to
 * call it (P1-EF-07 source scan enforces that for extensions/).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** pi's thinking-level union (includes "off"); alt+t must be able to set it. */
export type OwnerEffortLevel = ReturnType<ExtensionAPI["getThinkingLevel"]>;

/** Where the currently-effective value comes from (bus `effort.source`). */
export type EffortSource = "env" | "session" | "profile" | "model-default";

export type ExplicitSource = "command" | "picker" | "shortcut";

export interface EffortOwner {
	/** ① PI_CORE_EFFORT, startup read. Unknown tokens are ignored. */
	setFromEnv(v: string): void;
	/**
	 * ② explicit write. Refused (no state change) while ① is set — callers
	 * use envPin() to decide whether to notify "pinned by env".
	 */
	setExplicit(v: OwnerEffortLevel, src: ExplicitSource): "applied" | "pinned-by-env";
	/** ③ mode profile `:effort`. */
	setFromProfile(v: OwnerEffortLevel, profile: string): void;
	/** `/effort reset` → clear ②. */
	resetExplicit(): void;
	/** The ① value, or null when env does not pin. */
	envPin(): OwnerEffortLevel | null;
	/** ① > ② > ③ > ④ (falls through to pi's current level at ④). */
	effective(): OwnerEffortLevel;
	/** Source of the effective value (bus `effort.source`). */
	currentSource(): EffortSource;
	/** Register a listener fired after every state change. */
	changed(handler: (v: OwnerEffortLevel) => void): void;
}

const KNOWN_LEVELS: ReadonlySet<string> = new Set([
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
]);

// One owner per pi instance: modes and effort resolve the same shared owner
// for the same ExtensionAPI, while fresh fakes (tests) get fresh state.
const sharedOwners = new WeakMap<object, EffortOwner>();

function createEffortOwner(pi: ExtensionAPI): EffortOwner {
	let envLevel: OwnerEffortLevel | null = null;
	let explicit: { v: OwnerEffortLevel; src: ExplicitSource } | null = null;
	let profile: { v: OwnerEffortLevel; profile: string } | null = null;
	const listeners: Array<(v: OwnerEffortLevel) => void> = [];

	function normalize(v: string): OwnerEffortLevel | null {
		const t = v.trim().toLowerCase();
		return KNOWN_LEVELS.has(t) ? (t as OwnerEffortLevel) : null;
	}

	function resolved(): { v: OwnerEffortLevel; source: EffortSource } | null {
		if (envLevel !== null) return { v: envLevel, source: "env" };
		if (explicit !== null) return { v: explicit.v, source: "session" };
		if (profile !== null) return { v: profile.v, source: "profile" };
		return null;
	}

	function apply(): void {
		const r = resolved();
		if (!r) return; // ④ model default: never write
		if (pi.getThinkingLevel() !== r.v) {
			pi.setThinkingLevel(r.v);
		}
		for (const handler of listeners) {
			handler(r.v);
		}
	}

	return {
		setFromEnv(v: string) {
			const level = normalize(v);
			if (level === null) return;
			envLevel = level;
			apply();
		},
		setExplicit(v, src) {
			if (envLevel !== null) return "pinned-by-env";
			explicit = { v, src };
			apply();
			return "applied";
		},
		setFromProfile(v, profileName) {
			profile = { v, profile: profileName };
			apply();
		},
		resetExplicit() {
			if (explicit === null) return;
			explicit = null;
			apply();
		},
		envPin: () => envLevel,
		effective(): OwnerEffortLevel {
			const r = resolved();
			return r ? r.v : pi.getThinkingLevel();
		},
		currentSource(): EffortSource {
			return resolved()?.source ?? "model-default";
		},
		changed(handler) {
			listeners.push(handler);
		},
	};
}

/** Create a fresh owner bound to `pi` (unit tests, isolated setups). */
export function newEffortOwner(pi: ExtensionAPI): EffortOwner {
	return createEffortOwner(pi);
}

/**
 * Shared owner for a running pi process: modes (profile application, alt+t)
 * and effort (commands, picker) must arbitrate through the SAME instance.
 */
export function getSharedEffortOwner(pi: ExtensionAPI): EffortOwner {
	let owner = sharedOwners.get(pi);
	if (!owner) {
		owner = createEffortOwner(pi);
		sharedOwners.set(pi, owner);
	}
	return owner;
}
