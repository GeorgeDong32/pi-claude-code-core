/**
 * goal-settings.ts — the /goal-settings dialog (SPEC SR E13a: split from
 * goal.ts; uses only uiNotify + the goal-auditor config helpers).
 *
 * Spec IDs: goal-auditor config (pi-review-adjacent auditor settings),
 * D-Economy settings surface.
 *
 * Design decisions:
 * - No closure state: the dialog reads/writes the auditor config file
 *   through loadGoalAuditorFileConfig/saveGoalAuditorFileConfig only.
 * - Headless sessions get the config path instead of the dialog.
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { notify as uiNotify } from "../ui/notify.ts";
import {
	goalAuditorConfigPath,
	loadGoalAuditorFileConfig,
	saveGoalAuditorFileConfig,
	type GoalAuditorConfig,
} from "./goal-auditor.ts";

	function auditorConfigValue(config: GoalAuditorConfig, key: keyof GoalAuditorConfig): string {
		const value = config[key];
		return value === undefined ? "(default)" : String(value);
	}

	function auditorSettingsLines(config: GoalAuditorConfig): string[] {
		return [
			`provider: ${auditorConfigValue(config, "provider")}`,
			`model: ${auditorConfigValue(config, "model")}`,
			`thinking_level: ${auditorConfigValue(config, "thinkingLevel")}`,
			`audit_timeout_ms: ${auditorConfigValue(config, "auditTimeoutMs")}`,
		];
	}

	async function handleGoalAuditorSettings(ctx: ExtensionContext): Promise<void> {
		if (!ctx.hasUI) {
			uiNotify(ctx, `Goal auditor settings file: ${goalAuditorConfigPath(ctx.cwd)}`, "info");
			return;
		}
		const fieldLabels = ["provider", "model", "thinking_level"] as const;
		while (true) {
			const config = loadGoalAuditorFileConfig(ctx.cwd);
			const options = [
				`provider: ${auditorConfigValue(config, "provider")}`,
				`model: ${auditorConfigValue(config, "model")}`,
				`thinking_level: ${auditorConfigValue(config, "thinkingLevel")}`,
			];
			const selected = await ctx.ui.select("Goal auditor settings", options);
			if (!selected) return;
			const index = options.indexOf(selected);
			const field = fieldLabels[index];
			if (!field) return;
			const key = field === "thinking_level" ? "thinkingLevel" : field;
			const currentValue = auditorConfigValue(config, key);
			const input = await ctx.ui.input(`Set auditor ${field}`, currentValue === "(default)" ? "Leave empty for default" : currentValue);
			if (input === undefined) continue;
			const next: GoalAuditorConfig = { ...config };
			const trimmed = input.trim();
			if (!trimmed) {
				delete next[key];
			} else if (key === "thinkingLevel") {
				if (!["off", "minimal", "low", "medium", "high", "xhigh"].includes(trimmed)) {
					uiNotify(ctx, "thinking_level must be one of: off, minimal, low, medium, high, xhigh", "warning");
					continue;
				}
				next.thinkingLevel = trimmed as GoalAuditorConfig["thinkingLevel"];
			} else {
				next[key] = trimmed;
			}
			saveGoalAuditorFileConfig(ctx.cwd, next);
			uiNotify(ctx, `Goal auditor settings saved:\n${auditorSettingsLines(loadGoalAuditorFileConfig(ctx.cwd)).join("\n")}`, "info");
		}
	}

	export async function handleGoalSettings(ctx: ExtensionContext): Promise<void> {
		if (!ctx.hasUI) {
			uiNotify(ctx, `Goal settings require UI. Auditor config file: ${goalAuditorConfigPath(ctx.cwd)}`, "warning");
			return;
		}
		const selected = await ctx.ui.select("Goal settings", ["auditor"]);
		if (selected === "auditor") await handleGoalAuditorSettings(ctx);
	}
