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

import { Type } from "@earendil-works/pi-ai";
import {
  defineTool,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui"
import { MODE_META, modeMetaData } from "./ui/meta.ts";
import { clearModesStatus, installModesFooter, shortenPath } from "./ui/footer.ts";
import { clearPlanWidget, updatePlanWidget as updatePlanWidgetUi } from "./ui/plan-widget.ts";
import { confirmChoice } from "./ui/confirm.ts";
import { notify as uiNotify } from "../ui/notify.ts";
import { createFallbackAdapter } from "../ui/fallback.ts";
import { coreBus, type CoreSnapshot } from "../bus.ts"
import { isMemoryWritePath } from "../memory/paths.ts"
import { clearSessionGrants, clearSessionState, grantSession, hasSessionGrant, isBypassActive, listSessionGrants, matchFamily, noteAdjudicated, familyRuleMentions, setBypassIndicator } from "./rule-families.ts"
import { getSharedEffortOwner, type OwnerEffortLevel } from "../../lib/effort-owner.ts";
// B1: shared MCP-shape core — the authority (mcp-gov/family.ts
// #canonicalizeMcpTool) and this plan gate consume the same lib predicate,
// so the gate can never again drift from the family on MCP shapes.
import { isMcpShapedCall, knownServersSetFromEnv } from "../../lib/mcp-shape.ts";
import { readFileSync } from "node:fs"
import { homedir } from "node:os";
import path from "node:path";
import {
  classifyToolCall,
  invalidateClassifierVerdictCache,
  readAgentsMdForClassifier,
  type ClassifierSessionContext,
} from "./classifier-client.ts";
import {
  buildClassifierUnavailableMessage,
  buildYoloRejectionMessage,
} from "./classifier-messages.ts";
import {
  loadPermissionModesConfig,
  resolveAutoModeConfig,
  resolveClassifierConfig,
} from "./config.ts";
import {
  restoreDangerousPermissionRules,
  stripDangerousPermissionRules,
} from "./dangerous-permissions.ts";
import {
  createDenialTrackingState,
  recordClassifierDenial,
  recordClassifierSuccess,
  shouldFallbackToPrompting,
  type DenialTrackingState,
} from "./denial-tracking.ts";
import {
  buildInjectionWarningBlock,
  scanBranchForInjectionSignals,
  TOOL_OUTPUT_INJECTION_WARNING,
} from "./injection-probe.ts";
import {
  readBranchEntries,
  readBranchMessages,
  readCustomEntryData,
  readGitBranch,
  readSessionId,
} from "./session-branch.ts";
import {
  declaredCommandFields,
  extractEmbeddedCommandInputs,
} from "./fusion-tools.ts";
import {
  accumulateBranchStats,
  emptyBranchStatsState,
} from "./branch-stats.ts";
import { createWorkingStats, type WorkingStatsCache, type WorkingStatsHost } from "./working-stats.ts";
import {
  addPermissionRule,
  loadMergedPermissionRules,
  warnIfLocalPermissionsNotGitignored,
} from "./permissions-loader.ts";
import {
  evaluateToolPermission,
  formatMergedRulesForDisplay,
  suggestAllowRuleForToolCall,
  type PermissionRule,
  type PermissionVerdict,
} from "./permissions.ts";
import { checkAutoRisk } from "./auto-risk.ts";
import { classifyBashTiers, isAutoFallbackBash, isSafeCommand } from "./bash-analysis.ts";
import { PermissionMode, PlanPhase, filterSkillsFromPrompt, injectModePrompt, resolveModePrompt } from "./mode-prompt.ts";
import { planHardBlock } from "./plan-gate.ts";
import { OutsideWriteSnapshot, listTrackedOutsideWrites, popTrackedOutsideWrite, restoreOutsideWrite, trackOutsideWrite } from "./outside-writes.ts";
import { commandReferencesSensitivePath, findProjectRoot, isOutsideCwd, isSensitivePath } from "./path-safety.ts";
import { TodoItem, ensurePlanFile, extractPlanSection, extractTodoItems, filterSubstantivePlanItems, getPlanFilePath, hashPlan, isPlanFilePath, markCompletedSteps, readPlanFile, resolveWorkspacePath, shouldSyncAssistantPlanToFile, writePlanFile } from "./plan.ts";
import { formatCount } from "./ui/format.ts";
import {
  runPlanApprovalDialog,
} from "./ui/plan-approval-dialog.ts";
import {
  createForwardingPoller,
  defaultAgentDir,
  isSubagentChildProcess,
  pollForwardedResponse,
  resolveParentSessionId,
  writeForwardedRequest,
  writeForwardedResponse,
  type ForwardedDecision,
  type ForwardedPermissionRequest,
  type ForwardingPoller,
} from "./permission-forwarding.ts";
import {
  applyInheritedModeForChild,
  publishInheritedPermissionMode,
} from "./mode-inherit.ts";
import { resolveSkillFilter } from "./profiles.ts";
import { createProfileController, registerProfileSurfaces } from "./profile-apply.ts";

type Mode = PermissionMode;

const MODE_CYCLE: Mode[] = ["ask", "plan", "auto", "bypass"];


// Tools available in plan mode (edit/write only for plan.md via tool_call gate).
const PLAN_TOOLS = ["read", "bash", "grep", "find", "ls", "edit", "write", "plan_ready"];
const PLAN_READ_TOOLS = new Set(["read", "grep", "find", "ls"]);
/**
 * Gate-side classification for pi 0.99's meta tools (SPEC META-01..03):
 * `tool_search` only loads tool declarations (retrieval), `codemode` runs
 * model-written scripts that call other tools (execution surface). MCP
 * tools are detected via the shared lib/mcp-shape.ts predicate (native /
 * proxy / direct-named / bare `mcp_*` — declaring != executing, but every
 * MCP tool is a potential mutation, so plan denies them outright).
 */
const PLAN_DISABLED = new Set<string>();

type Block = { block: true; reason: string } | undefined;

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

/** Sanitized raw usage (P2-4 §4.1): finite non-negative only; a missing or
 * invalid REQUIRED cumulative field omits the whole object; optional ctx
 * fields are independently absent when unknown — never faked as 0. */
function sanitizeUsageNumbers(
	stats: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number },
	tps: number,
	usage: { tokens: number | null; contextWindow: number; percent: number | null } | undefined,
): NonNullable<CoreSnapshot["modes"]["usage"]> | undefined {
	for (const n of [stats.input, stats.output, stats.cacheRead, stats.cacheWrite, stats.cost]) {
		if (!Number.isFinite(n) || n < 0) return undefined;
	}
	const out: NonNullable<CoreSnapshot["modes"]["usage"]> = {
		input: stats.input,
		output: stats.output,
		cacheRead: stats.cacheRead,
		cacheWrite: stats.cacheWrite,
		cost: stats.cost,
	};
	if (Number.isFinite(tps) && tps > 0) out.tps = tps;
	if (usage) {
		if (usage.tokens != null && Number.isFinite(usage.tokens) && usage.tokens >= 0) out.ctxTokens = usage.tokens;
		if (usage.percent != null && Number.isFinite(usage.percent) && usage.percent >= 0) out.ctxPercent = usage.percent;
		if (Number.isFinite(usage.contextWindow) && usage.contextWindow > 0) out.contextWindow = usage.contextWindow;
	}
	return out;
}

