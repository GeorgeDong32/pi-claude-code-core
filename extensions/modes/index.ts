
import {
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { MODE_META, modeMetaData } from "./ui/meta.ts";
import { clearModesStatus, installModesFooter, shortenPath } from "./ui/footer.ts";
import { notify as uiNotify } from "../ui/notify.ts";
const sharedNotify = uiNotify;
import { createFallbackAdapter } from "../ui/fallback.ts";
import { coreBus, type CoreSnapshot } from "../bus.ts"
import { clearSessionGrants, clearSessionState, listSessionGrants, setBypassIndicator } from "./rule-families.ts"
import { registerCompactionSubscriber } from "../../lib/compaction-seam.ts";


import {
  loadPermissionModesConfig,
  resolveAutoModeConfig,
  resolveClassifierConfig,
} from "./config.ts";
import { invalidateClassifierVerdictCache } from "./classifier-client.ts";
import { boundedRecoveryPolicy, classifyLengthStop } from "../../lib/truncation-verdict.ts";
import { createStatsPresenter } from "./stats-presenter.ts";
import { createAutoEngine } from "./auto-engine.ts";
import { checkBatchDup, createParentLoopBreaker, indexBatchDupes, parentLoopKey, type BatchDupIndex } from "./loop-guard.ts";
import {
  restoreDangerousPermissionRules,
  stripDangerousPermissionRules,
} from "./dangerous-permissions.ts";

import {
  buildInjectionWarningBlock,
  scanBranchForInjectionSignals,
  TOOL_OUTPUT_INJECTION_WARNING,
} from "./injection-probe.ts";
import {
  readBranchMessages,
  readCustomEntryData,
  readGitBranch,
  readSessionId,
} from "./session-branch.ts";
import {
  accumulateBranchStats,
  emptyBranchStatsState,
} from "./branch-stats.ts";
import { loadMergedPermissionRules } from "./permissions-loader.ts";
import { planCcImport, executeCcImport, formatCcImportReport } from "./cc-import.ts";
import {
  formatMergedRulesForDisplay,
  type PermissionRule,
} from "./permissions.ts";
import { PermissionMode, PlanPhase, filterSkillsFromPrompt, injectModePrompt, resolveModePrompt } from "./mode-prompt.ts";
import {
	createPermissionAdjudicator,
	type ToolCallRequest,
} from "./adjudicate.ts";
import { interpretDecision } from "./interpret.ts";
import { trackOutsideWrite } from "./outside-writes.ts";
import { pathToolMatchesRuleContent } from "./path-permission-match.ts";
import { createAdjudicationFacts } from "./adjudication-facts.ts";
import { createApprovalFlow, type Block } from "./approval-flow.ts";
import { createForwardingResponder } from "./forwarding-responder.ts";
import { registerOutsideWritesCommands } from "./outside-writes-commands.ts";
import { TodoItem, assistantMessageText, ensurePlanFile, isAssistantMessage } from "./plan.ts";
import { createPlanSession, registerPlanSurfaces } from "./plan-session.ts";
import {
  applyInheritedModeForChild,
  publishInheritedPermissionMode,
} from "./mode-inherit.ts";
import { resolveSkillFilter } from "./profiles.ts";
import { createProfileController, registerProfileSurfaces } from "./profile-apply.ts";

type Mode = PermissionMode;

const MODE_CYCLE: Mode[] = ["ask", "plan", "auto", "bypass"];



export interface PmCapability {
	version: number;
	active: boolean;
	mode: string;
	workingStats: string | null;
	usage?: CoreSnapshot["modes"]["usage"] | null;
}

let unregisterModesSeam: (() => void) | undefined;

export default function permissionModesExtension(pi: ExtensionAPI): void {
  let fallbackAdapter = createFallbackAdapter({ hasUI: false, setWorkingMessage: () => {}, theme: { fg: (_r, s) => s } });
  let currentMode: Mode = "ask";
  let needsAskReminder = false;
  let needsBypassSecurityReminder = false;
  let pendingComplianceInject = false;
  let complianceCategory = "";
  let classifierConfig = resolveClassifierConfig(loadPermissionModesConfig());
  let autoModeConfig = resolveAutoModeConfig(loadPermissionModesConfig());
  let basePermissionRules: PermissionRule[] = [];
  let strippedDangerousRules: PermissionRule[] = [];
  let mergedPermissionRules: PermissionRule[] = [];
  let batchDupIndex: BatchDupIndex | null = null;
  const parentLoopBreaker = createParentLoopBreaker();

  const approval = createApprovalFlow({
    reloadRules: reloadMergedPermissionRules,
    setMode,
    getAutoEngine: () => autoEngine,
    setCompliance: (inject, category) => {
      pendingComplianceInject = inject;
      complianceCategory = category;
    },
  });

  const facts = createAdjudicationFacts({
    getAllTools: () => pi.getAllTools?.() ?? [],
    getMode: () => currentMode,
    getMergedRules: () => mergedPermissionRules,
    getAutoModeConfig: () => autoModeConfig,
    describeTier3Review: (tool, input, cwd) =>
      autoEngine.describeTier3Review(tool, input, cwd),
    isMemoryDirWrite: approval.isMemoryDirWrite,
  });

  const forwarding = createForwardingResponder({
    applyApprovalDecision: approval.applyApprovalDecision,
  });

  const plan = createPlanSession({
    pi,
    getMode: () => currentMode,
    setModeRaw: (mode) => {
      currentMode = mode;
    },
    persistState,
    applyProfileForMode: (mode, ctx) => profiles.applyForMode(mode, ctx),
  });

  const autoEngine = createAutoEngine({
    getClassifierConfig: () => classifierConfig,
    getAutoModeConfig: () => autoModeConfig,
    getMode: () => currentMode,
    getFusionSchemaHint: (toolName) => facts.fusionSchemaHint(toolName),
    promptWithPermissionOptions: (...args) =>
      approval.promptWithPermissionOptions(...args),
    uiNotify,
    trackOutsideWrite,
  });

  function applyAutoModePermissionStrip(): void {
    if (currentMode === "auto") {
      const stripped = stripDangerousPermissionRules(basePermissionRules);
      strippedDangerousRules = stripped.stashed;
      mergedPermissionRules = stripped.active;
    } else {
      strippedDangerousRules = [];
      mergedPermissionRules = basePermissionRules;
    }
  }

  function reloadMergedPermissionRules(cwd: string): void {
    basePermissionRules = loadMergedPermissionRules(cwd);
    applyAutoModePermissionStrip();
    invalidateClassifierVerdictCache();
  }


  const profileWiring = {
    getMode: () => currentMode,
    onStateChanged: (ctx: ExtensionContext) => {
      clearModesStatus(ctx);
      persistState();
    },
    sendList: (text: string) => {
      pi.sendMessage(
        { customType: "model-profile-list", content: text, display: true,
          details: { command: "/model-profile list" } },
        { triggerTurn: false },
      );
    },
  };
  const profiles = createProfileController(pi, profileWiring);
  registerProfileSurfaces(pi, profiles, profileWiring);

  let gitBranch = "";


  function persistState(): void {
    pi.appendEntry("modes", {
      currentMode,
      activeProfile: profiles.active,
      ...plan.entryFields(),
    });
  }



  function applyToolRestrictions(): void {
    plan.applyToolRestrictions();
  }

  let setModeGeneration = 0;
  let modeSwitchTail: Promise<void> = Promise.resolve();

  async function setMode(mode: Mode, ctx: ExtensionContext): Promise<void> {
    const gen = ++setModeGeneration;
    const prev = currentMode;

    if (prev === "auto" && mode !== "auto" && strippedDangerousRules.length) {
      basePermissionRules = restoreDangerousPermissionRules(
        mergedPermissionRules,
        strippedDangerousRules,
      );
      strippedDangerousRules = [];
    }

    currentMode = mode;
    needsAskReminder = mode === "ask";
    needsBypassSecurityReminder = mode === "bypass";
    pendingComplianceInject = false;
    complianceCategory = "";
    plan.resetOnModeSwitch(mode, ctx);

    if (mode === "auto") {
      autoEngine.resetDenialState();
      applyAutoModePermissionStrip();
    } else if (prev === "auto") {
      applyAutoModePermissionStrip();
    }

    applyToolRestrictions();
    clearModesStatus(ctx);
    setBypassIndicator(mode === "bypass");
    if (gen !== setModeGeneration) return;

    const run = modeSwitchTail.then(async () => {
      if (gen !== setModeGeneration) return;
      if (mode === "plan") plan.onPlanModeSettled(prev, ctx.cwd);
      await profiles.applyForMode(mode, ctx);
      if (gen !== setModeGeneration) return;
      persistState();
      publishInheritedPermissionMode(mode);
      publishCapability({ mode });
    });
    modeSwitchTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  function cycleMode(ctx: ExtensionContext): void {
    const idx = MODE_CYCLE.indexOf(currentMode);
    void setMode(MODE_CYCLE[(idx + 1) % MODE_CYCLE.length], ctx).catch(
      (err: unknown) => {
        uiNotify(
          ctx,
          `Mode switch failed: ${err instanceof Error ? err.message : String(err)}`,
          "error",
        );
      },
    );
    if (ctx.hasUI) uiNotify(ctx, `Mode: ${MODE_META[currentMode].label}`);
  }

  const statsPresenter = createStatsPresenter({
    getFallbackAdapter: () => fallbackAdapter,
    publishCapability,
  });
  const { refreshWorkingMessage } = statsPresenter;
  function publishCapability(patch: Partial<PmCapability>): void {
    const prev = coreBus().snapshot().modes;
    coreBus().publish({
      modes: {
        mode: (patch.mode ?? prev.mode) as "ask" | "plan" | "auto" | "bypass" | "",
        planPhase: (patch as { planPhase?: PlanPhase }).planPhase ?? prev.planPhase ?? plan.phase,
        workingStats:
          patch.workingStats !== undefined ? patch.workingStats : prev.workingStats,
        usage: "usage" in patch ? (patch.usage ?? undefined) : prev.usage,
        meta: prev.meta ?? modeMetaData(),
      },
    });
  }



  for (const mode of ["ask", "plan", "auto", "bypass"] as Mode[]) {
    pi.registerCommand(mode, {
      description: `Switch to ${MODE_META[mode].label} mode`,
      handler: async (_args, ctx) => setMode(mode, ctx),
    });
  }

  pi.registerCommand("permissions", {
    description:
      "List merged permission rules (allow/deny/ask) from global + project config; 'import-cc [--dry-run]' imports Claude Code approved lists",
    handler: async (args, ctx) => {
      const raw = String(args ?? "").trim()
      if (raw.startsWith("import-cc")) {
        const dryRun = /\b--dry-run\b/.test(raw)
        try {
          const plan = planCcImport({ cwd: ctx.cwd })
          if (dryRun) {
            const text = formatCcImportReport(plan)
            if (ctx.hasUI) {
              pi.sendMessage(
                {
                  customType: "permissions-list",
                  content: `${text}\n\n(dry run — nothing was written; rerun without --dry-run to import)`,
                  details: { command: "/permissions import-cc --dry-run" },
                  display: true,
                },
                { triggerTurn: false },
              )
            } else {
              console.log(text)
            }
            return
          }
          const result = executeCcImport(plan, { cwd: ctx.cwd })
          reloadMergedPermissionRules(ctx.cwd)
          const text = formatCcImportReport(plan, result)
          if (ctx.hasUI) {
            pi.sendMessage(
              {
                customType: "permissions-list",
                content: text,
                details: { command: "/permissions import-cc" },
                display: true,
              },
              { triggerTurn: false },
            )
          } else {
            console.log(text)
          }
        } catch (err) {
          console.warn("[permission-modes] import-cc failed:", err)
        }
        return
      }
      reloadMergedPermissionRules(ctx.cwd);
      const text = formatMergedRulesForDisplay(mergedPermissionRules);
      const grants = listSessionGrants();
      const grantsBlock =
        grants.length > 0
          ? `\n\n**Session grants** (this session only)\n\n\`\`\`\n${grants.join("\n")}\n\`\`\`\nClear with: /permissions-clear-grants`
          : "";
      if (ctx.hasUI) {
        pi.sendMessage(
          {
            customType: "permissions-list",
            content: `**Permission rules**\n\n\`\`\`\n${text}\n\`\`\`${grantsBlock}`,
            details: { command: "/permissions" },
            display: true,
          },
          { triggerTurn: false },
        );
      } else {
        console.log(text + grantsBlock.replace(/\\n/g, "\n"));
      }
    },
  });

  pi.registerCommand("permissions-clear-grants", {
    description: "Clear all session-scoped family grants (P4-FAM-05)",
    handler: async (_args, ctx) => {
      clearSessionGrants();
      if (ctx.hasUI) uiNotify(ctx, "Session grants cleared.", "info");
    },
  });

  pi.registerCommand("mode", {
    description:
      "Show or set the permission mode (ask | plan | auto | bypass)",
    handler: async (args, ctx) => {
      const arg = (args ?? "").trim();
      if (arg && (MODE_CYCLE as string[]).includes(arg)) {
        await setMode(arg as Mode, ctx);
        return;
      }
      if (arg === "default") {
        await setMode("ask", ctx);
        return;
      }
      if (!ctx.hasUI) return;
      const choice = await ctx.ui.select(
        "Select mode:",
        MODE_CYCLE.map((m) => MODE_META[m].label),
      );
      const picked = MODE_CYCLE.find((m) => MODE_META[m].label === choice);
      if (picked) await setMode(picked, ctx);
    },
  });

  registerPlanSurfaces(pi, plan);

  registerOutsideWritesCommands(pi);


    pi.registerShortcut("shift+tab", {
    description: "Cycle mode: Ask → Plan → Auto → Bypass",
    handler: async (ctx) => cycleMode(ctx),
  });


  pi.registerFlag("permission-mode", {
    description:
      "Start in a permission mode: ask, plan, auto, or bypass (accepts 'default' as alias for 'ask')",
    type: "string",
    default: "ask",
  });



  const adjudicator = createPermissionAdjudicator({
    collectFacts: facts.collectAdjudicationFacts,
    interpret: (call, decision) =>
      interpretDecision(
        {
          promptWithOptions: (c, label, category) =>
            approval.promptWithPermissionOptions(c.ctx as ExtensionContext, c.tool, c.input, label, category),
          promptApproval: (c, label) =>
            approval.promptApproval(c.ctx as ExtensionContext, c.tool, label, c.input),
          firstSeen: (c, canonicalId, suggestedRule) =>
            approval.firstSeenPrompt(c.ctx as ExtensionContext, canonicalId, c.tool, c.input, suggestedRule),
          editWriteChoice: (c, path) => approval.editWriteChoicePrompt(c, path),
          classifyTier3: (c, tier3) =>
            autoEngine.approveTier3(c.ctx as ExtensionContext, c.tool, c.input, {
              tool: c.tool,
              command: tier3.command,
              path: tier3.path,
            }),
          recordAutoAllow: () => autoEngine.noteAllowed(),
          trackOutsideWrite: (c) => {
            const ctx = c.ctx as ExtensionContext;
            if (c.tool === "edit" || c.tool === "write") {
              autoEngine.trackOutsideWriteIfNeeded(ctx, c.tool, String(c.input.path ?? ""));
            }
          },
          noteFamilyAdjudication: (c, outcome) => approval.noteFamilyAdjudication(c.tool, c.input, outcome),
        },
        call,
        decision,
      ),
  });

  pi.on("tool_call", async (event, ctx): Promise<Block> => {
    try {
      if (event.parentToolCallId === undefined) {
        const dupReason = checkBatchDup(batchDupIndex ?? undefined, event.toolCallId);
        if (dupReason) return { block: true, reason: dupReason };
      } else if (currentMode !== "bypass") {
        const loopReason = parentLoopBreaker.check(
          event.parentToolCallId,
          parentLoopKey(event.toolName, event.input ?? {}),
        );
        if (loopReason) return { block: true, reason: loopReason };
      }
    } catch (err) {
      console.warn("[permission-modes] loop-guard check failed open:", err);
    }
    try {
      return await adjudicator.check({
        ctx,
        tool: event.toolName,
        input: (event.input ?? {}) as Record<string, unknown>,
      });
    } catch (err) {
      console.warn("[permission-modes] permission check failed:", err);
      return {
        block: true,
        reason: `permission check failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  });

  pi.on("before_agent_start", async (event, ctx) => {
    publishInheritedPermissionMode(currentMode);
    publishCapability({ mode: currentMode });

    applyToolRestrictions();

    classifierConfig = resolveClassifierConfig(loadPermissionModesConfig());
    autoModeConfig = resolveAutoModeConfig(loadPermissionModesConfig());
    reloadMergedPermissionRules(ctx.cwd);

    const systemPromptBase =
      event?.systemPrompt ?? ctx?.getSystemPrompt?.() ?? "";

    let modeBlock = "";
    const complianceBlock = pendingComplianceInject
      ? resolveModePrompt({
          mode: currentMode,
          pendingComplianceInject: true,
          complianceCategory,
        })
      : "";

    const execBlock = plan.executingPromptBlock(complianceBlock);
    if (execBlock !== undefined) {
      modeBlock = execBlock;
    } else {
      const planPath =
        currentMode === "plan" ? shortenPath(ensurePlanFile(ctx.cwd)) : undefined;
      modeBlock = resolveModePrompt({
        mode: currentMode,
        planPhase: plan.phase,
        planFilePath: planPath,
        needsAskReminder,
        needsBypassSecurityReminder,
        pendingComplianceInject,
        complianceCategory,
      });
    }

    if (pendingComplianceInject) {
      pendingComplianceInject = false;
      complianceCategory = "";
    }
    if (needsAskReminder) needsAskReminder = false;
    if (needsBypassSecurityReminder) needsBypassSecurityReminder = false;

    let injectionBlock = "";
    if (currentMode === "auto" || currentMode === "bypass") {
      injectionBlock = TOOL_OUTPUT_INJECTION_WARNING;
      try {
        const messages = readBranchMessages(ctx.sessionManager, 12);
        const signal = scanBranchForInjectionSignals(
          messages.length > 0 ? messages : (((ctx as any).messages ?? []) as never[]),
        );
        if (signal) {
          injectionBlock = buildInjectionWarningBlock(signal);
        }
      } catch {
      }
    }

    const skillFilter = resolveSkillFilter(profiles.config, currentMode);
    let workingPrompt = systemPromptBase;
    if (skillFilter.length !== 1 || skillFilter[0] !== "*") {
      if (workingPrompt) {
        const filtered = filterSkillsFromPrompt(workingPrompt, skillFilter);
        if (
          skillFilter.length > 0 &&
          filtered === workingPrompt &&
          workingPrompt.includes("<skill")
        ) {
          console.warn(
            `[permission-modes] Skill filter for mode "${currentMode}" was a no-op ` +
              `(${skillFilter.length} skill(s) requested: ${skillFilter.join(", ")}).`,
          );
        }
        workingPrompt = filtered;
      }
    }

    const anchored = injectModePrompt(workingPrompt, modeBlock);
    const withInjection =
      injectionBlock && anchored
        ? `${anchored}\n\n${injectionBlock}`
        : injectionBlock && !anchored
          ? injectionBlock
          : anchored;
    if (withInjection !== workingPrompt || modeBlock || injectionBlock) {
      return { systemPrompt: withInjection || workingPrompt };
    }
    return undefined;
  });

  pi.on("context", async (event) => {
    const msgs = event.messages;
    let lastIdx = -1;
    for (let i = 0; i < msgs.length; i++) {
      const custom = msgs[i] as { customType?: string };
      if (custom?.customType === "modes-context") lastIdx = i;
    }
    if (lastIdx === -1) return undefined;
    return {
      messages: msgs.filter((m, i) => {
        const custom = m as { customType?: string };
        return custom?.customType !== "modes-context" || i === lastIdx;
      }),
    };
  });

  pi.on("turn_start", async (_event, ctx) => {
    statsPresenter.onTurnStart(ctx);
  });
  pi.on("before_provider_request", async (_event, ctx) =>
    statsPresenter.onBeforeProviderRequest(ctx),
  );
  pi.on("message_update", async (_event, ctx) => refreshWorkingMessage(ctx));
  pi.on("message_end", async (event, _ctx) => {
    statsPresenter.markDirty();
    const nextBatch = indexBatchDupes(event.message);
    if (nextBatch) batchDupIndex = nextBatch;
  });
  pi.on("model_select", async (_event, _ctx) => {
    statsPresenter.onModelChange();
  });

  pi.on("turn_end", async (event, ctx) => {
    try {
      gitBranch = readGitBranch(ctx.sessionManager) ?? gitBranch;
    } catch {
    }

    statsPresenter.onTurnEndStats(ctx);

    try {
      if (isAssistantMessage(event.message)) {
        const verdict = classifyLengthStop({
          stopReason: (event.message as { stopReason?: string }).stopReason,
          usage: (event.message as { usage?: { output?: number } }).usage,
          modelMaxOutputTokens: (ctx as { model?: { maxTokens?: number } }).model?.maxTokens,
        });
        const policy = boundedRecoveryPolicy(verdict);
        if (policy.userNotice) sharedNotify(ctx, policy.userNotice, "warning");
      }
    } catch {
    }

    const msg = event.message;
    if (!isAssistantMessage(msg)) return;
    const text = assistantMessageText(msg);

    plan.onTurnEnd(text, ctx);
  });

  pi.on("agent_end", async (event, ctx) => {
    if (ctx.hasUI) ctx.ui.setWorkingMessage();
    if (await plan.onAgentEnd(event, ctx)) return;
  });

  const onCompactionAfter = (): void => {
    statsPresenter.invalidate();
    if (currentMode === "bypass") {
      needsBypassSecurityReminder = true;
    }
    persistState();
  };

  pi.on("session_compact", async () => {
    onCompactionAfter();
  });

  unregisterModesSeam?.();
  unregisterModesSeam = registerCompactionSubscriber({ after: () => onCompactionAfter() });

  async function onSessionStart(
    _event: unknown,
    ctx: ExtensionContext,
  ): Promise<void> {
    facts.scanFusionToolSchemas();

    profiles.initSession(ctx);

    const flag = pi.getFlag("permission-mode");
    if (typeof flag === "string") {
      if ((MODE_CYCLE as string[]).includes(flag)) {
        currentMode = flag as Mode;
      } else if (flag === "default" || flag === "accept-edits") {
        currentMode = "ask";
      }
    }

    try {
      const modesData = readCustomEntryData(ctx.sessionManager, "modes");
      const last = modesData[modesData.length - 1] as
        | {
            currentMode?: string;
            planPhase?: string;
            planExecuting?: boolean;
            planTodos?: TodoItem[];
            lastExtractedPlanHash?: string;
            activeProfile?: string;
          }
        | undefined;
      if (last) {
        let m = last.currentMode;
        if (m) {
          if (m === "normal") m = "default";
          if (m === "default") m = "ask";
          if (m === "accept-edits") m = "ask";
          if ((MODE_CYCLE as string[]).includes(m)) currentMode = m as PermissionMode;
        }
        plan.restoreFromEntry(last);
        if (typeof last.activeProfile === "string")
          profiles.restoreFromEntry(last.activeProfile);
      }
    } catch {
    }

    const inherited = applyInheritedModeForChild();
    if (inherited) currentMode = inherited;

    publishInheritedPermissionMode(currentMode);
    publishCapability({ mode: currentMode });

    classifierConfig = resolveClassifierConfig(loadPermissionModesConfig());
    autoModeConfig = resolveAutoModeConfig(loadPermissionModesConfig());
    if (currentMode === "auto") {
      autoEngine.resetDenialState();
    }
    reloadMergedPermissionRules(ctx.cwd);

    try {
      gitBranch = readGitBranch(ctx.sessionManager) ?? "";
    } catch {
    }

    applyToolRestrictions();
    plan.onSessionStartUi(ctx);
    if (currentMode === "ask") needsAskReminder = true;
    if (currentMode === "bypass") needsBypassSecurityReminder = true;
    if (ctx.hasUI) {
      installModesFooter(ctx, () => ({ mode: currentMode, gitBranch, activeProfile: profiles.active, thinkingLevel: pi.getThinkingLevel() }));
      clearModesStatus(ctx);
      fallbackAdapter.shutdown();
      fallbackAdapter = createFallbackAdapter({
        hasUI: ctx.hasUI,
        setWorkingMessage: (m) => ctx.ui.setWorkingMessage(m),
        notify: (m, l) => ctx.ui.notify(m, l),
        theme: ctx.ui.theme,
      });
      fallbackAdapter.startup();
    }

    if (profiles.active) {
      await profiles.applyForMode(currentMode, ctx);
    }

    forwarding.start(ctx);
  }


  pi.on("session_start", onSessionStart);
  pi.on("session_tree", onSessionStart);
  pi.on("session_start", () => {
    statsPresenter.reset();
    publishCapability({ usage: null });
  });
  pi.on("session_tree", () => {
    statsPresenter.reset();
    publishCapability({ usage: null });
  });
  pi.on("session_start", (_event, ctx: ExtensionContext) => {
    clearSessionState();
    setBypassIndicator(pi.getFlag("permission-mode") === "bypass");
    void ctx;
  });
  pi.on("session_shutdown", () => {
    statsPresenter.reset();
    publishCapability({ usage: null });
    fallbackAdapter.shutdown();
    forwarding.shutdown();
    clearSessionState();
  });
}
