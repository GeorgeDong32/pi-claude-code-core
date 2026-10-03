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
import { coreBus } from "../bus.js";
import { createEffortUi, type EffortUi } from "./ui/index.js";

function modelName(model: EffortModel | null | undefined): string {
  return model?.id ?? "current model";
}

function formatAvailableLevels(model: EffortModel | null | undefined): string {
  return getAvailableThinkingLevels(model).join(", ");
}

function isFastModelId(modelId: string): boolean {
  return modelId.startsWith("gpt-5");
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
  // ① env pin refuses explicit writes (P1-EF-06 c)
  const pin = owner.envPin();
  if (pin !== null) {
    ui.notify(ctx, `Effort is pinned by PI_CORE_EFFORT=${pin}; ${level} was not applied`, "warning");
    return;
  }

  const available = getAvailableThinkingLevels(ctx.model);
  if (!available.includes(level)) {
    ui.notify(
      ctx,
      `Model ${modelName(ctx.model)} does not support ${level}. Available: ${formatAvailableLevels(ctx.model)}`,
      "error"
    );
    return;
  }

  const before = pi.getThinkingLevel();
  owner.setExplicit(toThinkingLevel(level), src);
  const after = pi.getThinkingLevel();
  const appliesNow = ctx.isIdle();
  ui.sync(ctx, after, fastMode, appliesNow);
  const suffix = appliesNow ? "" : " (applies next prompt)";
  ui.notify(ctx, before === after ? `Effort already ${after}` : `Effort changed: ${before} -> ${after}${suffix}`, "info");
}

export default function effortExtension(pi: ExtensionAPI): void {
  const settingsPath = join(getAgentDir(), "settings.json");
  // thinking-level ownership chain (P1-EF-05): every write below arbitrates
  // through this owner; modes' profile application shares the same instance.
  const owner = getSharedEffortOwner(pi);
  // DC2: single presentation wrapper — business code below never touches
  // ctx.ui directly (fakeable via EffortCtxLike).
  const ui = createEffortUi();

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

  function syncEffortUi(ctx: ExtensionContext, current: string = pi.getThinkingLevel(), appliesNow?: boolean): string {
    // C6: honor the caller's appliesNow; default to the idle probe so a
    // changed() callback during a run no longer refreshes the working
    // message as if it applied immediately. Fake hosts without isIdle
    // (contract tests) fall back to the old true behavior.
    const applies = appliesNow ?? (typeof ctx.isIdle === "function" ? ctx.isIdle() : true);
    ui.sync(ctx, current, refreshFastMode(), applies);
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

  // ─── Keyboard shortcuts: Ctrl+Shift+E / Alt+T to cycle effort ──────
  // C5 (arch review): ONE shared handler. alt+t moved here from the modes
  // module (its old hardcoded table + write-probe loop pinned clamped values
  // into the explicit slot on single-level models); ctrl+shift+e gains the
  // same zero-write guard. Decision logic is pure in effort.ts
  // (decideCycleShortcut) — "noop" notifies and never calls setExplicit.
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

  // ─── External thinking changes: adopt pi's thinking_level_select (EFF-01)
  // Covers pi's own thinking.cycle keybinding (shift+tab by default, alt+e on
  // this machine) and any other writer calling setThinkingLevel outside core.
  // Guard on owner.lastApplied(): the owner's own writes also emit this event,
  // and pi updates state before emitting, so comparing against
  // pi.getThinkingLevel() would false-skip exactly the no-slot case.
  pi.on("thinking_level_select", (event) => {
    if (event.level === owner.lastApplied()) return;
    const outcome = owner.setExplicit(event.level, "shortcut");
    if (outcome === "pinned-by-env") return;
    // No ctx here: bus sync only; the footer chip reads pi.getThinkingLevel().
    coreBus().publish({ effort: { level: pi.getThinkingLevel(), source: owner.currentSource() } });
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
        ui.notify(ctx, `--effort ${flagValue}: unknown effort level`, "warning");
        return;
      }

      const resolved = resolveEffortLevel(requested as EffortLevel | "min" | "max", ctx.model);
      if (!resolved) {
        ui.notify(ctx, `--effort ${flagValue}: thinking not available for ${modelName(ctx.model)}`, "warning");
        return;
      }

      const available = getAvailableThinkingLevels(ctx.model);
      if (!available.includes(resolved)) {
        ui.notify(ctx, 
          `--effort ${flagValue}: not supported by ${modelName(ctx.model)}. Available: ${formatAvailableLevels(ctx.model)}`,
          "warning"
        );
        return;
      }

      // --effort flag = manual intent at startup (② via "command")
      const outcome = owner.setExplicit(toThinkingLevel(resolved), "command");
      if (outcome === "pinned-by-env") {
        // P1-EF-06 c) parity with the command/picker paths: being silently
        // swallowed under an env pin is the one UX gap they don't have
        ui.notify(ctx, 
          `Effort is pinned by PI_CORE_EFFORT=${owner.envPin()}; --effort ${flagValue} was not applied`,
          "warning"
        );
      }
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
      ui.notify(ctx, `Failed to update fast mode: ${error instanceof Error ? error.message : String(error)}`, "error");
      return;
    }
    fastMode = enabled;
    syncEffortUi(ctx);
    ui.notify(ctx, `Fast mode ${fastMode ? "enabled" : "disabled"}.`, "info");
  }

  // ─── Picker overlay for bare /effort ──────────────────────────────
  // Business half stays here (level curation + seeding + apply); the
  // presentation half (overlay vs select fallback) lives in effort/ui.
  async function showEffortPicker(ctx: ExtensionCommandContext): Promise<void> {
    // Picker surfaces a curated subset: low/medium/high plus xhigh when the
    // model supports it. "minimal" stays available via /effort minimal for
    // power users but is hidden in the picker to keep the slider compact.
    const allLevels = getUserFacingLevels(ctx.model);
    const levels = allLevels.filter((l) => l !== "minimal");
    if (levels.length === 0) {
      ui.notify(ctx, `Thinking not available for ${modelName(ctx.model)}`, "error");
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

    const result = await ui.pickEffort(ctx, levels, seededCurrent);
    if (result && result.level) {
      applySessionLevel(pi, ctx, result.level as EffortLevel, refreshFastMode(), "picker", owner, ui);
    } else {
      ui.notify(ctx, "Cancelled", "info");
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
        ui.notify(ctx, message, "error");
        return;
      }

      switch (command.kind) {
        case "reset":
          owner.resetExplicit();
          ui.notify(ctx, 
            // no env/profile applies afterwards: the pi level stays at its
            // last value until the next profile/model event — say that
            // instead of naming a source that isn't actively driving it
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
