import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
  SEMANTIC_ALIASES,
  USER_LEVELS,
  type EffortLevel,
  type EffortModel,
  cycleLevel,
  getAvailableThinkingLevels,
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
import { createEffortPickerComponent, type EffortPickerResult } from "./effort-picker.js";
import { getSharedEffortOwner, type ExplicitSource } from "../../lib/effort-owner.js";
import { showComponentOverlay } from "../../lib/overlay.js";
import { coreBus } from "../bus.js";

function modelName(model: EffortModel | null | undefined): string {
  return model?.id ?? "current model";
}

function formatAvailableLevels(model: EffortModel | null | undefined): string {
  return getAvailableThinkingLevels(model).join(", ");
}

function isFastModelId(modelId: string): boolean {
  return modelId.startsWith("gpt-5");
}

function isFastModeApplicable(model: EffortModel | null | undefined): boolean {
  return typeof model?.id === "string" && isFastModelId(model.id);
}

function requestEffortRender(ctx: ExtensionContext): void {
  // Clear older pi-effort aggregate status lines. Dedicated powerline custom
  // items read pi-effort-thinking / pi-effort-fast instead.
  ctx.ui.setStatus("effort", undefined);
}

function updateEffortUi(ctx: ExtensionContext, current: string, fastMode: boolean, updateWorkingMessage = true): void {
  requestEffortRender(ctx);
  ctx.ui.setStatus("pi-effort-thinking", `think:${current}`);
  ctx.ui.setStatus("pi-effort-fast", fastMode && isFastModeApplicable(ctx.model) ? "fast" : undefined);
  if (updateWorkingMessage) {
    ctx.ui.setWorkingMessage(current === "off" ? undefined : `Working (${current} effort)...`);
  }
}

function applySessionLevel(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  level: EffortLevel,
  fastMode: boolean,
  src: ExplicitSource,
  owner: ReturnType<typeof getSharedEffortOwner>
): void {
  // ① env pin refuses explicit writes (P1-EF-06 c)
  const pin = owner.envPin();
  if (pin !== null) {
    ctx.ui.notify(
      `Effort is pinned by PI_CORE_EFFORT=${pin}; ${level} was not applied`,
      "warning"
    );
    return;
  }

  const available = getAvailableThinkingLevels(ctx.model);
  if (!available.includes(level)) {
    ctx.ui.notify(
      `Model ${modelName(ctx.model)} does not support ${level}. Available: ${formatAvailableLevels(ctx.model)}`,
      "error"
    );
    return;
  }

  const before = pi.getThinkingLevel();
  owner.setExplicit(toThinkingLevel(level), src);
  const after = pi.getThinkingLevel();
  const appliesNow = ctx.isIdle();
  updateEffortUi(ctx, after, fastMode, appliesNow);
  const suffix = appliesNow ? "" : " (applies next prompt)";
  ctx.ui.notify(before === after ? `Effort already ${after}` : `Effort changed: ${before} -> ${after}${suffix}`, "info");
}

