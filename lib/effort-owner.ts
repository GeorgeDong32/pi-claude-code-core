
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export type OwnerEffortLevel = ReturnType<ExtensionAPI["getThinkingLevel"]>;

export type EffortSource = "env" | "session" | "profile" | "model-default";

export type ExplicitSource = "command" | "picker" | "shortcut";

export interface EffortOwner {
	setFromEnv(v: string): void;
	setExplicit(v: OwnerEffortLevel, src: ExplicitSource): "applied" | "pinned-by-env";
	setFromProfile(v: OwnerEffortLevel, profile: string): void;
	resetExplicit(): void;
	envPin(): OwnerEffortLevel | null;
	beginModelSwitch(): void;
	endModelSwitch(): void;
	inModelSwitch(): boolean;
	noteModelSwitchLevel(v: OwnerEffortLevel): void;
	afterHostModelSwitch(): void;
	lastApplied(): OwnerEffortLevel | null;
	effective(): OwnerEffortLevel;
	currentSource(): EffortSource;
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

const sharedOwners = new WeakMap<object, EffortOwner>();

function createEffortOwner(pi: ExtensionAPI): EffortOwner {
	let envLevel: OwnerEffortLevel | null = null;
	let explicit: { v: OwnerEffortLevel; src: ExplicitSource } | null = null;
	let profile: { v: OwnerEffortLevel; profile: string } | null = null;
	let applied: OwnerEffortLevel | null = null;
	let modelSwitchDepth = 0;
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
		if (!r) return;
		applied = r.v;
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
		beginModelSwitch() {
			modelSwitchDepth++;
		},
		endModelSwitch() {
			modelSwitchDepth = Math.max(0, modelSwitchDepth - 1);
		},
		inModelSwitch: () => modelSwitchDepth > 0,
		noteModelSwitchLevel(v) {
			applied = v;
			profile = null;
		},
		afterHostModelSwitch() {
			profile = null;
			apply();
		},
		lastApplied: () => applied,
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

export function newEffortOwner(pi: ExtensionAPI): EffortOwner {
	return createEffortOwner(pi);
}

export function getSharedEffortOwner(pi: ExtensionAPI): EffortOwner {
	let owner = sharedOwners.get(pi);
	if (!owner) {
		owner = createEffortOwner(pi);
		sharedOwners.set(pi, owner);
	}
	return owner;
}
