/**
 * modes/profile-apply.ts — the stateful model-profile controller (arch
 * review C5 Move B, carved from index.ts 2026-10-03). profiles.ts owns the
 * pure layer (types / load / resolve); THIS module owns the state: the
 * active profile name, the in-memory config, lazy first activation,
 * reload re-stamping, the --model-profile flag pre-activation, and the
 * /model-profile + alt+i surfaces. The wiring (index.ts) injects
 * getMode / notify / onStateChanged / sendList and keeps only call sites.
 *
 * Fidelity points carried over verbatim (do not "fix" while moving):
 *   1. lazy first activation lives in applyForMode (NOT init) — a profile
 *      activates on the FIRST mode switch, not on session start;
 *   2. after reload, `active` is re-stamped IN MEMORY only — the on-disk
 *      file is never modified by a mode switch;
 *   3. entry restore overrides the --model-profile flag (the wiring calls
 *      restoreFromEntry AFTER initSession);
 *   4. a profile that maps a model but expresses NO effort leaves the
 *      thinking level completely alone (PLAN §3.3, P1-EF-06 d).
 *
 * Effort side effects go through lib/effort-owner.ts (invariant 2) — the
 * same single call site as before the move.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { getSharedEffortOwner, type OwnerEffortLevel } from "../../lib/effort-owner.ts";
import { modelIdentityKey } from "../../lib/model-id.ts";
import { clampToSupported, type EffortLevel } from "../effort/effort.ts";
import { notify as uiNotify } from "../ui/notify.ts";
import type { PermissionMode } from "./mode-prompt.ts";
import {
	ensureModelProfilesConfig,
	getActiveProfileName,
	listProfiles,
	loadModelProfiles,
	parseModelId,
	profileExists,
	resolveEffortForMode,
	resolveModelForMode,
	type ModelProfilesConfig,
} from "./profiles.ts";

export const PROFILE_EFFORT_LEVELS = new Set([
	"off",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
]);

export interface ProfileWiring {
	getMode: () => PermissionMode;
	onStateChanged: (ctx: ExtensionContext) => void;
	sendList: (text: string) => void;
}

export interface ProfileController {
	readonly active: string | undefined;
	readonly config: ModelProfilesConfig;
	/** mode-switch application: lazy activation + reload re-stamp + model
	 * + optional effort. Never throws; failures notify and keep the model. */
	applyForMode(mode: PermissionMode, ctx: ExtensionContext): Promise<void>;
	setActive(name: string, ctx: ExtensionContext): Promise<void>;
	cycle(ctx: ExtensionContext): Promise<void>;
	initSession(ctx: ExtensionContext): void;
	restoreFromEntry(name: string | undefined): void;
}