export default function effortExtension(pi: ExtensionAPI): void {
  const settingsPath = join(getAgentDir(), "settings.json");
  // thinking-level ownership chain (P1-EF-05): every write below arbitrates
  // through this owner; modes' profile application shares the same instance.
  const owner = getSharedEffortOwner(pi);

  // ─── Closure: track current model for tab completion ─────────────
  let currentModel: EffortModel | null = null;
  let activeRunEffort: string | undefined;
  let fastMode = getFastMode(settingsPath);
  // Last seen context, so owner.changed() can refresh status slots even when
  // the change originated in the modes module (profile application, D5).
  let lastCtx: ExtensionContext | undefined;

  function refreshFastMode(): boolean {
    fastMode = getFastMode(settingsPath);
    return fastMode;
  }

  // Cross-module integration (D5): a profile-driven write from the modes
  // module refreshes effort's status slots through the same path.
  owner.changed(() => {
    if (lastCtx) syncEffortUi(lastCtx);
  });

  function syncEffortUi(ctx: ExtensionContext, current: string = pi.getThinkingLevel()): string {
    updateEffortUi(ctx, current, refreshFastMode());
    coreBus().publish({
      effort: { level: current, source: owner.currentSource() },
    });
    return current;
  }

  // ─── CLI flag ────────────────────────────────────────────────────
  pi.registerFlag("effort", {
    description: "Initial thinking effort level (min|max|minimal|low|medium|high|xhigh)",
    type: "string",
  });

  // ─── Provider hook: fast mode maps to OpenAI/Codex priority tier ──
  pi.on("before_provider_request", (event) => {
    if (!fastMode) return undefined;

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

  // ─── Keyboard shortcut: Ctrl+Shift+E to cycle effort ─────────────
  pi.registerShortcut("ctrl+shift+e", {
    description: "Cycle effort level",
    handler: (ctx) => {
      const pin = owner.envPin();
      if (pin !== null) {
        ctx.ui.notify(`Effort is pinned by PI_CORE_EFFORT=${pin}`, "warning");
        return;
      }
      const current = pi.getThinkingLevel();
      const next = cycleLevel(current, ctx.model);
      if (!next) {
        ctx.ui.notify("Thinking not available for this model", "warning");
        return;
      }
      owner.setExplicit(toThinkingLevel(next), "shortcut");
      const after = pi.getThinkingLevel();
      const appliesNow = ctx.isIdle();
      updateEffortUi(ctx, after, refreshFastMode(), appliesNow);
      const suffix = appliesNow ? "" : " (applies next prompt)";
      ctx.ui.notify(`Effort: ${current} -> ${after}${suffix}`, "info");
    },
  });

  // ─── session_start: env pin + sync UI + apply --effort flag ──────
  pi.on("session_start", (_event, ctx) => {
    // Track model for tab completion
    currentModel = ctx.model ?? null;
    lastCtx = ctx;
    // ① PI_CORE_EFFORT is read once at startup (P1-EF-05)
    owner.setFromEnv(process.env.PI_CORE_EFFORT ?? "");
    // Sync current effort labels
    syncEffortUi(ctx);

    // Apply --effort CLI flag if present
    const flagValue = pi.getFlag("effort");
    if (typeof flagValue === "string" && flagValue) {
      const requested = flagValue.trim();
      const isKnownRequest = USER_LEVELS.includes(requested as any) || isEffortAlias(requested);
      if (!isKnownRequest) {
        ctx.ui.notify(`--effort ${flagValue}: unknown effort level`, "warning");
        return;
      }

      const resolved = resolveEffortLevel(requested as EffortLevel | "min" | "max", ctx.model);
      if (!resolved) {
        ctx.ui.notify(`--effort ${flagValue}: thinking not available for ${modelName(ctx.model)}`, "warning");
        return;
      }

      const available = getAvailableThinkingLevels(ctx.model);
      if (!available.includes(resolved)) {
        ctx.ui.notify(
          `--effort ${flagValue}: not supported by ${modelName(ctx.model)}. Available: ${formatAvailableLevels(ctx.model)}`,
          "warning"
        );
        return;
      }

      // --effort flag = manual intent at startup (② via "command")
      owner.setExplicit(toThinkingLevel(resolved), "command");
      syncEffortUi(ctx);
    }
  });

  // ─── model_select: sync visible effort UI ────────────────────────
  pi.on("model_select", (event, ctx) => {
    currentModel = event.model;
    const visibleEffort = ctx.isIdle() ? pi.getThinkingLevel() : activeRunEffort ?? pi.getThinkingLevel();
    syncEffortUi(ctx, visibleEffort);
  });

  // Keep labels fresh if the user changes thinking through Pi's native UI.
  // During an active run, keep the loader tied to the run-start effort so a
  // mid-stream change is not misrepresented as affecting in-flight requests.
  pi.on("agent_start", (_event, ctx) => {
    currentModel = ctx.model ?? currentModel;
    activeRunEffort = pi.getThinkingLevel();
    syncEffortUi(ctx, activeRunEffort);
  });

  pi.on("turn_start", (_event, ctx) => {
    currentModel = ctx.model ?? currentModel;
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
      ctx.ui.notify(`Failed to update fast mode: ${error instanceof Error ? error.message : String(error)}`, "error");
      return;
    }
    fastMode = enabled;
    syncEffortUi(ctx);
    ctx.ui.notify(`Fast mode ${fastMode ? "enabled" : "disabled"}.`, "info");
  }

  // ─── Picker overlay for bare /effort ──────────────────────────────
  // Shows the interactive effort selector and applies the user's choice via
  // the same applySessionLevel path used by /effort <level>. Falls back to
  // ctx.ui.select when the runtime is not in TUI mode (RPC/print).
  async function showEffortPicker(ctx: ExtensionCommandContext): Promise<void> {
    // Picker surfaces a curated subset: low/medium/high plus xhigh when the
    // model supports it. "minimal" stays available via /effort minimal for
    // power users but is hidden in the picker to keep the slider compact.
    const allLevels = getUserFacingLevels(ctx.model);
    const levels = allLevels.filter((l) => l !== "minimal");
    if (levels.length === 0) {
      ctx.ui.notify(`Thinking not available for ${modelName(ctx.model)}`, "error");
      return;
    }

    if (!ctx.hasUI) {
      const picked = await ctx.ui.select("Effort", levels);
      if (picked && (levels as string[]).includes(picked)) {
        applySessionLevel(pi, ctx, picked as EffortLevel, refreshFastMode(), "picker", owner);
      }
      return;
    }

    const currentLevel = pi.getThinkingLevel();
    // Map a current level that isn't in the picker (e.g. "minimal") to the
    // nearest visible level so the initial cursor lands somewhere sensible.
    // Cast through string to bridge Pi's ThinkingLevel (includes "minimal")
    // and our narrower EffortLevel used by the picker list.
    const current: string = currentLevel;
    const seededCurrent: string | undefined = (() => {
      if ((levels as string[]).includes(current)) return current;
      const idx = (allLevels as string[]).indexOf(current);
      if (idx >= 0) return levels[Math.min(levels.length - 1, idx)];
      return current;
    })();

    // Shared overlay plumbing (P0-LB-03 / P1-EF-02): same custom call and
    // geometry as before; the picker component is unchanged.
    const result = await showComponentOverlay<EffortPickerResult>(ctx, {
      component: (_tui, theme, _kb, done) =>
        createEffortPickerComponent({
          levels,
          currentLevel: seededCurrent,
          theme: theme as Theme | undefined,
          done,
        }),
      overlayOptions: {
        // Pi's main region can be as narrow as ~50 columns when a side
        // panel (extensions, model list, etc.) is open. Using a fixed
        // minWidth that exceeds the typical side-panel width ensures the
        // overlay extends beyond the side panel rather than getting
        // squeezed into the main region.
        width: 78,
        minWidth: 72,
        maxHeight: "40%",
        anchor: "center",
      },
    });

    if (result.action === "confirm" && result.level) {
      applySessionLevel(pi, ctx, result.level as EffortLevel, refreshFastMode(), "picker", owner);
    } else {
      ctx.ui.notify("Cancelled", "info");
    }
  }

  // ─── /effort command ─────────────────────────────────────────────
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
      // Bare /effort → open the interactive picker. Keep the parameter path
      // for fast/known-value entry; only the no-arg form pops the overlay.
      if (args.trim().length === 0) {
        await showEffortPicker(ctx);
        return;
      }

      let command;
      try {
        command = parseEffortCommand(args);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(message, "error");
        return;
      }

      switch (command.kind) {
        case "reset":
          owner.resetExplicit();
          ctx.ui.notify(
            `Effort reset (now ${owner.currentSource()}: ${pi.getThinkingLevel()})`,
            "info"
          );
          syncEffortUi(ctx);
          return;

        case "set-session":
          applySessionLevel(pi, ctx, command.level, refreshFastMode(), "command", owner);
          return;

        case "set-min": {
          const resolved = resolveMinLevel(ctx.model);
          if (!resolved) {
            ctx.ui.notify(`Thinking not available for ${modelName(ctx.model)}`, "error");
            return;
          }
          applySessionLevel(pi, ctx, resolved, refreshFastMode(), "command", owner);
          return;
        }

        case "set-max": {
          const resolved = resolveMaxLevel(ctx.model);
          if (!resolved) {
            ctx.ui.notify(`Thinking not available for ${modelName(ctx.model)}`, "error");
            return;
          }
          applySessionLevel(pi, ctx, resolved, refreshFastMode(), "command", owner);
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
        ctx.ui.notify(message, "error");
        return;
      }

      const enabled = command.kind === "fast-toggle" ? !refreshFastMode() : command.enabled;
      setFastMode(ctx, enabled);
    },
  });
}
