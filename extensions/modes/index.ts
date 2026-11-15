/**
 * @georgedong32/permission-modes
 *
 * Claude-Code-style permission modes for the pi coding agent.
 *
 * Four modes (Shift+Tab): ask → plan → auto → bypass → ask
 *   - ask     Manual approval for edits, outside-cwd access, mutating bash.
 *   - plan    Read-only; only plan.md may be written.
 *   - auto    Tiered auto-approve + optional built-in classifier + risk blacklist.
 *   - bypass  Full auto-approve (old auto semantics); sparse security reminders.
 */

import {
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { MODE_META, modeMetaData } from "./ui/meta.ts";
import { clearModesStatus, installModesFooter, shortenPath } from "./ui/footer.ts";
import { notify as uiNotify } from "../ui/notify.ts";
// B1 truncation notices ride the same shared entry (alias for clarity at the call site).
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
import { TodoItem, ensurePlanFile } from "./plan.ts";
import { createPlanSession, registerPlanSurfaces } from "./plan-session.ts";
import {
  applyInheritedModeForChild,
  publishInheritedPermissionMode,
} from "./mode-inherit.ts";
import { resolveSkillFilter } from "./profiles.ts";
import { createProfileController, registerProfileSurfaces } from "./profile-apply.ts";

type Mode = PermissionMode;

const MODE_CYCLE: Mode[] = ["ask", "plan", "auto", "bypass"];



/**
 * Cross-extension capability object (plan B7): the single typed channel to
 * pi-claude-code-tui — globalThis.__piPermissionModes. Duck-typed on both
 * sides; version gates consumers.
 */
export interface PmCapability {
	version: number;
	active: boolean;
	mode: string;
	workingStats: string | null;
	/** XPKG-08 (P2-4): raw usage numbers from the same snapshot as
	 * workingStats. `undefined` on a mode-only patch means "keep"; pass
	 * `null` to explicitly CLEAR (session switch/shutdown). */
	usage?: CoreSnapshot["modes"]["usage"] | null;
}

// SC §5.9 W5: exactly one live seam registration per process — a factory
// re-run replaces the previous subscriber instead of stacking duplicates.
let unregisterModesSeam: (() => void) | undefined;

export default function permissionModesExtension(pi: ExtensionAPI): void {
  // ---- state -------------------------------------------------------------
  // DC5: the fallback UI adapter — the only writer of pi's working-message
  // slot from this module, yielding to a live CC-TUI (see ui/fallback.ts).
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
  // D1/D1b (loop-guard): same-batch duplicate index (replaced per
  // message_end) + the per-parent identical-call breaker for codemode
  // nested calls. A DEFENSE, not a permission — checked before the
  // adjudicator so bypass does not exempt it.
  let batchDupIndex: BatchDupIndex | null = null;
  const parentLoopBreaker = createParentLoopBreaker();

  // ---- approval flow (SPEC SR W-M) ----------------------------------------
  // The approval side-effect layer (applyApprovalDecision executor, the
  // 4-choice prompt with the forwarding child path, family first-seen, the
  // edit/write 5-choice dialog) lives in approval-flow.ts. Live state stays
  // here and reaches it through deps.
  const approval = createApprovalFlow({
    reloadRules: reloadMergedPermissionRules,
    setMode,
    getAutoEngine: () => autoEngine,
    setCompliance: (inject, category) => {
      pendingComplianceInject = inject;
      complianceCategory = category;
    },
  });

  // ---- adjudication facts (SPEC SR W-M) -----------------------------------
  // Step-1 fact collection + the fusion tool-schema scan live in
  // adjudication-facts.ts; parity with the pre-refactor gate is pinned by
  // test/lib/adjudication-parity.test.ts.
  const facts = createAdjudicationFacts({
    getAllTools: () => pi.getAllTools?.() ?? [],
    getMode: () => currentMode,
    getMergedRules: () => mergedPermissionRules,
    getAutoModeConfig: () => autoModeConfig,
    describeTier3Review: (tool, input, cwd) =>
      autoEngine.describeTier3Review(tool, input, cwd),
    isMemoryDirWrite: approval.isMemoryDirWrite,
  });

  // ---- forwarding responder (SPEC SR W-M) ---------------------------------
  // The parent-side approval-forwarding responder (poller + claimed ids +
  // response writer) lives in forwarding-responder.ts.
  const forwarding = createForwardingResponder({
    applyApprovalDecision: approval.applyApprovalDecision,
  });

  // ---- plan session (E13b + CORE-17) --------------------------------------
  // The plan lifecycle (executing flag, phase, todos, offer cooldown/suppress,
  // pre-plan tool snapshot) is owned by plan-session.ts; index keeps only the
  // mode state and assembles the persisted `modes` entry via entryFields().
  // Deps are lazy closures so construction order never matters (no TDZ).
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
    // Lazy wrapper: promptWithPermissionOptions lives in approval-flow.ts,
    // created above — but keep the indirection so construction order in the
    // factory body is never load-bearing.
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
    // Memoized verdicts may depend on the old rules — drop them (plan A5).
    invalidateClassifierVerdictCache();
  }

  // ---- model-profile state -----------------------------------------------
  // activeProfile === undefined means "no profile active" — the extension
  // works as before (no auto model switching). The /model-profile command and
  // --model-profile flag set this; persistState() persists it; session_start
  // restores it and re-applies the model.

  const profileWiring = {
    getMode: () => currentMode,
    onStateChanged: (ctx: ExtensionContext) => {
      clearModesStatus(ctx);
      persistState();
    },
    sendList: (text: string) => {
      pi.sendMessage(
        { customType: "model-profile-list", content: text, display: true,
          // display metadata for the CC panel renderer (content untouched);
          // the list form is the only path here — echo the typed subcommand
          details: { command: "/model-profile list" } },
        { triggerTurn: false },
      );
    },
  };
  const profiles = createProfileController(pi, profileWiring);
  registerProfileSurfaces(pi, profiles, profileWiring);

  // streaming stats (for the working-indicator readout)
  let gitBranch = "";

  // ---- small helpers -----------------------------------------------------
  const isAssistant = (m: any): boolean =>
    !!m && m.role === "assistant" && Array.isArray(m.content);

  const getText = (m: any): string =>
    Array.isArray(m?.content)
      ? m.content
          .filter((c: any) => c?.type === "text")
          .map((c: any) => c.text)
          .join("\n")
      : typeof m?.content === "string"
        ? m.content
        : "";

  function persistState(): void {
    pi.appendEntry("modes", {
      currentMode,
      activeProfile: profiles.active,
      ...plan.entryFields(),
    });
  }


  // C4 batch 2: the auto-mode tier-3 engine (local ladder + classifier
  // invocation + denial accounting + tier-3 review descriptions) lives in
  // auto-engine.ts now; the interpret ports below reach it through the
  // returned surface.

  // ---- tool gating -------------------------------------------------------
  // The snapshot/restore logic (toolsBeforePlanMode, PLAN_TOOLS) is plan
  // state — the PlanSession owns it (plan-session.ts).
  function applyToolRestrictions(): void {
    plan.applyToolRestrictions();
  }

  // ---- mode switching ----------------------------------------------------
  // BH-E4 (spec 2026-11-14-backtest-hardening): every setMode request gets a
  // generation number; only the NEWEST request executes side effects
  // (profile apply / setModel / plan file creation / persistence). Rapid
  // Shift+Tab cycling (e.g. plan→auto→bypass) must not leave plan.md behind
  // by passing through plan, re-apply a stale profile, or publish a stale
  // mode. The side-effect tail runs serialized on a promise chain, and the
  // generation is re-checked when the chain picks the request up (an
  // in-flight request that got superseded exits without side effects; the
  // newest request's own setModel — issued later — still lands last).
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
    if (gen !== setModeGeneration) return; // superseded — no side effects

    const run = modeSwitchTail.then(async () => {
      if (gen !== setModeGeneration) return; // superseded while queued
      // plan.md is created only when plan mode SETTLES (BH-E4)
      if (mode === "plan") plan.onPlanModeSettled(prev, ctx.cwd);
      await profiles.applyForMode(mode, ctx);
      if (gen !== setModeGeneration) return; // superseded mid-flight
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
    // BH-R7: a rejected setMode used to surface as an UNHANDLED rejection
    // (TUI crash risk) — catch it and tell the user instead.
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

  // ---- UI: status, footer, plan widget, working stats --------------------
  // C4 batch 1: the working-stats slice (cache + streaming counters +
  // working-message refresh) lives in stats-presenter.ts now; index keeps
  // only the capability channel below.
  const statsPresenter = createStatsPresenter({
    getFallbackAdapter: () => fallbackAdapter,
    publishCapability,
  });
  const { refreshWorkingMessage } = statsPresenter;
  // ---- Capability channel to pi-claude-code-tui (plan B7) ------------------
  // One typed, versioned namespace replaces the untyped globals; the legacy
  // __pmWorkingStats key stays published for one compatibility cycle (older
  // cctui builds read it). Consumers detect via `version >= 1`.
  function publishCapability(patch: Partial<PmCapability>): void {
    // P1-BUS-03: the capability bus is the single publish point; the legacy
    // __piPermissionModes key is derived from the same frozen snapshot
    // inside publish(), so new and legacy keys cannot diverge.
    const prev = coreBus().snapshot().modes;
    coreBus().publish({
      modes: {
        mode: (patch.mode ?? prev.mode) as "ask" | "plan" | "auto" | "bypass" | "",
        planPhase: (patch as { planPhase?: PlanPhase }).planPhase ?? prev.planPhase ?? plan.phase,
        workingStats:
          patch.workingStats !== undefined ? patch.workingStats : prev.workingStats,
        // XPKG-08: mode-only patches keep the latest usage ("usage" NOT in
        // patch); an EXPLICIT null clears it (session switch/shutdown) —
        // `?? prev` here would make clearing impossible.
        usage: "usage" in patch ? (patch.usage ?? undefined) : prev.usage,
        // DC1: mode presentation material rides the snapshot (single source;
        // stable reference after first publish).
        meta: prev.meta ?? modeMetaData(),
      },
    });
  }

  // P0-1 §4.2's applyPermissionVerdict was absorbed by P2-1: the allow/ask
  // verdict effects now live in adjudicate.ts step 4/5 + interpret.ts ports
  // (deleted as dead code — zero callers after the migration; review P3-4).


  // ---- commands / shortcut / flag ---------------------------------------
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
        // P2: plan reads CC's three settings layers + the legacy ~/.claude.json
        // allowedTools; execute writes through the idempotent loader path.
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
      // P4-FAM-05: session grants are visible and clearable from here
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
            // display metadata for the CC panel renderer (content untouched)
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
      // Accept "default" as an alias for "ask" during migration period.
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

  // ---- plan surfaces (E13b/CORE-17) ---------------------------------------
  // /plan-execute + the plan_ready tool live in plan-session.ts now; they
  // register here, at the historical position between /mode and
  // /outside-writes.
  registerPlanSurfaces(pi, plan);

  registerOutsideWritesCommands(pi);


    pi.registerShortcut("shift+tab", {
    description: "Cycle mode: Ask → Plan → Auto → Bypass",
    handler: async (ctx) => cycleMode(ctx),
  });

  // Alt+T: cycle the thinking level. pi has no built-in cycle helper, and pi
  // clamps to the model's capabilities, so we advance to the next level the model actually
  // accepts (skipping ones it clamps away). Writes go through the EffortOwner
  // (src "shortcut"). The footer reflects the new level live.
  // Alt+T moved to the effort module (arch review C5): thinking-level
  // cycling is effort's domain — model-aware via cycleLevel/cycleLevelWithOff,
  // written through the shared owner with a zero-write guard on single-level
  // models (the old probe loop pinned clamped values into the explicit slot).
  // Negative-pinned by index.test.ts (this module must NOT register alt+t).

  // NB: pi has a built-in `--mode` (output mode: text/json/rpc), so the start-mode
  // flag must use a distinct name to avoid being shadowed at parse time.
  pi.registerFlag("permission-mode", {
    description:
      "Start in a permission mode: ask, plan, auto, or bypass (accepts 'default' as alias for 'ask')",
    type: "string",
    default: "ask",
  });


  // BH-R6: autoMode allow / soft_deny matching moved to the pure module
  // auto-rule-match.ts — per-segment semantics (soft_deny wins on ANY
  // segment; fast-allow only when EVERY segment matches and the command
  // carries no command substitution). Single-segment verdicts are pinned
  // identical to the legacy whole-command matcher.

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
    // D1/D1b (loop-guard) — first step, before every permission path:
    // same-batch byte-identical followers block; a codemode parent stuck
    // in an identical-call loop trips its breaker. Both fail open (an id
    // missing from the index passes; see loop-guard.ts).
    // P1-B (2026-11-02, BREAKING): D1b is fully exempted in bypass mode —
    // Claude Code's bypass has no loop defense and its scripts legitimately
    // repeat identical calls (poll/retry); D1 (same-batch followers) stays.
    // R1 P2-2: the defense fails OPEN — a guard that throws would fail
    // CLOSED at the host ("Extension failed, blocking execution") and become
    // the very thing it exists to prevent.
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
    // BH-R7: the adjudication must never throw through the tool_call event —
    // a throw fails the whole call at the host. Stay fail-closed with a
    // readable reason instead.
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

  // ---- context injection (system prompt anchor) --------------------------
  pi.on("before_agent_start", async (event, ctx) => {
    // Keep inherited-mode env fresh so subagents spawned this turn see the
    // parent's current mode (covers mid-session upgrades / missed setMode).
    publishInheritedPermissionMode(currentMode);
    publishCapability({ mode: currentMode });

    // Re-apply each turn so other extensions (e.g. hypa replace mode) cannot
    // permanently drop plan-mode tools like ls/grep/find from the active set.
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
        // Real SessionEntry shape comes unwrapped from the port; the legacy
        // flat `ctx.messages` fallback predates typed access (plan B1).
        // plan2 A1a: only the trailing 12 messages feed the injection scan —
        // materialize just those instead of the whole branch.
        const messages = readBranchMessages(ctx.sessionManager, 12);
        const signal = scanBranchForInjectionSignals(
          messages.length > 0 ? messages : (((ctx as any).messages ?? []) as never[]),
        );
        if (signal) {
          injectionBlock = buildInjectionWarningBlock(signal);
        }
      } catch {
        // best-effort scan only
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

  // ---- streaming-stat working message -----------------------------------
  pi.on("turn_start", async (_event, ctx) => {
    statsPresenter.onTurnStart(ctx);
  });
  pi.on("before_provider_request", async (_event, ctx) =>
    statsPresenter.onBeforeProviderRequest(ctx),
  );
  pi.on("message_update", async (_event, ctx) => refreshWorkingMessage(ctx));
  pi.on("message_end", async (event, _ctx) => {
    // ST: fired BEFORE the host appends the entry — the cached snapshot must
    // not be mistaken for the new branch state (the leafId key also moves).
    statsPresenter.markDirty();
    // D1 (loop-guard): hold the latest assistant batch's duplicate index.
    // REPLACE-ONLY (R1 P1-1): the sequential dispatch path emits a toolResult
    // message_end between the batch's gate calls, and parallel batches see
    // queued steer/custom message_ends between batches — a non-assistant
    // message_end must never clear the held index (indexBatchDupes returns
    // null for those). toolCallIds are unique per response, so holding the
    // last assistant index across turns cannot mis-block a fresh call.
    const nextBatch = indexBatchDupes(event.message);
    if (nextBatch) batchDupIndex = nextBatch;
  });
  pi.on("model_select", async (_event, _ctx) => {
    // ST: observable model change invalidates the usage snapshot.
    statsPresenter.onModelChange();
  });

  // ---- turn_end: tps + plan-step tracking --------------------------------
  pi.on("turn_end", async (event, ctx) => {
    try {
      gitBranch = readGitBranch(ctx.sessionManager) ?? gitBranch;
    } catch {
      /* ignore */
    }

    // ST: ONE forced committed-final read feeds the TPS math AND the
    // display refresh — the stats segment lives in the presenter now.
    statsPresenter.onTurnEndStats(ctx);

    // B1 (cherry-batch1): truncation is never a silent success — a length
    // terminal gets one bus notice with verdict-shaped guidance. Narrow to
    // assistant first (TurnEndEvent.message is a union); ctx.model is the
    // direct seam for the cap.
    try {
      if (isAssistant(event.message)) {
        const verdict = classifyLengthStop({
          stopReason: (event.message as { stopReason?: string }).stopReason,
          usage: (event.message as { usage?: { output?: number } }).usage,
          modelMaxOutputTokens: (ctx as { model?: { maxTokens?: number } }).model?.maxTokens,
        });
        const policy = boundedRecoveryPolicy(verdict);
        if (policy.userNotice) sharedNotify(ctx, policy.userNotice, "warning");
      }
    } catch {
      /* the notice path must never break a turn */
    }

    const msg = event.message;
    if (!isAssistant(msg)) return;
    const text = getText(msg);

    plan.onTurnEnd(text, ctx);
  });

  // ---- agent_end: idle reset + plan complete + plan offer ----------------
  // The plan flow (completion announcement while executing, plan-mode offer
  // with sync + cooldown) lives in plan-session.ts; it reports whether it
  // handled the event so this handler can early-return exactly as before.
  pi.on("agent_end", async (event, ctx) => {
    if (ctx.hasUI) ctx.ui.setWorkingMessage();
    if (await plan.onAgentEnd(event, ctx)) return;
  });

  // Compaction reaction (SC §5.9, W5): one named function driven BOTH by the
  // native session_compact event and the boundary-draft seam — all three
  // actions are idempotent, so a duplicate or lost proposal leaves no
  // residue (§5.9a modes row). Native path behavior unchanged (SM-05).
  const onCompactionAfter = (): void => {
    statsPresenter.invalidate(); // ST: compaction rewrites the branch
    if (currentMode === "bypass") {
      needsBypassSecurityReminder = true;
    }
    persistState();
  };

  pi.on("session_compact", async () => {
    onCompactionAfter();
  });

  // One live registration per process: replace on factory re-run (SC W5).
  unregisterModesSeam?.();
  unregisterModesSeam = registerCompactionSubscriber({ after: () => onCompactionAfter() });

  // ---- session start / resume -------------------------------------------
  async function onSessionStart(
    _event: unknown,
    ctx: ExtensionContext,
  ): Promise<void> {
    // plan2 B1 ②: enumerate tool schemas once per session (reload re-runs).
    facts.scanFusionToolSchemas();

    // C5: model-profile session init (config ensure + --model-profile
    // pre-activation) lives in the ProfileController.
    profiles.initSession(ctx);

    // NB: pi has a built-in `--mode` (output mode: text/json/rpc), so the
    // start-mode flag must use a distinct name to avoid being shadowed at
    // parse time.
    const flag = pi.getFlag("permission-mode");
    if (typeof flag === "string") {
      if ((MODE_CYCLE as string[]).includes(flag)) {
        currentMode = flag as Mode;
      } else if (flag === "default" || flag === "accept-edits") {
        currentMode = "ask";
      }
    }

    // Restore the latest persisted mode entry (overrides the flag).
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
          if (m === "normal") m = "default";      // legacy (v0.x)
          if (m === "default") m = "ask";          // v1.0.0 → v2.0.0 rename
          if (m === "accept-edits") m = "ask";
          if ((MODE_CYCLE as string[]).includes(m)) currentMode = m as PermissionMode;
        }
        // Overlay-ONLY restore of the plan fields lives in the PlanSession;
        // the mode-name mapping (legacy renames) stays here.
        plan.restoreFromEntry(last);
        if (typeof last.activeProfile === "string")
          profiles.restoreFromEntry(last.activeProfile);
      }
    } catch {
      /* ignore */
    }

    // Headless subagents ALWAYS inherit the parent's live mode from env when
    // set (wins over --permission-mode flag and session restore). Review
    // fan-out must not stay on ask while the parent is in bypass.
    const inherited = applyInheritedModeForChild();
    if (inherited) currentMode = inherited;

    // Always publish so nested / later spawns see the effective mode.
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
      /* ignore */
    }

    applyToolRestrictions();
    plan.onSessionStartUi(ctx);
    if (currentMode === "ask") needsAskReminder = true;
    if (currentMode === "bypass") needsBypassSecurityReminder = true;
    if (ctx.hasUI) {
      installModesFooter(ctx, () => ({ mode: currentMode, gitBranch, activeProfile: profiles.active, thinkingLevel: pi.getThinkingLevel() }));
      clearModesStatus(ctx);
      // DC5: rebuild the fallback adapter with the live context (it owns
      // the working-message slot write from here on).
      fallbackAdapter.shutdown();
      fallbackAdapter = createFallbackAdapter({
        hasUI: ctx.hasUI,
        setWorkingMessage: (m) => ctx.ui.setWorkingMessage(m),
        notify: (m, l) => ctx.ui.notify(m, l),
        theme: ctx.ui.theme,
      });
      fallbackAdapter.startup();
    }

    // If a profile was activated (via flag or persisted state), apply its
    // model mapping for the current mode.
    if (profiles.active) {
      await profiles.applyForMode(currentMode, ctx);
    }

    forwarding.start(ctx);
  }


  pi.on("session_start", onSessionStart);
  pi.on("session_tree", onSessionStart);
  pi.on("session_start", () => {
    statsPresenter.reset(); // ST: re-base on (re)load
    publishCapability({ usage: null }); // XPKG-08: old-session numbers never leak into a new one
  });
  pi.on("session_tree", () => {
    statsPresenter.reset();
    publishCapability({ usage: null });
  });
  pi.on("session_start", (_event, ctx: ExtensionContext) => {
    // P4-FAM-05: session-scoped authorizations reset on (re)load
    clearSessionState();
    setBypassIndicator(pi.getFlag("permission-mode") === "bypass");
    void ctx;
  });
  pi.on("session_shutdown", () => {
    statsPresenter.reset(); // ST: clear the private cache (legacy keys unaffected)
    publishCapability({ usage: null }); // XPKG-08: shutdown clears the published numbers
    fallbackAdapter.shutdown();
    forwarding.shutdown();
    // P4-FAM-05: session-scoped family state resets on shutdown too
    clearSessionState();
  });
}