export function createProfileController(pi: ExtensionAPI, wiring: ProfileWiring): ProfileController {
	let activeProfile: string | undefined;
	let modelProfileConfig: ModelProfilesConfig = {};

	function notify(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error"): void {
		if (ctx.hasUI) uiNotify(ctx, message, level);
	}

	async function applyForMode(mode: PermissionMode, ctx: ExtensionContext): Promise<void> {
		if (activeProfile === undefined) {
			const cfg = loadModelProfiles();
			if (Object.keys(cfg).length === 0) return;
			const candidate = cfg.active || "default";
			if (!profileExists(cfg, candidate)) return;
			activeProfile = candidate;
			modelProfileConfig = cfg;
		}

		const reloaded = loadModelProfiles();
		modelProfileConfig =
			activeProfile !== undefined && reloaded.active !== activeProfile
				? { ...reloaded, active: activeProfile }
				: reloaded;

		const modelId = resolveModelForMode(modelProfileConfig, mode);
		if (!modelId) return;

		const parsed = parseModelId(modelId);
		if (!parsed) {
			notify(ctx, `Invalid model ID "${modelId}" in profile "${activeProfile}"`, "warning");
			return;
		}

		const model = ctx.modelRegistry.find(parsed.provider, parsed.model);
		if (!model) {
			notify(ctx, `Model "${modelId}" not found in registry`, "warning");
			return;
		}

		const currentModel = ctx.model as { provider?: string; id?: string } | undefined;
		const sameModel =
			!!currentModel &&
			modelIdentityKey(currentModel) ===
				modelIdentityKey({ provider: parsed.provider, id: parsed.model });

		if (!sameModel) {
			const owner = getSharedEffortOwner(pi);
			owner.beginModelSwitch();
			let success: boolean;
			try {
				success = await pi.setModel(model);
			} finally {
				owner.endModelSwitch();
			}
			if (!success) {
				notify(ctx, `No API key available for "${modelId}"`, "warning");
				return;
			}
		}

		const effort = resolveEffortForMode(modelProfileConfig, mode);
		if (!effort) return;
		if (!PROFILE_EFFORT_LEVELS.has(effort)) {
			notify(
				ctx,
				`Unknown effort "${effort}" in profile "${activeProfile}" (expected: ${[...PROFILE_EFFORT_LEVELS].join(", ")})`,
				"warning",
			);
			return;
		}
		const clamp = clampToSupported(effort as EffortLevel, ctx.model ?? null);
		if (clamp && clamp.clamped) {
			notify(
				ctx,
				`Profile "${activeProfile}": effort ${effort} is not supported by ${ctx.model ? String((ctx.model as { id?: string }).id ?? "the model") : "the model"}; clamped to ${clamp.level}`,
				"info",
			);
		}
		getSharedEffortOwner(pi).setFromProfile((clamp ? clamp.level : effort) as OwnerEffortLevel, activeProfile);
	}

	async function setActive(name: string, ctx: ExtensionContext): Promise<void> {
		const config = loadModelProfiles();
		if (!profileExists(config, name)) {
			notify(ctx, `Unknown profile "${name}"`, "error");
			return;
		}
		activeProfile = name;
		modelProfileConfig = config;
		await applyForMode(wiring.getMode(), ctx);
		wiring.onStateChanged(ctx);
		notify(ctx, `Profile "${name}" activated`, "info");
	}

	async function cycle(ctx: ExtensionContext): Promise<void> {
		const config = loadModelProfiles();
		const names = listProfiles(config);
		if (!names.length) {
			notify(ctx, "No profiles found in ~/.pi/agent/model-profiles.json", "warning");
			return;
		}
		const currentName = activeProfile ?? getActiveProfileName(config) ?? names[0]!;
		let i = names.indexOf(currentName);
		if (i < 0) i = -1;
		const next = names[(i + 1) % names.length]!;
		await setActive(next, ctx);
	}

	function initSession(ctx: ExtensionContext): void {
		modelProfileConfig = ensureModelProfilesConfig();

		const profileFlag = pi.getFlag("model-profile");
		if (typeof profileFlag === "string" && profileFlag) {
			const config = loadModelProfiles();
			if (profileExists(config, profileFlag)) {
				activeProfile = profileFlag;
				modelProfileConfig = config;
			} else {
				notify(
					ctx,
					`Unknown profile "${profileFlag}". Available: ${listProfiles(config).join(", ") || "(none)"}`,
					"warning",
				);
			}
		}
	}

	function restoreFromEntry(name: string | undefined): void {
		if (typeof name === "string") activeProfile = name;
	}

	return {
		get active() {
			return activeProfile;
		},
		get config() {
			return modelProfileConfig;
		},
		applyForMode,
		setActive,
		cycle,
		initSession,
		restoreFromEntry,
	};
}

export function registerProfileSurfaces(pi: ExtensionAPI, controller: ProfileController, wiring: ProfileWiring): void {
	pi.registerCommand("model-profile", {
		description:
			"Show or set model profile (named set of per-mode models from ~/.pi/agent/model-profiles.json)",
		handler: async (args, ctx) => {
			const arg = (args ?? "").trim();

			if (!arg) {
				const config = loadModelProfiles();
				const names = listProfiles(config);
				if (!names.length) {
					if (ctx.hasUI)
						uiNotify(ctx, "No profiles found in ~/.pi/agent/model-profiles.json", "warning");
					return;
				}
				if (!ctx.hasUI) return;
				const choice = await ctx.ui.select("Select model profile:", names);
				if (!choice) return;
				await controller.setActive(choice, ctx);
				return;
			}

			if (arg === "list") {
				const config = loadModelProfiles();
				const names = listProfiles(config);
				if (!names.length) {
					if (ctx.hasUI)
						uiNotify(ctx, "No profiles found in ~/.pi/agent/model-profiles.json", "info");
					return;
				}
				const activeName = getActiveProfileName(config);
				const lines = names.map((n) => {
					const p = config[n] as Record<string, string | undefined>;
					const mappings = ["ask", "plan", "auto", "bypass"]
						.map((m) => `${m}:${p[m] || "-"}`)
						.join(" ");
					const active = n === activeName ? " (active)" : "";
					return `${n}${active}: ${mappings}`;
				});
				wiring.sendList(`Model profiles:\n${lines.join("\n")}`);
				return;
			}

			await controller.setActive(arg, ctx);
		},
	});

	pi.registerShortcut("alt+i", {
		description: "Cycle model profile (next profile from ~/.pi/agent/model-profiles.json)",
		handler: async (ctx) => controller.cycle(ctx),
	});

	pi.registerFlag("model-profile", {
		description: "Start with a named model profile from ~/.pi/agent/model-profiles.json",
		type: "string",
	});
}
