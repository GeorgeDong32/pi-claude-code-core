import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
  SEMANTIC_ALIASES,
  USER_LEVELS,
  type EffortLevel,
  type EffortModel,
  cycleLevel,
  decideCycleShortcut,
  getAvailableThinkingLevels,
  clampToSupported,
  getFastMode,
  getUserFacingLevels,
  isEffortAlias,
  parseEffortCommand,
  parseFastCommand,
  resolveEffortLevel,
  resolveMaxLevel,
  resolveMinLevel,
  toThinkingLevel,
  writeFastMode,
} from "./effort.js";
import { getSharedEffortOwner, type ExplicitSource } from "../../lib/effort-owner.js";
import { modelIdentityKey } from "../../lib/model-id.js";
import { coreBus } from "../bus.js";
import { createEffortUi, type EffortUi } from "./ui/index.js";

function modelName(model: EffortModel | null | undefined): string {
  return model?.id ?? "current model";
}

function formatAvailableLevels(model: EffortModel | null | undefined): string {
  return getAvailableThinkingLevels(model).join(", ");
}

// Fast mode may only inject `service_tier` on wire dialects where it is a
// real request field, mirroring pi-ai's own serviceTier → service_tier
// mapping (openai-responses / openai-codex-responses). Other dialects —
// notably anthropic-messages proxies — reject the unknown field or drop it
// in translation. openai-completions is excluded until pi-ai grows a native
// tier mapping for it.
// service_tier is a real request field only in these dialects (mirrors pi-ai's own serviceTier mapping);
// other dialects, notably anthropic-messages proxies such as CPA/CLIProxyAPI, reject or drop the unknown
// field, so fast mode must not inject there.
const SERVICE_TIER_APIS: ReadonlySet<string> = new Set(["openai-responses", "openai-codex-responses"]);

function isFastModelId(modelId: string): boolean {
  return modelId.includes("gpt-5") || modelId.includes("gpt-6");
}

function fastAppliesToModel(model: { id?: string; api?: string } | null | undefined): boolean {
  return (
    model !== null &&
    model !== undefined &&
    typeof model.api === "string" &&
    SERVICE_TIER_APIS.has(model.api) &&
    isFastModelId(model.id ?? "")
  );
}

function applySessionLevel(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  level: EffortLevel,
  fastMode: boolean,
  src: ExplicitSource,
  owner: ReturnType<typeof getSharedEffortOwner>,
  ui: EffortUi
): void {
  const pin = owner.envPin();
  if (pin !== null) {
    ui.notify(ctx, `Effort is pinned by PI_CORE_EFFORT=${pin}; ${level} was not applied`, "warning");
    return;
  }

  const clamp = clampToSupported(level, ctx.model);
  if (clamp === undefined) {
    ui.notify(ctx, `No model resolved; ${level} was not applied`, "error");
    return;
  }
  const levelToApply = clamp.level;
  if (clamp.clamped) {
    ui.notify(
      ctx,
      `Model ${modelName(ctx.model)} does not support ${level}; set to ${levelToApply}. Available: ${formatAvailableLevels(ctx.model)}`,
      "warning"
    );
  }

  const before = pi.getThinkingLevel();
  owner.setExplicit(toThinkingLevel(levelToApply), src);
  const after = pi.getThinkingLevel();
  const appliesNow = ctx.isIdle();
  ui.sync(ctx, after, fastMode, appliesNow);
  const suffix = appliesNow ? "" : " (applies next prompt)";
  ui.notify(ctx, before === after ? `Effort already ${after}` : `Effort changed: ${before} -> ${after}${suffix}`, "info");
}