export default function permissionModesExtension(pi: ExtensionAPI): void {
  // ---- state -------------------------------------------------------------
  // DC5: the fallback UI adapter — the only writer of pi's working-message
  // slot from this module, yielding to a live CC-TUI (see ui/fallback.ts).
  let fallbackAdapter = createFallbackAdapter({ hasUI: false, setWorkingMessage: () => {}, theme: { fg: (_r, s) => s } });
  let currentMode: Mode = "ask";
  let planExecuting = false;
  let planPhase: PlanPhase = "exploring";
  let lastExtractedPlanHash = "";
  let lastPlanOfferAt = 0;
  /** Suppress agent_end re-offer after the user dismisses plan approval (Stay/Esc/Refine). */
  let suppressPlanOfferUntil = 0;
  const PLAN_OFFER_COOLDOWN_MS = 60_000;
  let needsAskReminder = false;
  let needsBypassSecurityReminder = false;
  let pendingComplianceInject = false;
  let complianceCategory = "";
  let toolsBeforePlanMode: string[] | undefined;
  let planTodos: TodoItem[] = [];
  let projectRoot: string | null = null;
  let classifierConfig = resolveClassifierConfig(loadPermissionModesConfig());
  let autoModeConfig = resolveAutoModeConfig(loadPermissionModesConfig());
  let basePermissionRules: PermissionRule[] = [];
  let strippedDangerousRules: PermissionRule[] = [];
  let mergedPermissionRules: PermissionRule[] = [];
  let classifierDenialState: DenialTrackingState = createDenialTrackingState();
  const MAX_CLASSIFIER_FAILURES = 3;
  let forwardingPoller: ForwardingPoller | undefined;
  /** Survives poller restarts so the same inbox request is not double-prompted. */
  const forwardingClaimedIds = new Set<string>();

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
        { customType: "model-profile-list", content: text, display: true },
        { triggerTurn: false },
      );
    },
  };
  const profiles = createProfileController(pi, profileWiring);
  registerProfileSurfaces(pi, profiles, profileWiring);

  // streaming stats (for the working-indicator readout)
  let streamStart = 0;
  let outputAtStart = 0;
  let lastTps = 0;
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
      planPhase,
      planExecuting,
      planTodos,
      lastExtractedPlanHash,
    });
  }

  type ApprovalDecision =
    | "allow"
    | "allow_always_local"
    | "allow_always_global"
    | "bypass"
    | "block";

  /**
   * Single place that executes an approval decision's side effects:
   * allow-always persistence + rule reload + gitignore warning + notify,
   * outside-write tracking on EVERY allow path, compliance-inject on block.
   * The three approval flows (interactive select, ask-mode inline select,
   * forwarded-parent responder) used to duplicate this and had diverged —
   * the ask flow dropped write tracking and notifications (plan B2).
   * Options narrow execution for the forwarding paths:
   * - ruleCwd: parent responder persists rules against the child's cwd
   * - persistRules:false when the other side already persisted (child poll)
   * - trackWrite:false on the parent responder (tracking is the child's job)
   * - complianceOnBlock:false in ask mode (no classifier compliance there)
   */
  /**
   * Single record point for family-tool allow outcomes (P4-MC-03): every
   * gate allow path funnels through applyApprovalDecision or the step-2
   * allow branch, both of which call this — the broker mirror's cache view
   * can never miss a gate-approved call.
   */
  function noteFamilyAdjudication(
    tool: string,
    input: Record<string, unknown>,
    outcome: "allow-once" | "rule-allow" | "session-grant",
  ): void {
    const match = matchFamily(tool, input);
    if (match) noteAdjudicated(match.canonicalId, outcome);
  }

  async function applyApprovalDecision(
    ctx: ExtensionContext,
    tool: string,
    input: Record<string, unknown>,
    decision: ApprovalDecision,
    opts: {
      category?: string;
      ruleCwd?: string;
      persistRules?: boolean;
      trackWrite?: boolean;
      complianceOnBlock?: boolean;
      blockReason?: string;
    } = {},
  ): Promise<Block | undefined> {
    const ruleCwd = opts.ruleCwd ?? ctx.cwd;
    const persistRules = opts.persistRules !== false;
    const trackWrite = opts.trackWrite !== false;

    const trackOutsideWrite = (): void => {
      if (trackWrite && (tool === "edit" || tool === "write")) {
        trackOutsideWriteIfNeeded(ctx, tool, String(input.path ?? ""));
      }
    };

    if (decision === "allow") {
      trackOutsideWrite();
      // P4-MC-03: one-shot "Allow" on a family tool (incl. the explicit
      // ask-rule path through promptWithPermissionOptions) must reach the
      // broker mirror's cache — gate allow ⇒ mirror allow
      noteFamilyAdjudication(tool, input, "allow-once");
      return undefined;
    }
    if (
      decision === "allow_always_local" ||
      decision === "allow_always_global"
    ) {
      if (persistRules) {
        const rule = suggestAllowRuleForToolCall(tool, input, ruleCwd);
        if (
          addPermissionRule({
            rule,
            behavior: "allow",
            destination:
              decision === "allow_always_local" ? "local" : "global",
            cwd: ruleCwd,
          })
        ) {
          reloadMergedPermissionRules(ctx.cwd);
          noteFamilyAdjudication(tool, input, "rule-allow");
          if (decision === "allow_always_local") {
            warnIfLocalPermissionsNotGitignored(ruleCwd, (msg) =>
              uiNotify(ctx, msg, "warning"),
            );
          }
          uiNotify(ctx, 
            decision === "allow_always_local"
              ? `Added allow rule (project local): ${rule}`
              : `Added allow rule (global): ${rule}`,
          );
        }
      } else {
        // Rules were persisted by the other side; just pick them up.
        reloadMergedPermissionRules(ctx.cwd);
      }
      trackOutsideWrite();
      return undefined;
    }
    if (decision === "bypass") {
      await setMode("bypass", ctx);
      trackOutsideWrite();
      return undefined;
    }
    if (opts.complianceOnBlock !== false) {
      pendingComplianceInject = true;
      complianceCategory = opts.category ?? "user-prompt";
    }
    return {
      block: true,
      reason: opts.blockReason ?? `${tool} blocked by user`,
    };
  }

  // P3-PM-01: memory-dir writes skip the approval dialog (plain-file
  // memory workflow); the memory module's secret guard still runs after
  // this gate returns undefined (interception is unaffected).
  function isMemoryDirWrite(tool: string, ctx: { cwd?: string }, input: Record<string, unknown> | undefined): boolean {
    if (tool !== "write" && tool !== "edit") return false;
    const path = typeof input?.path === "string" ? input.path : "";
    if (!path) return false;
    return isMemoryWritePath(path, ctx.cwd ?? process.cwd());
  }

  async function promptWithPermissionOptions(
    ctx: ExtensionContext,
    tool: string,
    input: Record<string, unknown>,
    label: string,
    category: string,
  ): Promise<Block> {
    if (isMemoryDirWrite(tool, ctx, input)) {
      return undefined as unknown as Block; // P3-PM-01 carve-out: skip dialog
    }
    if (!ctx.hasUI) {
      const isChild = isSubagentChildProcess();
      const parent = resolveParentSessionId();
      // Only forward to a parent session when we're clearly a subagent child.
      // PI_SUBAGENT_PARENT_SESSION alone is not sufficient — it's often set in
      // the parent process env and inherited by unrelated processes (tests,
      // ad-hoc node calls), which would block forever waiting for a response
      // that never comes. Fail closed otherwise.
      if (!parent || !isChild) {
        pendingComplianceInject = true;
        complianceCategory = category;
        return {
          block: true,
          reason: `${tool} needs approval: no UI available. ${label}`,
        };
      }
      const agentDir = defaultAgentDir();
      const requesterSessionId =
        readSessionId(ctx.sessionManager) ?? "";
      const { id, challenge } = await writeForwardedRequest({
        agentDir,
        targetSessionId: parent,
        requesterSessionId,
        tool,
        label,
        category,
        cwd: ctx.cwd,
        input,
      });
      const resp = await pollForwardedResponse(agentDir, parent, id, {
        challenge,
      });
      if (!resp?.approved) {
        pendingComplianceInject = true;
        complianceCategory = category;
        return {
          block: true,
          reason:
            resp?.denialReason ??
            `${tool} blocked: parent approval timed out or denied. ${label}`,
        };
      }
      if (
        resp.decision === "allow_always_local" ||
        resp.decision === "allow_always_global"
      ) {
        return applyApprovalDecision(ctx, tool, input, resp.decision, {
          persistRules: false,
        });
      }
      return applyApprovalDecision(ctx, tool, input, "allow");
    }
    const choice = await confirmChoice(ctx, `Allow ${tool}? ${label}`, [
      "Allow",
      "Allow always (this project)",
      "Allow always (global)",
      "Block",
    ]);
    const decision: ApprovalDecision =
      choice === "Allow always (this project)"
        ? "allow_always_local"
        : choice === "Allow always (global)"
          ? "allow_always_global"
          : choice === "Allow"
            ? "allow"
            : "block";
    return applyApprovalDecision(ctx, tool, input, decision, { category });
  }

  function classifierErrorMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
  }

  function logClassifierUnavailable(err: unknown, attempt: number): void {
    const debug = process.env.PERMISSION_MODES_CLASSIFIER_DEBUG === "1";
    const message = classifierErrorMessage(err);
    const line = `[permission-modes] Classifier unavailable (${attempt}/${MAX_CLASSIFIER_FAILURES}): ${message}`;
    if (debug) {
      console.warn(line);
      if (err instanceof Error && err.stack) console.debug(err.stack);
      return;
    }
    if (attempt >= MAX_CLASSIFIER_FAILURES) {
      console.warn(line);
    }
  }

  type LocalAutoTier3Decision =
    | { allow: true }
    | { allow: false; reason: string; category: string };

  function resolveLocalAutoTier3(
    tool: string,
    input: Record<string, unknown>,
    riskInput: {
      tool: string;
      command?: string;
      path?: string;
    },
    cwd: string,
  ): LocalAutoTier3Decision {
    const risk = checkAutoRisk(riskInput, cwd);
    if (risk.match) {
      return { allow: false, reason: risk.reason, category: risk.category };
    }

    // powershell runs the bash tier ladder under bash semantics (conservative
    // approximation for PowerShell verbs — plan2 B1).
    const isKnownTier3 =
      tool === "bash" ||
      tool === "powershell" ||
      tool === "edit" ||
      tool === "write";
    if (!isKnownTier3) {
      return {
        allow: false,
        reason: `Tool "${tool}" is not auto-approved in auto mode. Enable classifier or switch to bypass.`,
        category: "unknown-tool",
      };
    }
    if (tool === "bash" || tool === "powershell") {
      const cmd = String(input.command ?? "");
      if (cmd && !isAutoFallbackBash(cmd)) {
        return {
          allow: false,
          reason: `Mutating ${tool} in auto mode: ${cmd}`,
          category: "mutating-bash",
        };
      }
    }
    return { allow: true };
  }

  function finishAutoTier3Allow(
    ctx: ExtensionContext,
    tool: string,
    input: Record<string, unknown>,
  ): undefined {
    if (tool === "edit" || tool === "write") {
      trackOutsideWriteIfNeeded(ctx, tool, String(input.path ?? ""));
    }
    return undefined;
  }

  function classifierDenyBlock(tool: string, reason: string): Block {
    return { block: true, reason: buildYoloRejectionMessage(reason) };
  }

  async function approveAutoTier3(
    ctx: ExtensionContext,
    tool: string,
    input: Record<string, unknown>,
    riskInput: {
      tool: string;
      command?: string;
      path?: string;
    },
  ): Promise<Block> {
    const reviewHint = describeTier3Review(tool, input, ctx.cwd);

    if (classifierConfig.enabled) {
      // Single visible retry layer (plan2 B2): the classifier call disables
      // SDK-level retries (maxRetries: 0) and enforces timeoutMs per attempt,
      // so the worst-case wait here is timeoutMs × MAX_CLASSIFIER_FAILURES.
      for (let attempt = 1; attempt <= MAX_CLASSIFIER_FAILURES; attempt++) {
        try {
          const verdict = await classifyToolCall({
            modelRef: classifierConfig.model,
            session: collectClassifierSessionContext(ctx, reviewHint),
            pendingTool: { name: tool, input },
            registry: ctx.modelRegistry,
            autoMode: autoModeConfig,
            timeoutMs: classifierConfig.timeoutMs,
            jsonlTranscript: classifierConfig.jsonlTranscript,
            stage: classifierConfig.stage,
            includeAgentsMd: classifierConfig.includeAgentsMd,
            signal: ctx.signal,
            debug: process.env.PERMISSION_MODES_CLASSIFIER_DEBUG === "1",
          });
          if (!verdict.allow) {
            classifierDenialState = recordClassifierDenial(classifierDenialState);
            if (shouldFallbackToPrompting(classifierDenialState)) {
              return promptWithPermissionOptions(
                ctx,
                tool,
                input,
                verdict.reason || "Blocked by auto classifier (denial limit)",
                "classifier-limit",
              );
            }
            return classifierDenyBlock(
              tool,
              verdict.reason || "Blocked by auto classifier",
            );
          }
          classifierDenialState = recordClassifierSuccess(classifierDenialState);
          return finishAutoTier3Allow(ctx, tool, input);
        } catch (err) {
          if (attempt < MAX_CLASSIFIER_FAILURES) {
            if (process.env.PERMISSION_MODES_CLASSIFIER_DEBUG === "1") {
              console.debug(
                `[permission-modes] Classifier retry (${attempt}/${MAX_CLASSIFIER_FAILURES}): ${classifierErrorMessage(err)}`,
              );
            }
            continue;
          }
          logClassifierUnavailable(err, attempt);
          if (classifierConfig.failClosed !== false) {
            return classifierDenyBlock(
              tool,
              buildClassifierUnavailableMessage(tool, classifierConfig.model),
            );
          }
          break;
        }
      }
    }

    const local = resolveLocalAutoTier3(tool, input, riskInput, ctx.cwd);
    if (!local.allow) {
      return promptWithPermissionOptions(ctx, tool, input, local.reason, local.category);
    }
    classifierDenialState = recordClassifierSuccess(classifierDenialState);
    return finishAutoTier3Allow(ctx, tool, input);
  }

  function trackOutsideWriteIfNeeded(
    ctx: ExtensionContext,
    tool: "edit" | "write",
    pathStr: string,
  ): void {
    if (!pathStr || !isOutsideCwd(pathStr, ctx.cwd)) return;
    const resolvedPath = resolveWorkspacePath(pathStr, ctx.cwd);
    let backupContent: string | null = null;
    try {
      backupContent = readFileSync(resolvedPath, "utf-8");
    } catch {
      backupContent = null;
    }
    trackOutsideWrite(ctx.cwd, {
      timestamp: new Date().toISOString(),
      originalPath: resolvedPath,
      toolName: tool,
      backupContent,
    });
    if (ctx.hasUI) {
      uiNotify(ctx, 
        `📝 tracked outside-cwd ${tool}: ${shortenPath(resolvedPath)}`,
        "info",
      );
    }
  }

  function describeTier3Review(
    tool: string,
    input: Record<string, unknown>,
    cwd: string,
  ): string {
    if (tool === "bash" || tool === "powershell") {
      const cmd = String(input.command ?? "");
      if (cmd && !isSafeCommand(cmd)) {
        return "Bash did not pass read-only allowlist; may include writes, installs, or unknown binaries.";
      }
      return "Bash requires tier-3 review.";
    }
    if (tool === "edit" || tool === "write") {
      const pathStr = String(input.path ?? "");
      if (pathStr && isOutsideCwd(pathStr, cwd)) {
        return `Write/edit outside working directory (${cwd}).`;
      }
      return "File write/edit requires tier-3 review.";
    }
    const embedded = extractEmbeddedCommandInputs(tool, input);
    if (embedded.length === 0) {
      return `Tool "${tool}" is not auto-approved without classifier.`;
    }
    return (
      `Tool "${tool}" is not auto-approved without classifier.\n` +
      `  fusion tool carries command not individually approved: ${embedded
        .map((c) => c.command)
        .join(" && ")}${fusionSchemaHint(tool)}`
    );
  }

  function collectClassifierSessionContext(
    ctx: ExtensionContext,
    reviewHint?: string,
  ): ClassifierSessionContext {
    let branch: ClassifierSessionContext["branch"] = [];
    try {
      branch = readBranchEntries(ctx.sessionManager);
    } catch {
      // classifier still runs with pending action only
    }
    const includeAgentsMd = classifierConfig.includeAgentsMd !== false;
    return {
      cwd: ctx.cwd,
      mode: currentMode,
      branch,
      reviewHint,
      agentsMd: includeAgentsMd
        ? readAgentsMdForClassifier(ctx.cwd)
        : null,
    };
  }

  // ---- tool gating -------------------------------------------------------
  function applyToolRestrictions(): void {
    if (planExecuting) {
      if (toolsBeforePlanMode !== undefined) {
        pi.setActiveTools(toolsBeforePlanMode);
        toolsBeforePlanMode = undefined;
      }
      return;
    }
    if (currentMode === "plan") {
      if (toolsBeforePlanMode === undefined)
        toolsBeforePlanMode = pi.getActiveTools();
      const kept = toolsBeforePlanMode.filter((t) => !PLAN_DISABLED.has(t));
      pi.setActiveTools([...new Set([...kept, ...PLAN_TOOLS])]);
    } else if (toolsBeforePlanMode !== undefined) {
      pi.setActiveTools(toolsBeforePlanMode);
      toolsBeforePlanMode = undefined;
    }
  }

  // ---- mode switching ----------------------------------------------------
  async function setMode(mode: Mode, ctx: ExtensionContext): Promise<void> {
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
    planExecuting = false;

    if (mode === "auto") {
      classifierDenialState = createDenialTrackingState();
      applyAutoModePermissionStrip();
    } else if (prev === "auto") {
      applyAutoModePermissionStrip();
    }

    if (mode !== "plan") {
      planPhase = "exploring";
      lastExtractedPlanHash = "";
    }
    if (mode === "plan") {
      ensurePlanFile(ctx.cwd);
      if (prev !== "plan") planPhase = "exploring";
    }

    planTodos = [];
    if (ctx.hasUI) clearPlanWidget(ctx);

    applyToolRestrictions();
    clearModesStatus(ctx);
    setBypassIndicator(mode === "bypass");
    await profiles.applyForMode(mode, ctx);
    persistState();
    publishInheritedPermissionMode(mode);
    publishCapability({ mode });
  }

  function cycleMode(ctx: ExtensionContext): void {
    const idx = MODE_CYCLE.indexOf(currentMode);
    void setMode(MODE_CYCLE[(idx + 1) % MODE_CYCLE.length], ctx);
    if (ctx.hasUI) uiNotify(ctx, `Mode: ${MODE_META[currentMode].label}`);
  }

  // ---- UI: status, footer, plan widget, working stats --------------------

  // Streaming chunks arrive while the branch is frozen (pi appends entries
  // on message_end), so per-chunk work is O(new entries), not O(session
  // length); a moved prefix (navigate/fork/switch) forces a full recompute
  // (plan A1, property-tested in branch-stats.test.ts).
  // AR1005-ST: the working-stats cache owns the snapshot + host-read
  // invalidation (cheap key: sessionManager instance + sessionId + leafId).
  const workingStats = createWorkingStats();

  /** AR1005-ST: ONE host shape for every snapshot call site — the usage
   * capability must be consistently present (a capability-less forced read
   * would mark usage fresh with no value and hide the ctx% line on later
   * cache hits). */
  function statsHost(ctx: ExtensionContext): WorkingStatsHost {
    return { sessionManager: ctx.sessionManager, getContextUsage: ctx.getContextUsage };
  }

  function computeStats(ctx: ExtensionContext): {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    cost: number;
  } {
    // AR1005-ST: the cache module owns failure handling (a failed read
    // returns the last totals and stays uncached); branchStatsState is gone.
    return workingStats.snapshot(statsHost(ctx)).stats;
  }

  /** P2-4 §4.1: the ONE derivation both representations share — the raw
   * numbers (modes.usage) and the formatted string come from the same
   * working-stats snapshot call. */
  function workingStatsEntry(ctx: ExtensionContext, opts?: { forceUsage?: boolean }): {
    stats: ReturnType<WorkingStatsCache["snapshot"]>["stats"];
    usage: ReturnType<WorkingStatsCache["snapshot"]>["usage"];
    tps: number;
  } {
    const entry = workingStats.snapshot(statsHost(ctx), opts);
    return { stats: entry.stats, usage: entry.usage, tps: lastTps };
  }

  function workingStatsParts(entry: { stats: ReturnType<WorkingStatsCache["snapshot"]>["stats"]; usage: ReturnType<WorkingStatsCache["snapshot"]>["usage"]; tps: number }): string[] {
    const s = entry.stats;
    const parts = [`↑${formatCount(s.input)}`, `↓${formatCount(s.output)}`];
    if (s.cacheRead) parts.push(`R${formatCount(s.cacheRead)}`);
    if (entry.tps > 0) parts.push(`⚡${Math.round(entry.tps)} tok/s`);
    parts.push(`$${s.cost.toFixed(3)}`);
    const usage = entry.usage;
    if (usage && usage.percent != null) {
      parts.push(`${Math.round(usage.percent)}% ctx`);
    }
    return parts;
  }

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
        planPhase: (patch as { planPhase?: PlanPhase }).planPhase ?? prev.planPhase ?? planPhase,
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

  function refreshWorkingMessage(ctx: ExtensionContext, opts?: { forceUsage?: boolean }): void {
    if (!ctx.hasUI) return;
    // DC5 flip: logic always publishes (snapshot is always-full); the
    // working-message slot write belongs to the fallback adapter, which
    // yields to a live CC-TUI at its own write point. With cctui active
    // its status row owns the working line — publishing alone is correct.
    const entry = workingStatsEntry(ctx, opts);
    const stats = workingStatsParts(entry).join(" · ");
    publishCapability({ workingStats: stats, usage: sanitizeUsageNumbers(entry.stats, entry.tps, entry.usage) });
    fallbackAdapter.onSnapshot(coreBus().snapshot());
  }

  // P0-1 §4.2: execute an ALREADY-computed permission verdict. The deny
  // branch lives in the handler (before the plan hard gate); allow / ask /
  // first-seen side-effect logic below is preserved verbatim from the old
  // applyConfiguredPermissionRules.
  async function applyPermissionVerdict(
    ctx: ExtensionContext,
    tool: string,
    input: Record<string, unknown>,
    verdict: PermissionVerdict,
  ): Promise<Block | "allow" | "passthrough"> {
    if (verdict.behavior === "allow") {
      if (tool === "edit" || tool === "write") {
        trackOutsideWriteIfNeeded(ctx, tool, String(input.path ?? ""));
      }
      // P4-MC-03: record the final allow for family-claimed tools so the
      // broker mirror's allow-chain stays in lockstep with the gate.
      noteFamilyAdjudication(
        tool,
        input,
        hasSessionGrant(matchFamily(tool, input)?.canonicalId ?? "")
          ? "session-grant"
          : "rule-allow",
      );
      return "allow";
    }
    if (verdict.behavior === "ask") {
      // P4-FAM-02 first-seen: a family claiming this tool with no explicit
      // ask rule gets the family dialog (allow once / session / always).
      const match = matchFamily(tool, input);
      if (match && !familyRuleMentions(mergedPermissionRules, match.family, match.canonicalId, "ask")) {
        return firstSeenPrompt(ctx, match.canonicalId, tool, input, match.family.suggestAllowRule(match.canonicalId));
      }
      return promptWithPermissionOptions(
        ctx,
        tool,
        input,
        `permission rule requires approval: ${verdict.rule}`,
        "permission-ask",
      );
    }
    return "passthrough";
  }

  // P4-FAM-02/05: the first-seen dialog for family-claimed tools.
  async function firstSeenPrompt(
    ctx: ExtensionContext,
    canonicalId: string,
    tool: string,
    input: Record<string, unknown>,
    suggestedRule: string,
  ): Promise<Block> {
    if (!ctx.hasUI) {
      // headless/forwarded path: fail closed (unchanged from 2.8.0)
      return {
        block: true,
        reason: `${tool} (${canonicalId}) needs approval: no UI available.`,
      };
    }
    const choice = (await confirmChoice(ctx, `Allow ${canonicalId}?`, [
      "Allow once",
      "Allow for this session",
      `Allow always (${suggestedRule})`,
      "Block",
    ])) ?? "Block";
    if (choice === "Allow once") {
      noteAdjudicated(canonicalId, "allow-once");
      return undefined as unknown as Block; // this call passes; nothing recorded
    }
    if (choice === "Allow for this session") {
      grantSession(canonicalId);
      noteAdjudicated(canonicalId, "session-grant");
      return undefined as unknown as Block;
    }
    if (choice.startsWith("Allow always")) {
      const wrote = addPermissionRule({
        rule: suggestedRule,
        behavior: "allow",
        destination: "global",
        cwd: ctx.cwd,
      });
      if (!wrote) {
        return { block: true, reason: `failed to persist rule ${suggestedRule}` };
      }
      noteAdjudicated(canonicalId, "rule-allow");
      reloadMergedPermissionRules(ctx.cwd);
      return undefined as unknown as Block;
    }
    return { block: true, reason: `${canonicalId} blocked by user` };
  }

  // ---- prompts -----------------------------------------------------------
  async function promptApproval(
    ctx: ExtensionContext,
    tool: string,
    label: string,
    input: Record<string, unknown> = {},
  ): Promise<Block> {
    return promptWithPermissionOptions(ctx, tool, input, label, "user-prompt");
  }

  // ---- commands / shortcut / flag ---------------------------------------
  for (const mode of ["ask", "plan", "auto", "bypass"] as Mode[]) {
    pi.registerCommand(mode, {
      description: `Switch to ${MODE_META[mode].label} mode`,
      handler: async (_args, ctx) => setMode(mode, ctx),
    });
  }

  pi.registerCommand("permissions", {
    description:
      "List merged permission rules (allow/deny/ask) from global + project config",
    handler: async (_args, ctx) => {
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

  pi.registerCommand("plan-execute", {
    description:
      "Execute the current plan immediately (switches to auto mode with step tracking)",
    handler: async (_args, ctx) => {
      if (currentMode !== "plan" && !planExecuting) {
        uiNotify(ctx, "Not in plan mode. Use /plan first.", "warning");
        return;
      }
      const planContent = readPlanFile(ctx.cwd);
      const extracted = filterSubstantivePlanItems(
        planContent ? extractTodoItems(planContent) : [],
      );
      if (!extracted.length) {
        uiNotify(ctx, "No plan steps found in plan.md. Write a plan first.", "warning");
        return;
      }
      planExecuting = true;
      planPhase = "executing";
      planTodos = extracted;
      currentMode = "auto";
      applyToolRestrictions();
      clearModesStatus(ctx);
      updatePlanWidgetUi(ctx, planTodos);
      persistState();
      await profiles.applyForMode("auto", ctx);
      const steps = planTodos.map((t) => `${t.step}. ${t.text}`).join("\n");
      pi.sendMessage(
        {
          customType: "modes-execute",
          content: `Execute the plan now. Steps:\n${steps}\n\nStart with step 1. After finishing each step, include a [DONE:n] tag in your reply.`,
          display: true,
        },
        { triggerTurn: true, deliverAs: "followUp" },
      );
    },
  });

  // ---- plan approval helpers ---------------------------------------------
  function markPlanOfferHandled(planContent: string): void {
    lastPlanOfferAt = Date.now();
    // Keep agent_end from immediately re-opening the same plan dialog after Stay/Esc.
    suppressPlanOfferUntil = Date.now() + PLAN_OFFER_COOLDOWN_MS;
    if (planContent) {
      lastExtractedPlanHash = hashPlan(planContent);
    }
  }

  async function promptPlanRefinement(ctx: ExtensionContext): Promise<void> {
    if (!ctx.hasUI) return;
    planPhase = "refining";
    const refinement = await ctx.ui.editor("Refine the plan:", "");
    if (refinement?.trim()) {
      pi.sendUserMessage(refinement.trim(), { deliverAs: "followUp" });
    }
  }

  function planReviewClosedToolResult() {
    return {
      content: [
        {
          type: "text" as const,
          text: "Plan review closed. Wait for the user's next message; do not continue on your own.",
        },
      ],
      terminate: true as const,
      details: undefined,
    };
  }

  // ---- plan_ready tool (model-initiated plan submission) -------------------
  const PLAN_READY_TOOL_NAME = "plan_ready";

  pi.registerTool(defineTool({
    name: PLAN_READY_TOOL_NAME,
    label: "Plan Ready",
    description:
      "Submit the completed plan to the user for approval. Only available in plan mode. The user will see the plan and choose to execute, refine, or stay in plan mode.",
    promptSnippet:
      "Call plan_ready when your plan in plan.md is complete and ready for user review.",
    promptGuidelines: [
      "Only call plan_ready when you have finished exploring and the plan file contains a concrete, numbered implementation plan.",
      "Do NOT call plan_ready if the plan still has open questions or incomplete sections.",
      "After calling plan_ready, stop and wait for the user's decision. Do not begin implementation.",
      "If the user asks to refine, update plan.md and call plan_ready again when ready.",
    ],
    parameters: Type.Object({
      summary: Type.Optional(
        Type.String({ description: "Brief one-line summary of the plan for the approval dialog." }),
      ),
    }),
    executionMode: "sequential",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (currentMode !== "plan") {
        return {
          content: [{ type: "text", text: "plan_ready is only available in plan mode. Current mode: " + currentMode }],
          details: undefined,
        };
      }
      const planContent = readPlanFile(ctx.cwd);
      const extracted = filterSubstantivePlanItems(
        planContent ? extractTodoItems(planContent) : [],
      );
      if (!extracted.length) {
        return {
          content: [{ type: "text", text: "No plan steps found in plan.md. Write a numbered plan first, then call plan_ready." }],
          details: undefined,
        };
      }

      planTodos = extracted;
      persistState();
      updatePlanWidgetUi(ctx, planTodos);

      const summary = params.summary?.trim() || undefined;
      const stepsPreview = extracted.map((t) => `${t.step}. ${t.text}`).join("\n");

      if (!ctx.hasUI) {
        // Headless: auto-execute
        const summaryLine = summary ? `${summary}\n\n` : "";
        return {
          content: [{ type: "text", text: `Plan submitted (headless auto-execute).\n${summaryLine}${stepsPreview}` }],
          details: undefined,
        };
      }

      // Suppress agent_end re-offer while this dialog is open and after dismiss.
      markPlanOfferHandled(planContent ?? "");
      const choice = await runPlanApprovalDialog(ctx, {
        summary,
        planContent: planContent ?? "",
        stepCount: extracted.length,
      });
      markPlanOfferHandled(planContent ?? "");

      if (choice === "execute") {
        planExecuting = true;
        planPhase = "executing";
        currentMode = "auto";
        applyToolRestrictions();
        clearModesStatus(ctx);
        persistState();
        await profiles.applyForMode("auto", ctx);
        const steps = planTodos.map((t) => `${t.step}. ${t.text}`).join("\n");
        pi.sendMessage(
          {
            customType: "modes-execute",
            content: `Execute the plan now. Steps:\n${steps}\n\nStart with step 1. After finishing each step, include a [DONE:n] tag in your reply.`,
            display: true,
          },
          { triggerTurn: true, deliverAs: "followUp" },
        );
        return {
          content: [{ type: "text", text: "Plan approved by user. Switching to execution mode." }],
          terminate: true,
          details: undefined,
        };
      }

      if (choice === "refine") {
        await promptPlanRefinement(ctx);
        return planReviewClosedToolResult();
      }

      // stay | cancel (Esc): one dismiss returns to the input prompt.
      return planReviewClosedToolResult();
    },
    renderCall(args, theme) {
      return new Text(
        theme.fg("toolTitle", "plan_ready ") + theme.fg("muted", truncateToWidth(String(args?.summary ?? ""), 60)),
        0, 0,
      );
    },
    renderResult(result, _options, theme) {
      const first = result.content?.find((c: any) => c.type === "text") as
        | { text?: string }
        | undefined;
      return new Text(theme.fg("muted", truncateToWidth(String(first?.text ?? ""), 80)), 0, 0);
    },
  }));

  // ---- /outside-writes + /undo-outside-writes (NEW v1.1.3) --------------
  // Format a snapshot for display in lists/selectors.
  function formatSnapshotForDisplay(
    snap: OutsideWriteSnapshot,
    externallyModified = false,
  ): string {
    const ts = snap.timestamp.replace("T", " ").slice(0, 19);
    const action = snap.backupContent === null ? "would delete" : "would restore";
    const flag = externallyModified ? " \u26a0 externally modified" : "";
    return `${ts} \u00b7 ${snap.toolName} \u00b7 ${snap.originalPath} (${action})${flag}`;
  }

  // Detect if a file has been externally modified since its snapshot was taken.
  // Heuristic: if multiple snapshots exist for the same path, OR the current
  // file content differs from the snapshot's backupContent, the file is
  // considered externally modified.
  function isExternallyModified(
    snap: OutsideWriteSnapshot,
    allSnaps: OutsideWriteSnapshot[],
  ): boolean {
    const samePath = allSnaps.filter((s) => s.originalPath === snap.originalPath);
    if (samePath.length > 1) return true;
    try {
      const current = readFileSync(snap.originalPath, "utf-8");
      return current !== snap.backupContent;
    } catch {
      return false;
    }
  }

  pi.registerCommand("outside-writes", {
    description:
      "List tracked outside-cwd writes from auto mode (read-only; does not undo)",
    handler: async (_args, ctx) => {
      const snaps = listTrackedOutsideWrites(ctx.cwd);
      if (!snaps.length) {
        if (ctx.hasUI) uiNotify(ctx, "No tracked outside-cwd writes", "info");
        return;
      }
      const lines = snaps.map((s) => formatSnapshotForDisplay(s, isExternallyModified(s, snaps)));
      pi.sendMessage(
        {
          customType: "outside-writes-list",
          content: `Tracked outside-cwd writes (${snaps.length}):\n${lines.join("\n")}`,
          display: true,
        },
        { triggerTurn: false },
      );
    },
  });

  pi.registerCommand("undo-outside-writes", {
    description:
      "Restore files modified by auto mode outside cwd. No args = selector; 'all' = restore all; '--list' = list only",
    handler: async (args, ctx) => {
      const arg = (args ?? "").trim();

      // --list: alias for /outside-writes
      if (arg === "--list" || arg === "list") {
        const snaps = listTrackedOutsideWrites(ctx.cwd);
        if (!snaps.length) {
          if (ctx.hasUI) uiNotify(ctx, "No tracked outside-cwd writes", "info");
          return;
        }
        const lines = snaps.map((s) => formatSnapshotForDisplay(s, isExternallyModified(s, snaps)));
        pi.sendMessage(
          {
            customType: "outside-writes-list",
            content: `Tracked outside-cwd writes (${snaps.length}):\n${lines.join("\n")}`,
            display: true,
          },
          { triggerTurn: false },
        );
        return;
      }

      const allSnaps = listTrackedOutsideWrites(ctx.cwd);
      if (!allSnaps.length) {
        if (ctx.hasUI)
          uiNotify(ctx, "No tracked outside-cwd writes to undo", "info");
        return;
      }

      if (arg === "all") {
        // Restore all without prompting
        let restored = 0;
        let deleted = 0;
        let warned = 0;
        const externallyModifiedPaths = new Set(
          allSnaps
            .filter((s) => isExternallyModified(s, allSnaps))
            .map((s) => s.originalPath),
        );
        for (const snap of allSnaps) {
          const result = restoreOutsideWrite(snap);
          if (result.action === "restored") restored++;
          else if (result.action === "deleted") deleted++;
          if (externallyModifiedPaths.has(snap.originalPath)) warned++;
          popTrackedOutsideWrite(ctx.cwd, snap);
        }
        if (ctx.hasUI) {
          const warnMsg =
            warned > 0
              ? ` (${warned} file(s) externally modified \u2014 restored anyway)`
              : "";
          uiNotify(ctx, 
            `Restored ${restored}, deleted ${deleted} tracked write(s)${warnMsg}`,
            "info",
          );
        }
        return;
      }

      // No args: interactive selector (newest first)
      if (!ctx.hasUI) {
        if (ctx.hasUI)
          uiNotify(ctx, 
            "No UI available; pass 'all' or '--list' as argument",
            "warning",
          );
        return;
      }
      const ordered = [...allSnaps].reverse();
      const choice = await ctx.ui.select(
        "Restore which tracked outside-cwd write? (newest first)",
        ordered.map((s) =>
          formatSnapshotForDisplay(s, isExternallyModified(s, allSnaps)),
        ),
      );
      if (!choice) return;
      const picked = ordered.find(
        (s) =>
          formatSnapshotForDisplay(s, isExternallyModified(s, allSnaps)) === choice,
      );
      if (!picked) return;
      const wasExternal = isExternallyModified(picked, allSnaps);
      const result = restoreOutsideWrite(picked);
      popTrackedOutsideWrite(ctx.cwd, picked);
      const action = result.action === "deleted" ? "Deleted" : "Restored";
      const warnSuffix = wasExternal
        ? " (\u26a0 file was externally modified \u2014 restored from snapshot anyway)"
        : "";
      uiNotify(ctx, `${action} ${picked.originalPath}${warnSuffix}`, "info");
    },
  });


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


  /** Simple glob-style pattern matching for autoMode.allow / soft_deny rules. */
  function matchAutoModePattern(command: string, pattern: string): boolean {
    const trimmed = command.trim();
    const p = pattern.trim();
    if (trimmed === p) return true;
    if (p.endsWith("*")) {
      const prefix = p.slice(0, -1).trim();
      return trimmed.startsWith(prefix);
    }
    return trimmed.includes(p);
  }

  function allowToolCall(): undefined {
    if (currentMode === "auto") {
      classifierDenialState = recordClassifierSuccess(classifierDenialState);
    }
    return undefined;
  }

  // plan2 B1 ②: one-shot annotation from session_start — tool schemas that
  // declare command-shaped fields (fusion-capable tools). Label-only source
  // hint; no behavior branches on this data.
  let fusionToolSchemaFields = new Map<string, string[]>();

  function fusionSchemaHint(toolName: string): string {
    const fields = fusionToolSchemaFields.get(toolName);
    return fields?.length
      ? `\n  (tool schema declares command fields: ${fields.join(", ")})`
      : "";
  }

  function scanFusionToolSchemas(): void {
    const found = new Map<string, string[]>();
    try {
      for (const info of pi.getAllTools?.() ?? []) {
        if (!info?.name) continue;
        // bash/powershell's own `command` IS the primary input, not embedded.
        if (info.name === "bash" || info.name === "powershell") continue;
        const fields = declaredCommandFields(info.parameters);
        if (fields.length > 0) found.set(info.name, fields);
      }
      fusionToolSchemaFields = found;
    } catch {
      fusionToolSchemaFields = new Map();
    }
  }

  // ---- tool_call gate ----------------------------------------------------
  pi.on("tool_call", async (event, ctx): Promise<Block> => {
    const tool = event.toolName;
    const input = (event.input ?? {}) as Record<string, unknown>;

    // BYPASS: approve everything; still track outside-cwd writes for undo.
    // Kept ahead of the plan-file probe: bypass never reads the plan file
    // and the probe does per-call FS I/O (plan A2).
    if (currentMode === "bypass") {
      if (tool === "edit" || tool === "write") {
        trackOutsideWriteIfNeeded(ctx, tool, String(input.path ?? ""));
      }
      return undefined;
    }

    const planFilePath = getPlanFilePath(ctx.cwd);

    // P0-1 §4.1 precedence (plan): 1. rule deny → block; 2. plan hard limits
    // (plan-gate.ts — allow/ask rules can never unlock them, no prompt here);
    // 3. ask verdict → prompt/forward, result HONORED (D1); 4. allow verdict;
    // 5. passthrough → plan allowlist dispatch. The old reason-text prefix
    // sniffing ("Denied by permission rule") is gone.
    const verdict = evaluateToolPermission(
      tool,
      input,
      ctx.cwd,
      mergedPermissionRules,
    );
    if (verdict.behavior === "deny") {
      return {
        block: true,
        reason: `Denied by permission rule [${verdict.source}]: ${verdict.rule}`,
      };
    }
    if (currentMode === "plan") {
      const hard = planHardBlock(tool, input, {
        planFilePath,
        isPlanFile: isPlanFilePath(String(input.path ?? ""), ctx.cwd),
        mcpShaped: isMcpShapedCall(tool, input, knownServersSetFromEnv()),
        familyClaimed: matchFamily(tool, input) !== null,
        fusionSchemaHint: fusionSchemaHint(tool),
      });
      if (hard) return hard;
    }

    const permResult = await applyPermissionVerdict(ctx, tool, input, verdict);
    if (permResult === "allow") return allowToolCall();
    if (permResult !== "passthrough") return permResult;

    // plan2 B1: embedded-command gate. Fusion tools (e.g. SoL-Pi Action
    // Fusion) carry shell commands in non-primary input fields; those never
    // reach the bash dispatch, so vet them here — BEFORE mode dispatch, by
    // FIELD SCAN, not by tool name (overrides may reuse built-in names).
    // Lazy by construction: field-less inputs (unknown tools included) are
    // untouched; the shell tools' own primary `command` is excluded because
    // the full ladder below already governs it. Plan's copy of this scan
    // moved into plan-gate.ts (P0-1) — family-governed MCP calls are exempt
    // there, so they must NOT fall back into this generic scan.
    const embeddedCommands = extractEmbeddedCommandInputs(tool, input);
    if (embeddedCommands.length > 0) {
      const hint = fusionSchemaHint(tool);
      if (currentMode === "auto") {
        for (const { command } of embeddedCommands) {
          if (commandReferencesSensitivePath(command)) {
            return promptWithPermissionOptions(
              ctx,
              tool,
              input,
              `sensitive path in command: ${command}${hint}`,
              "sensitive-path",
            );
          }
          const tiers = classifyBashTiers(command);
          if (!tiers.safe && !tiers.autoApprovable) {
            return promptWithPermissionOptions(
              ctx,
              tool,
              input,
              describeTier3Review(tool, input, ctx.cwd),
              "fusion-command",
            );
          }
        }
        // every embedded command individually tier-1/2 — normal auto dispatch
        // still runs (path checks for edit/write; unknown names keep their
        // tier-3 review)
      } else if (currentMode === "ask") {
        const offender = embeddedCommands.find((c) => !isSafeCommand(c.command));
        if (offender) {
          return promptApproval(
            ctx,
            tool,
            `${embeddedCommands.map((c) => `"${c.command}"`).join(", ")}${hint}`,
            input,
          );
        }
        // all read-only-safe — fall through, like safe bash in ask
      }
    }

    // PLAN EXECUTION: use auto-mode tiered gate (classifier + blacklist).
    // planExecuting only affects prompt injection and UI; it does not bypass auto.

    // PLAN dispatch: the hard limits already ran before verdict execution
    // (P0-1 §4.1); what remains is the allowlist — read tools, tool_search,
    // default pass for plan-legal calls.
    if (currentMode === "plan") {
      if (PLAN_READ_TOOLS.has(tool)) {
        return undefined;
      }
      // META-01 (SPEC 0.99 adaptation): retrieval only — loads declarations,
      // executes nothing.
      if (tool === "tool_search") {
        return undefined;
      }
      return undefined;
    }

    // AUTO: tiered gate with optional classifier + user prompts for risky ops
    if (currentMode === "auto") {
      // META-03: retrieval-only meta tool passes like the read tier.
      if (tool === "tool_search") {
        return undefined;
      }
      if (tool === "read" || tool === "grep" || tool === "find" || tool === "ls") {
        const pathStr = String(input.path ?? "");
        if (pathStr && isSensitivePath(pathStr, ctx.cwd)) {
          return promptWithPermissionOptions(
            ctx,
            tool,
            input,
            `sensitive path "${pathStr}"`,
            "sensitive-path",
          );
        }
        return allowToolCall();
      }

      if (tool === "edit" || tool === "write") {
        const pathStr = String(input.path ?? "");
        if (pathStr && isSensitivePath(pathStr, ctx.cwd)) {
          return promptWithPermissionOptions(
            ctx,
            tool,
            input,
            `sensitive path "${pathStr}"`,
            "sensitive-path",
          );
        }
        if (!pathStr || !isOutsideCwd(pathStr, ctx.cwd)) {
          return allowToolCall();
        }
      }

      if (tool === "bash" || tool === "powershell") {
        const cmd = String(input.command ?? "");
        if (cmd && commandReferencesSensitivePath(cmd)) {
          return promptWithPermissionOptions(
            ctx,
            tool,
            input,
            `sensitive path in command: ${cmd}`,
            "sensitive-path",
          );
        }
        // Tier 1 / Tier 2 verdicts share one splitShellSegments pass (plan A4).
        const tiers = cmd ? classifyBashTiers(cmd) : undefined;
        // Tier 1: read-only bash auto-approves.
        if (tiers?.safe) {
          return allowToolCall();
        }
        // Tier 1.5: autoMode.allow user rules short-circuit before classifier.
        // Guard: compound commands (&&, ||, ;) must have ALL segments safe,
        // preventing "npm install && rm -rf /" from being allowed by a "npm" rule.
        if (cmd && autoModeConfig?.allow?.length) {
          if (autoModeConfig.allow.some((p) => matchAutoModePattern(cmd, p))) {
            if (tiers?.autoApprovable) {
              return allowToolCall();
            }
            // Pattern matched but command has dangerous segments → fall through
          }
        }
        // Tier 1.5b: autoMode.soft_deny forces a prompt.
        if (cmd && autoModeConfig?.soft_deny?.length) {
          if (autoModeConfig.soft_deny.some((p) => matchAutoModePattern(cmd, p))) {
            return promptWithPermissionOptions(ctx, tool, input, "matched autoMode.soft_deny", "auto-deny");
          }
        }
        // Tier 2: common dev workflow commands auto-approve without classifier.
        if (tiers?.autoApprovable) {
          return allowToolCall();
        }
      }

      return approveAutoTier3(ctx, tool, input, {
        tool,
        command:
          tool === "bash" || tool === "powershell"
            ? String(input.command ?? "")
            : undefined,
        path:
          tool === "edit" || tool === "write"
            ? String(input.path ?? "")
            : undefined,
      });
    }

    // ASK: prompt on edit/write; prompt on read outside cwd; mutating bash prompts.
    if (currentMode === "ask") {
      if (tool === "read" || tool === "grep" || tool === "find" || tool === "ls") {
        const pathStr = String(input.path ?? "");
        if (pathStr && isOutsideCwd(pathStr, ctx.cwd)) {
          return promptApproval(
            ctx,
            tool,
            `outside cwd on "${pathStr}"`,
            input,
          );
        }
        return undefined;
      }
      if (tool === "edit" || tool === "write") {
        // P3-PM-01: memory-dir writes skip the dialog (secret guard in the
        // memory module still runs after this returns undefined)
        if (isMemoryDirWrite(tool, ctx, input)) return undefined;
        const pathVal = String(input.path ?? "(unknown)");
        if (!ctx.hasUI) {
          return promptApproval(ctx, tool, `on ${pathVal}`, input);
        }
        // The bypass switch stays ask-mode-only (CC-aligned, adjudicated
        // 2026-09-12); side effects route through the shared executor.
        const choice = await confirmChoice(ctx, `Allow ${tool} on ${pathVal}?`, [
          "Allow",
          "Allow always (this project)",
          "Allow always (global)",
          "Allow all (enable bypass)",
          "Block",
        ]);
        const decision: ApprovalDecision =
          choice === "Allow always (this project)"
            ? "allow_always_local"
            : choice === "Allow always (global)"
              ? "allow_always_global"
              : choice === "Allow all (enable bypass)"
                ? "bypass"
                : choice === "Allow"
                  ? "allow"
                  : "block";
        return applyApprovalDecision(ctx, tool, input, decision, {
          complianceOnBlock: false,
          blockReason: `${tool} blocked by user on ${pathVal}`,
        });
      }
      if (tool === "bash" || tool === "powershell") {
        const cmd = String(input.command ?? "");
        if (isSafeCommand(cmd)) return undefined;
        return promptApproval(ctx, tool, `"${cmd}"`, input);
      }
      return undefined;
    }

    return undefined;
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

    if (planExecuting && planTodos.length) {
      const remaining = planTodos
        .filter((t) => !t.completed)
        .map((t) => `${t.step}. ${t.text}`)
        .join("\n");
      modeBlock = `[Plan/executing] Execute steps from plan.md. Remaining:\n${remaining}\nMark progress with [DONE:n] tags.`;
      planPhase = "executing";
      if (complianceBlock) modeBlock = `${modeBlock}\n${complianceBlock}`;
    } else {
      const planPath =
        currentMode === "plan" ? shortenPath(ensurePlanFile(ctx.cwd)) : undefined;
      modeBlock = resolveModePrompt({
        mode: currentMode,
        planPhase,
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
    streamStart = Date.now();
    // AR1005-ST: ONE forced read feeds both the TPS baseline and the
    // display (the refresh that follows is cache-hot — zero extra reads).
    outputAtStart = workingStats.snapshot(statsHost(ctx), { force: true }).stats.output;
    refreshWorkingMessage(ctx);
  });
  pi.on("before_provider_request", async (_event, ctx) =>
    // ST: force ONE context-usage refresh; the branch sum reuses the cache
    // (no unconditional re-sum of an unchanged branch).
    refreshWorkingMessage(ctx, { forceUsage: true }),
  );
  pi.on("message_update", async (_event, ctx) => refreshWorkingMessage(ctx));
  pi.on("message_end", async (_event, _ctx) => {
    // ST: fired BEFORE the host appends the entry — the cached snapshot must
    // not be mistaken for the new branch state (the leafId key also moves).
    workingStats.markDirty();
  });
  pi.on("model_select", async (_event, _ctx) => {
    // ST: observable model change invalidates the usage snapshot.
    workingStats.onModelChange();
  });

  // ---- turn_end: tps + plan-step tracking --------------------------------
  pi.on("turn_end", async (event, ctx) => {
    try {
      gitBranch = readGitBranch(ctx.sessionManager) ?? gitBranch;
    } catch {
      /* ignore */
    }

    // ST: ONE forced committed-final read feeds the TPS math AND the
    // display refresh (the old handler read the branch twice per turn_end).
    const stats = workingStats.snapshot(statsHost(ctx), { force: true }).stats;
    const elapsed = Math.max((Date.now() - streamStart) / 1000, 0.001);
    const delta = stats.output - outputAtStart;
    if (delta > 0) lastTps = delta / elapsed;
    refreshWorkingMessage(ctx);

    const msg = event.message;
    if (!isAssistant(msg)) return;
    const text = getText(msg);

    if (planExecuting && planTodos.length) {
      if (markCompletedSteps(text, planTodos) > 0) updatePlanWidgetUi(ctx, planTodos);
      persistState();
    }
  });

  // ---- agent_end: idle reset + plan complete + plan offer ----------------
  pi.on("agent_end", async (event, ctx) => {
    if (ctx.hasUI) ctx.ui.setWorkingMessage();

    // Plan execution in progress: announce completion when all steps are done.
    if (planExecuting && planTodos.length) {
      if (planTodos.every((t) => t.completed)) {
        if (ctx.hasUI) {
          pi.sendMessage(
            {
              customType: "plan-complete",
              content: "**Plan Complete!** ✓",
              display: true,
            },
            { triggerTurn: false },
          );
          clearPlanWidget(ctx);
        }
        planExecuting = false;
        planTodos = [];
        persistState();
      }
      return;
    }

    // In plan mode: sync plan.md and offer next action (throttled).
    if (currentMode !== "plan" || !ctx.hasUI || planExecuting) return;

    const planContent = readPlanFile(ctx.cwd);
    let extracted = filterSubstantivePlanItems(
      planContent ? extractTodoItems(planContent) : [],
    );

    const lastAssistant = [...event.messages].reverse().find(isAssistant);
    const assistantText = lastAssistant ? getText(lastAssistant) : "";
    const assistantPlan = assistantText
      ? filterSubstantivePlanItems(extractTodoItems(assistantText))
      : [];

    if (!extracted.length && assistantPlan.length) {
      if (shouldSyncAssistantPlanToFile(planContent)) {
        const planSection = extractPlanSection(assistantText);
        if (planSection) writePlanFile(ctx.cwd, planSection);
        extracted = assistantPlan;
      }
    } else if (assistantPlan.length) {
      if (shouldSyncAssistantPlanToFile(planContent)) {
        const assistantSection = extractPlanSection(assistantText);
        if (assistantSection) writePlanFile(ctx.cwd, assistantSection);
        extracted = assistantPlan;
      }
    }

    if (!extracted.length) return;

    // Cooldown / Stay dismiss: don't re-offer within 60s of the last offer.
    if (Date.now() - lastPlanOfferAt < PLAN_OFFER_COOLDOWN_MS) return;
    if (Date.now() < suppressPlanOfferUntil) return;

    const syncedContent = readPlanFile(ctx.cwd) ?? planContent ?? "";
    const contentHash = hashPlan(
      syncedContent || JSON.stringify(extracted),
    );
    const isFirst = !lastExtractedPlanHash;
    const changed = contentHash !== lastExtractedPlanHash;
    if (!isFirst && !changed) return;

    planTodos = extracted;
    persistState();

    // Mark before await so a concurrent agent_end cannot open a second dialog.
    markPlanOfferHandled(syncedContent || JSON.stringify(extracted));
    const choice = await runPlanApprovalDialog(ctx, {
      planContent: syncedContent,
      stepCount: extracted.length,
    });
    markPlanOfferHandled(syncedContent || JSON.stringify(extracted));

    if (choice === "execute") {
      planExecuting = true;
      planPhase = "executing";
      currentMode = "auto";
      applyToolRestrictions();
      clearModesStatus(ctx);
      updatePlanWidgetUi(ctx, planTodos);
      persistState();
      await profiles.applyForMode("auto", ctx);
      const steps = planTodos.map((t) => `${t.step}. ${t.text}`).join("\n");
      pi.sendMessage(
        {
          customType: "modes-execute",
          content: `Execute the plan now. Steps:\n${steps}\n\nStart with step 1. After finishing each step, include a [DONE:n] tag in your reply.`,
          display: true,
        },
        { triggerTurn: true, deliverAs: "followUp" },
      );
    } else if (choice === "refine") {
      await promptPlanRefinement(ctx);
    }
    // stay | cancel (Esc): dialog already closed; return silently to the input prompt.
  });

  pi.on("session_compact", async (_event, ctx) => {
    workingStats.invalidate(); // ST: compaction rewrites the branch
    if (currentMode === "bypass") {
      needsBypassSecurityReminder = true;
    }
    persistState();
  });

  // ---- session start / resume -------------------------------------------
  async function onSessionStart(
    _event: unknown,
    ctx: ExtensionContext,
  ): Promise<void> {
    // plan2 B1 ②: enumerate tool schemas once per session (reload re-runs).
    scanFusionToolSchemas();

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
        if (typeof last.planPhase === "string")
          planPhase = last.planPhase as PlanPhase;
        if (typeof last.planExecuting === "boolean")
          planExecuting = last.planExecuting;
        if (Array.isArray(last.planTodos))
          planTodos = last.planTodos as TodoItem[];
        if (typeof last.lastExtractedPlanHash === "string")
          lastExtractedPlanHash = last.lastExtractedPlanHash;
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
      classifierDenialState = createDenialTrackingState();
    }
    reloadMergedPermissionRules(ctx.cwd);

    try {
      gitBranch = readGitBranch(ctx.sessionManager) ?? "";
    } catch {
      /* ignore */
    }

    // Cache the project root once per session.
    if (projectRoot === null) {
      try {
        projectRoot = findProjectRoot(ctx.cwd);
      } catch {
        projectRoot = null;
      }
    }

    applyToolRestrictions();
    if (planExecuting && planTodos.length) updatePlanWidgetUi(ctx, planTodos);
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

    startPermissionForwardingPoller(ctx);
  }

  async function handleForwardedPermissionRequest(
    ctx: ExtensionContext,
    request: ForwardedPermissionRequest,
  ): Promise<void> {
    const agentDir = defaultAgentDir();
    const name = request.requesterAgentName?.trim();
    const title = name
      ? `[Subagent ${name}] ${request.message}`
      : `[Subagent] ${request.message}`;
    const sessionId = readSessionId(ctx.sessionManager);
    // Only the targeted parent session may answer; reject mismatched inbox drain.
    if (sessionId && sessionId !== request.targetSessionId) {
      forwardingClaimedIds.delete(request.id);
      return;
    }
    const responderSessionId = request.targetSessionId;

    let decision: ForwardedDecision = "block";
    let approved = false;
    let denialReason: string | undefined = `${request.tool} blocked by user`;

    try {
      const choice = await ctx.ui.select(title, [
        "Allow",
        "Allow always (this project)",
        "Allow always (global)",
        "Block",
      ]);
      if (choice === "Allow") {
        decision = "allow";
        approved = true;
        denialReason = undefined;
      } else if (choice === "Allow always (this project)") {
        decision = "allow_always_local";
        approved = true;
        denialReason = undefined;
        await applyApprovalDecision(ctx, request.tool, request.input, "allow_always_local", {
          ruleCwd: request.cwd,
          trackWrite: false,
        });
      } else if (choice === "Allow always (global)") {
        decision = "allow_always_global";
        approved = true;
        denialReason = undefined;
        await applyApprovalDecision(ctx, request.tool, request.input, "allow_always_global", {
          ruleCwd: request.cwd,
          trackWrite: false,
        });
      }
    } catch {
      decision = "block";
      approved = false;
      denialReason = `${request.tool} blocked: parent approval cancelled`;
    }

    await writeForwardedResponse(agentDir, request.targetSessionId, {
      id: request.id,
      challenge: request.challenge,
      approved,
      decision,
      responderSessionId,
      respondedAt: new Date().toISOString(),
      ...(denialReason ? { denialReason } : {}),
    });
  }

  function startPermissionForwardingPoller(ctx: ExtensionContext): void {
    forwardingPoller?.stop();
    forwardingPoller = undefined;
    if (!ctx.hasUI || isSubagentChildProcess()) return;

    const agentDir = defaultAgentDir();
    forwardingPoller = createForwardingPoller({
      agentDir,
      hasUI: true,
      isChild: false,
      claimedIds: forwardingClaimedIds,
      getSessionId: () => readSessionId(ctx.sessionManager),
      onRequest: (request) => handleForwardedPermissionRequest(ctx, request),
    });
    forwardingPoller.start();
  }

  pi.on("session_start", onSessionStart);
  pi.on("session_tree", onSessionStart);
  pi.on("session_start", () => {
    workingStats.reset(); // ST: re-base on (re)load
    publishCapability({ usage: null }); // XPKG-08: old-session numbers never leak into a new one
  });
  pi.on("session_tree", () => {
    workingStats.reset();
    publishCapability({ usage: null });
  });
  pi.on("session_start", (_event, ctx: ExtensionContext) => {
    // P4-FAM-05: session-scoped authorizations reset on (re)load
    clearSessionState();
    setBypassIndicator(pi.getFlag("permission-mode") === "bypass");
    void ctx;
  });
  pi.on("session_shutdown", () => {
    workingStats.reset(); // ST: clear the private cache (legacy keys unaffected)
    publishCapability({ usage: null }); // XPKG-08: shutdown clears the published numbers
    fallbackAdapter.shutdown();
    forwardingPoller?.stop();
    forwardingPoller = undefined;
    forwardingClaimedIds.clear();
    // P4-FAM-05: session-scoped family state resets on shutdown too
    clearSessionState();
  });
}
