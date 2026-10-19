/**
 * modes/auto-engine.ts — [C4 batch 2] the auto-mode tier-3 engine, extracted
 * verbatim from the extension factory (index.ts): local tier-3 ladder,
 * classifier invocation + denial accounting, tier-3 review descriptions and
 * the classifier session-context assembly. The engine OWNS the denial
 * tracking state (created fresh on load; reset by setMode / session_start).
 *
 * Design (architecture review 2026-10-18, C4): the adjudicator's gate and
 * its interpret ports stay in index.ts — they reach the engine through the
 * returned surface (approveTier3 / noteAllowed / resetDenialState /
 * trackOutsideWriteIfNeeded). Injected deps are the narrow cross-domain
 * facts only: config getters, current mode, and the approval-prompt /
 * notify / outside-write entries the engine calls back into.
 *
 * Behavior is unchanged from the pre-extraction factory closures (C4: pure
 * relocation — MAX_CLASSIFIER_FAILURES moved with the engine).
 */

import { readFileSync } from "node:fs";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
	buildClassifierUnavailableMessage,
	buildYoloRejectionMessage,
} from "./classifier-messages.ts";
import {
	classifyToolCall,
	type ClassifierSessionContext,
	readAgentsMdForClassifier,
} from "./classifier-client.ts";
import { runClassifierAttempts } from "./classifier-retry.ts";
import type { ClassifierStage } from "./config.ts";
import {
	createDenialTrackingState,
	recordClassifierDenial,
	recordClassifierSuccess,
	shouldFallbackToPrompting,
	type DenialTrackingState,
} from "./denial-tracking.ts";
import { checkAutoRisk } from "./auto-risk.ts";
import { extractEmbeddedCommandInputs } from "./fusion-tools.ts";
import { readBranchEntries } from "./session-branch.ts";
import { isAutoFallbackBash, isSafeCommand } from "./bash-analysis.ts";
import { isOutsideCwd } from "./path-safety.ts";
import { resolveWorkspacePath } from "./plan.ts";
import { shortenPath } from "./ui/footer.ts";

type Block = { block: true; reason: string } | undefined;

/** Narrow cross-domain seam for the auto-mode engine. */
export interface AutoEngineDeps {
	getClassifierConfig(): { enabled: boolean; model: string; timeoutMs: number; jsonlTranscript?: boolean; stage?: ClassifierStage; includeAgentsMd?: boolean; failClosed?: boolean };
	getAutoModeConfig(): { allow?: string[]; soft_deny?: string[] } | undefined;
	getMode(): string;
	getFusionSchemaHint(toolName: string): string;
	/** The approval-prompt path (index.ts) the engine falls back to. */
	promptWithPermissionOptions(ctx: ExtensionContext, tool: string, input: Record<string, unknown>, label: string, category: string): Promise<Block>;
	uiNotify(ctx: ExtensionContext, msg: string, level: "info" | "warning" | "error"): void;
	trackOutsideWrite(cwd: string, record: { timestamp: string; originalPath: string; toolName: string; backupContent: string | null }): void;
}

export function createAutoEngine(deps: AutoEngineDeps) {
	const classifierDenialState = { current: createDenialTrackingState() as DenialTrackingState };
	const MAX_CLASSIFIER_FAILURES = 3;

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

  async function approveTier3(
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

    if (deps.getClassifierConfig().enabled) {
      // Single visible retry layer (plan2 B2): the classifier call disables
      // SDK-level retries (maxRetries: 0) and enforces timeoutMs per attempt,
      // so the worst-case wait here is timeoutMs × MAX_CLASSIFIER_FAILURES.
      // P2-1 Step 3: the retry mechanism lives in classifier-retry.ts; only
      // the verdict business (denial accounting / fallback / fail-closed)
      // stays in this gate.
      const outcome = await runClassifierAttempts({
        attempts: MAX_CLASSIFIER_FAILURES,
        onRetry: (n, err) => {
          if (process.env.PERMISSION_MODES_CLASSIFIER_DEBUG === "1") {
            console.debug(
              `[permission-modes] Classifier retry (${n}/${MAX_CLASSIFIER_FAILURES}): ${classifierErrorMessage(err)}`,
            );
          }
        },
        attempt: async () => {
          const verdict = await classifyToolCall({
            modelRef: deps.getClassifierConfig().model,
            session: collectClassifierSessionContext(ctx, reviewHint),
            pendingTool: { name: tool, input },
            registry: ctx.modelRegistry,
            autoMode: deps.getAutoModeConfig(),
            timeoutMs: deps.getClassifierConfig().timeoutMs,
            jsonlTranscript: deps.getClassifierConfig().jsonlTranscript,
            stage: deps.getClassifierConfig().stage,
            includeAgentsMd: deps.getClassifierConfig().includeAgentsMd,
            signal: ctx.signal,
            debug: process.env.PERMISSION_MODES_CLASSIFIER_DEBUG === "1",
          });
          if (!verdict.allow) {
            classifierDenialState.current = recordClassifierDenial(classifierDenialState.current);
            if (shouldFallbackToPrompting(classifierDenialState.current)) {
              return deps.promptWithPermissionOptions(
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
          classifierDenialState.current = recordClassifierSuccess(classifierDenialState.current);
          return finishAutoTier3Allow(ctx, tool, input);
        },
      });
      if (outcome.ok) {
        return outcome.value as Block;
      }
      logClassifierUnavailable(outcome.error, outcome.attempts);
      if (deps.getClassifierConfig().failClosed !== false) {
        return classifierDenyBlock(
          tool,
          buildClassifierUnavailableMessage(tool, deps.getClassifierConfig().model),
        );
      }
      // fail-open: fall through to the local tier-3 fallback below
    }

    const local = resolveLocalAutoTier3(tool, input, riskInput, ctx.cwd);
    if (!local.allow) {
      return deps.promptWithPermissionOptions(ctx, tool, input, local.reason, local.category);
    }
    classifierDenialState.current = recordClassifierSuccess(classifierDenialState.current);
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
    deps.trackOutsideWrite(ctx.cwd, {
      timestamp: new Date().toISOString(),
      originalPath: resolvedPath,
      toolName: tool,
      backupContent,
    });
    if (ctx.hasUI) {
      deps.uiNotify(ctx, 
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
        .join(" && ")}${deps.getFusionSchemaHint(tool)}`
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
    const includeAgentsMd = deps.getClassifierConfig().includeAgentsMd !== false;
    return {
      cwd: ctx.cwd,
      mode: deps.getMode(),
      branch,
      reviewHint,
      agentsMd: includeAgentsMd
        ? readAgentsMdForClassifier(ctx.cwd)
        : null,
    };
  }

	return {
		approveTier3,
		trackOutsideWriteIfNeeded,
		describeTier3Review,
		collectClassifierSessionContext,
		/** The gate's allow-path effect: record success on the denial tracker. */
		noteAllowed(): void {
			if (deps.getMode() === "auto") {
				classifierDenialState.current = recordClassifierSuccess(classifierDenialState.current);
			}
		},
		/** setMode / session_start reset (was: createDenialTrackingState() reassign). */
		resetDenialState(): void {
			classifierDenialState.current = createDenialTrackingState();
		},
	};
}