export default function effortExtension(pi: ExtensionAPI): void {
  const settingsPath = join(getAgentDir(), "settings.json");
  const owner = getSharedEffortOwner(pi);
  const ui = createEffortUi();

  let currentModel: EffortModel | null = null;
  let activeRunEffort: string | undefined;
  let fastMode = getFastMode(settingsPath);
  let lastCtx: ExtensionContext | undefined;
  let switchBaselineKey: string | undefined;

  function rememberModel(model: { provider?: string; id?: string } | null | undefined): void {
    const key = modelIdentityKey(model);
    if (key !== undefined) switchBaselineKey = key;
  }

  function refreshFastMode(): boolean {
    fastMode = getFastMode(settingsPath);
    return fastMode;
  }

  owner.changed(() => {
    if (lastCtx) syncEffortUi(lastCtx);
  });

  function syncEffortUi(ctx: ExtensionContext, current: string = pi.getThinkingLevel(), appliesNow?: boolean): string {
    const applies = appliesNow ?? (typeof ctx.isIdle === "function" ? ctx.isIdle() : true);
    ui.sync(ctx, current, refreshFastMode(), applies);
    coreBus().publish({
      effort: { level: current, source: owner.currentSource() },
    });
    return current;
  }

  pi.registerFlag("effort", {
    description: "Initial thinking effort level (min|max|minimal|low|medium|high|xhigh)",
    type: "string",
  });

  pi.on("before_provider_request", (event, ctx) => {
    if (!fastMode) return undefined;

    if (!fastAppliesToModel(ctx?.model)) return undefined;

    const payload = event.payload;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return undefined;
    }

    const body = payload as Record<string, unknown>;
    const model = typeof body.model === "string" ? body.model : "";
    if (!isFastModelId(model) || body.service_tier !== undefined) {
      return undefined;
    }

    return {
      ...body,
      service_tier: "priority",
    };
  });

  const cycleShortcut = (ctx: ExtensionContext, opts: { includeOff: boolean }): void => {
    const pin = owner.envPin();
    if (pin !== null) {
      ui.notify(ctx, `Effort is pinned by PI_CORE_EFFORT=${pin}`, "warning");
      return;
    }
    const current = pi.getThinkingLevel();
    const decision = decideCycleShortcut(current, ctx.model, opts);
    if (decision.kind === "unavailable") {
      ui.notify(ctx, "Thinking not available for this model", "warning");
      return;
    }
    if (decision.kind === "noop") {
      ui.notify(ctx, `Thinking: ${decision.current} (model supports no other levels)`, "info");
      return;
    }
    owner.setExplicit(toThinkingLevel(decision.next), "shortcut");
    const after = pi.getThinkingLevel();
    const appliesNow = ctx.isIdle();
    ui.sync(ctx, after, refreshFastMode(), appliesNow);
    const suffix = appliesNow ? "" : " (applies next prompt)";
    ui.notify(ctx, `Effort: ${current} -> ${after}${suffix}`, "info");
  };

  pi.registerShortcut("ctrl+shift+e", {
    description: "Cycle effort level",
    handler: (ctx) => cycleShortcut(ctx, { includeOff: false }),
  });

  pi.registerShortcut("alt+t", {
    description: "Cycle thinking level including off",
    handler: (ctx) => cycleShortcut(ctx, { includeOff: true }),
  });

  pi.on("thinking_level_select", (event, ctx) => {
    if (event.level === owner.lastApplied()) return;
    const liveKey = modelIdentityKey(ctx?.model);
    const hostSwitch =
      owner.inModelSwitch() ||
      (switchBaselineKey !== undefined && liveKey !== undefined && liveKey !== switchBaselineKey);
    if (hostSwitch) {
      owner.noteModelSwitchLevel(event.level);
      coreBus().publish({ effort: { level: pi.getThinkingLevel(), source: owner.currentSource() } });
      return;
    }
    const outcome = owner.setExplicit(event.level, "shortcut");
    if (outcome === "pinned-by-env") return;
    coreBus().publish({ effort: { level: pi.getThinkingLevel(), source: owner.currentSource() } });
  });

  pi.on("session_start", (_event, ctx) => {
    currentModel = ctx.model ?? null;
    rememberModel(ctx.model);
    lastCtx = ctx;
    owner.setFromEnv(process.env.PI_CORE_EFFORT ?? "");
    syncEffortUi(ctx);

    const flagValue = pi.getFlag("effort");
    if (typeof flagValue === "string" && flagValue) {
      const requested = flagValue.trim();
      const isKnownRequest = USER_LEVELS.includes(requested as any) || isEffortAlias(requested);
      if (!isKnownRequest) {
        ui.notify(ctx, `--effort ${flagValue}: unknown effort level`, "warning");
        return;
      }

      const resolved = resolveEffortLevel(requested as EffortLevel | "min" | "max", ctx.model);
      if (!resolved) {
        ui.notify(ctx, `--effort ${flagValue}: thinking not available for ${modelName(ctx.model)}`, "warning");
        return;
      }

      const clamp = clampToSupported(resolved, ctx.model);
      if (clamp === undefined) {
        ui.notify(ctx, `--effort ${flagValue}: no model resolved; not applied`, "warning");
        return;
      }
      const clampedResolved = clamp.level;

      const outcome = owner.setExplicit(toThinkingLevel(clampedResolved), "command");
      if (clamp.clamped && outcome !== "pinned-by-env") {
        ui.notify(
          ctx,
          `--effort ${flagValue}: ${resolved} not supported by ${modelName(ctx.model)}; set to ${clamp.level}. Available: ${formatAvailableLevels(ctx.model)}`,
          "warning"
        );
      }
      if (outcome === "pinned-by-env") {
        ui.notify(ctx, 
          `Effort is pinned by PI_CORE_EFFORT=${owner.envPin()}; --effort ${flagValue} was not applied`,
          "warning"
        );
      }
      syncEffortUi(ctx);
    }
  });

  pi.on("model_select", (event, ctx) => {
    const previousKey = switchBaselineKey;
    const nextKey = modelIdentityKey(event.model);
    currentModel = event.model;
    if (!owner.inModelSwitch() && previousKey !== undefined && nextKey !== undefined && nextKey !== previousKey) {
      owner.afterHostModelSwitch();
    }
    if (nextKey !== undefined) switchBaselineKey = nextKey;
    const visibleEffort = ctx.isIdle() ? pi.getThinkingLevel() : activeRunEffort ?? pi.getThinkingLevel();
    syncEffortUi(ctx, visibleEffort);
  });

  pi.on("agent_start", (_event, ctx) => {
    currentModel = ctx.model ?? currentModel;
    rememberModel(ctx.model);
    activeRunEffort = pi.getThinkingLevel();
    syncEffortUi(ctx, activeRunEffort);
  });

  pi.on("turn_start", (_event, ctx) => {
    currentModel = ctx.model ?? currentModel;
    rememberModel(ctx.model);
    activeRunEffort ??= pi.getThinkingLevel();
    syncEffortUi(ctx, activeRunEffort);
  });

  pi.on("agent_end", (_event, ctx) => {
    activeRunEffort = undefined;
    syncEffortUi(ctx);
  });

  function setFastMode(ctx: ExtensionContext, enabled: boolean): void {
    try {
      writeFastMode(settingsPath, enabled);
    } catch (error) {
      ui.notify(ctx, `Failed to update fast mode: ${error instanceof Error ? error.message : String(error)}`, "error");
      return;
    }
    fastMode = enabled;
    syncEffortUi(ctx);
    const noOp = enabled && ctx.model && !fastAppliesToModel(ctx.model);
    const note = noOp ? ` (no effect on ${modelName(ctx.model)}: priority tier needs a GPT-5 model on an OpenAI Responses/Codex API)` : "";
    ui.notify(ctx, `Fast mode ${fastMode ? "enabled" : "disabled"}.${note}`, "info");
  }

  async function showEffortPicker(ctx: ExtensionCommandContext): Promise<void> {
    const allLevels = getUserFacingLevels(ctx.model);
    const levels = allLevels.filter((l) => l !== "minimal");
    if (levels.length === 0) {
      ui.notify(ctx, `Thinking not available for ${modelName(ctx.model)}`, "error");
      return;
    }

    const currentLevel = pi.getThinkingLevel();
    const current: string = currentLevel;
    const seededCurrent: string | undefined = (() => {
      if ((levels as string[]).includes(current)) return current;
      const idx = (allLevels as string[]).indexOf(current);
      if (idx >= 0) return levels[Math.min(levels.length - 1, idx)];
      return current;
    })();

    const result = await ui.pickEffort(ctx, levels, seededCurrent);
    if (result && result.level) {
      applySessionLevel(pi, ctx, result.level as EffortLevel, refreshFastMode(), "picker", owner, ui);
    } else {
      ui.notify(ctx, "Cancelled", "info");
    }
  }

  pi.registerCommand("effort", {
    description: "Set thinking effort (min/max adapt per model)",
    getArgumentCompletions: (prefix) => {
      const value = prefix.trimStart();
      const tokens = value.split(/\s+/).filter(Boolean);
      const trailingSpace = /\s$/.test(value);

      const modelLevels = getUserFacingLevels(currentModel);
      const options = modelLevels.length > 0 ? ["min", ...modelLevels, "max"] : [];

      if (tokens.length === 0) {
        return options.map((t) => ({ value: t, label: t }));
      }

      if (tokens.length === 1 && !trailingSpace) {
        return options
          .filter((t) => t.startsWith(tokens[0]))
          .map((t) => ({ value: t, label: t }));
      }

      return null;
    },
    handler: async (args, ctx) => {
      if (args.trim().length === 0) {
        await showEffortPicker(ctx);
        return;
      }

      let command;
      try {
        command = parseEffortCommand(args);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ui.notify(ctx, message, "error");
        return;
      }

      switch (command.kind) {
        case "reset":
          owner.resetExplicit();
          ui.notify(ctx, 
            `Effort reset (control returns to profile/model default; currently ${pi.getThinkingLevel()})`,
            "info"
          );
          syncEffortUi(ctx);
          return;

        case "set-session":
          applySessionLevel(pi, ctx, command.level, refreshFastMode(), "command", owner, ui);
          return;

        case "set-min": {
          const resolved = resolveMinLevel(ctx.model);
          if (!resolved) {
            ui.notify(ctx, `Thinking not available for ${modelName(ctx.model)}`, "error");
            return;
          }
          applySessionLevel(pi, ctx, resolved, refreshFastMode(), "command", owner, ui);
          return;
        }

        case "set-max": {
          const resolved = resolveMaxLevel(ctx.model);
          if (!resolved) {
            ui.notify(ctx, `Thinking not available for ${modelName(ctx.model)}`, "error");
            return;
          }
          applySessionLevel(pi, ctx, resolved, refreshFastMode(), "command", owner, ui);
          return;
        }
      }
    },
  });

  pi.registerCommand("fast", {
    description: "Set fast mode",
    getArgumentCompletions: (prefix) => {
      const value = prefix.trimStart();
      const tokens = value.split(/\s+/).filter(Boolean);
      const trailingSpace = /\s$/.test(value);
      const firstPrefix = trailingSpace ? "" : tokens[0] ?? "";
      const options = ["on", "off"];

      if (tokens.length === 0 || (tokens.length === 1 && !trailingSpace)) {
        return options
          .filter((t) => t.startsWith(firstPrefix))
          .map((t) => ({ value: t, label: t }));
      }

      return null;
    },
    handler: async (args, ctx) => {
      let command;
      try {
        command = parseFastCommand(args);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ui.notify(ctx, message, "error");
        return;
      }

      const enabled = command.kind === "fast-toggle" ? !refreshFastMode() : command.enabled;
      setFastMode(ctx, enabled);
    },
  });
}
