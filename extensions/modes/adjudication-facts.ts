/**
 * modes/adjudication-facts.ts — Step-1 fact collection for the tool_call
 * gate (P2-1: collect → decide → interpret), extracted verbatim from the
 * modes extension factory (index.ts) in SPEC SR W-M. Owns:
 * - the fusion tool-schema scan (plan2 B1 ②): one-shot annotation from
 *   session_start — tool schemas that declare command-shaped fields
 *   (fusion-capable tools). Label-only source hint; no behavior branches
 *   on this data.
 * - collectAdjudicationFacts(call): the cheap in-memory facts snapshot the
 *   pure adjudicator (adjudicate.ts) decides on. Field values are pinned by
 *   the parity golden test/lib/adjudication-parity.test.ts — do NOT reorder
 *   or reword any field expression here without re-running that golden.
 *
 * Rule families are resolved lazily per call (matchFamily inside the fact
 * builder) — never captured at factory time, so families registered after
 * this module's creation still adjudicate.
 *
 * Live state (merged rules, auto-mode config, current mode, the auto
 * engine) reaches this module through injected getters — index.ts owns it.
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	matchFamily,
	familyRuleMentions,
	hasSessionGrant,
} from "./rule-families.ts";
import { isMcpShapedCall, knownServersSetFromEnv } from "../../lib/mcp-shape.ts";
import { loadPermissionModesConfig } from "./config.ts";
import type { AutoModeRules } from "./classifier-prompt.ts";
import {
	declaredCommandFields,
	extractEmbeddedCommandInputs,
} from "./fusion-tools.ts";
import {
	checkBashDenyScan,
	checkBashProtectedWrite,
	checkBashWriteTargets,
	resolveBashPathChecks,
	type BashProtectedWrite,
} from "./bash-path-check.ts";
import { matchAutoRules } from "./auto-rule-match.ts";
import { classifyBashTiers, isSafeCommand } from "./bash-analysis.ts";
import {
	commandReferencesSensitivePath,
	isCcSafetyPath,
	isOutsideCwd,
	isSensitivePath,
} from "./path-safety.ts";
import { evaluateToolPermission, type PermissionRule } from "./permissions.ts";
import { planHardBlock } from "./plan-gate.ts";
import { getPlanFilePath, isPlanFilePath } from "./plan.ts";
import {
	type AdjudicationFacts,
	type ToolCallRequest,
} from "./adjudicate.ts";
import type { PermissionMode } from "./mode-prompt.ts";

/** Minimal ToolInfo shape the schema scan needs (structural — the fake in
 *  tests and the real host both satisfy it). */
interface ToolSchemaInfo {
	name?: string;
	parameters?: unknown;
}

export interface AdjudicationFactsDeps {
	getAllTools(): ToolSchemaInfo[];
	getMode(): PermissionMode;
	getMergedRules(): PermissionRule[];
	getAutoModeConfig(): AutoModeRules | undefined;
	describeTier3Review(
		tool: string,
		input: Record<string, unknown>,
		cwd: string,
	): string;
	isMemoryDirWrite(
		tool: string,
		ctx: { cwd?: string },
		input: Record<string, unknown> | undefined,
	): boolean;
}

export function createAdjudicationFacts(deps: AdjudicationFactsDeps) {
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
			for (const info of deps.getAllTools()) {
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

	// ---- tool_call gate (P2-1: collect -> decide -> interpret) ---------------
	// Step 1: bypass / rules / plan / ask adjudicate in the pure module
	// (adjudicate.ts) and execute through interpret.ts ports; auto still runs
	// the legacy ladder (embedded scan + tiers + classifier) behind the
	// legacyAuto decision until Step 2/3. Parity pinned by
	// test/lib/adjudication-parity.test.ts (golden from the pre-refactor gate).
	function collectAdjudicationFacts(call: ToolCallRequest): AdjudicationFacts {
		const ctx = call.ctx as ExtensionContext;
		const tool = call.tool;
		const input = call.input;
		const path = String(input.path ?? "");
		const command = String(input.command ?? "");
		const familyMatch = matchFamily(tool, input);
		const planHard = deps.getMode() === "plan"
			? planHardBlock(tool, input, {
					planFilePath: getPlanFilePath(ctx.cwd),
					isPlanFile: isPlanFilePath(path, ctx.cwd),
					mcpShaped: isMcpShapedCall(tool, input, knownServersSetFromEnv()),
					familyClaimed: familyMatch !== null,
					fusionSchemaHint: fusionSchemaHint(tool),
				})
			: undefined;
		const embedded = extractEmbeddedCommandInputs(tool, input);
		const isBashLike = tool === "bash" || tool === "powershell";
		// W5 switch, read per adjudication: env PI_CORE_BASH_PATH_CHECKS
		// overrides permission-modes.json bashPathChecks (default "all").
		// safety = W3 + protected-path prompt (P1-4) + allow-rule hardening
		// (P0-1, enforced inside bash-permission-match); deny = W4 only.
		const checkMode = isBashLike || embedded.length
			? resolveBashPathChecks(loadPermissionModesConfig())
			: "off";
		const safetyOn = checkMode === "all" || checkMode === "safety";
		const denyOn = checkMode === "all" || checkMode === "deny";
		// P1-1 (2026-11-08): embedded (fusion then_run-style) commands run the
		// same checks as the main bash command — deny in every mode, write
		// targets / protected paths wherever their mode checks them.
		const commandsToCheck = [
			...(isBashLike && command ? [command] : []),
			...embedded.map((c) => c.command),
		];
		const firstHit = <T,>(fn: (c: string) => T | null): T | null => {
			for (const c of commandsToCheck) {
				const hit = fn(c);
				if (hit !== null) return hit;
			}
			return null;
		};
		// W3 (safety): first CC-sensitive write target — bypass gate prompt.
		const bashPathCheck = safetyOn
			? firstHit((c) => checkBashWriteTargets(c, ctx.cwd))
			: null;
		// P1-4 (safety): bash write onto a pi-own protected path prompts in
		// every mode (bypass included; decide places it after plan limits).
		const bashProtectedWrite: BashProtectedWrite | null = safetyOn
			? firstHit((c) => checkBashProtectedWrite(c, ctx.cwd))
			: null;
		// W4 (deny): first Read/Edit deny-rule hit through a bash path target —
		// whole-command deny, every mode; reason text carries rule + path + the
		// switch name so the model does not blind-retry. S2 (spec 2026-11-15-
		// cleanup-hardening): ONE scan per candidate command yields both the
		// deny hit and the unrecognized mv/cp flag escalation (the old code ran
		// the rule scan twice — the second with a hacked empty rule set).
		let bashDenyRule: string | null = null;
		let bashFlagAsk: string | null = null;
		if (denyOn) {
			let denyHit: ReturnType<typeof checkBashDenyScan>["deny"] = null;
			let flagEsc: ReturnType<typeof checkBashDenyScan>["flagAsk"] = null;
			for (const c of commandsToCheck) {
				const scan = checkBashDenyScan(c, ctx.cwd, deps.getMergedRules());
				if (denyHit === null && scan.deny !== null) denyHit = scan.deny;
				if (flagEsc === null && scan.flagAsk !== null) flagEsc = scan.flagAsk;
				if (denyHit !== null && flagEsc !== null) break;
			}
			if (denyHit) {
				bashDenyRule = `Denied by permission rule [${denyHit.source}]: ${denyHit.rule} — bash references denied path "${denyHit.path}". Adjust the rule, or scope/disable via bashPathChecks / PI_CORE_BASH_PATH_CHECKS.`;
			}
			// BH-R3: an unrecognized mv/cp flag escalates to ask (never deny) —
			// the write targets cannot be path-validated.
			if (flagEsc) {
				bashFlagAsk = `bash write targets unverifiable: unrecognized mv/cp flag "${flagEsc.flag}" — approve, or rewrite with explicit paths`;
			}
		}
		// BH-R6: per-segment auto rule matching (soft_deny wins on ANY segment;
		// fast-allow requires EVERY segment to match, sans command substitution)
		const autoModeConfig = deps.getAutoModeConfig();
		const autoRules = command
			? matchAutoRules(command, autoModeConfig?.allow, autoModeConfig?.soft_deny)
			: { allowMatched: false, softDenyMatched: false };
		return {
			mode: deps.getMode(),
			tool,
			input,
			hasUI: ctx.hasUI,
			cwd: ctx.cwd,
			verdict: evaluateToolPermission(tool, input, ctx.cwd, deps.getMergedRules(), {
				// single-source the W5 switch read for this adjudication (review
				// fix 2026-11-08 P3#10): facts and rule matching share one snapshot
				allowHardening: safetyOn,
			}),
			planHardBlock: planHard,
			family: familyMatch
				? {
						canonicalId: familyMatch.canonicalId,
						suggestedRule: familyMatch.family.suggestAllowRule(familyMatch.canonicalId),
						hasExplicitAskRule: !!familyRuleMentions(deps.getMergedRules(), familyMatch.family, familyMatch.canonicalId, "ask"),
					}
				: null,
			familySessionGrant: familyMatch ? hasSessionGrant(familyMatch.canonicalId) : false,
			embeddedCommands: embedded.map((c) => c.command),
			embeddedUnsafe: embedded.map((c) => !isSafeCommand(c.command)),
			embeddedHint: fusionSchemaHint(tool),
			path,
			pathSensitive: !!path && isSensitivePath(path, ctx.cwd),
			pathOutsideCwd: !!path && isOutsideCwd(path, ctx.cwd),
			pathIsMemoryDir: deps.isMemoryDirWrite(tool, ctx, input),
			pathCcSafety: !!path && isCcSafetyPath(path, ctx.cwd),
			bashPathCheck,
			bashProtectedWrite,
			bashDenyRule,
			bashFlagAsk,
			command,
			commandSafe: isSafeCommand(command),
			embeddedAuto: embedded.map((c) => {
				const tiers = classifyBashTiers(c.command);
				return {
					command: c.command,
					sensitive: commandReferencesSensitivePath(c.command),
					safe: tiers.safe,
					autoApprovable: tiers.autoApprovable,
				};
			}),
			bashTiers: command ? classifyBashTiers(command) : undefined,
			commandSensitive: !!command && commandReferencesSensitivePath(command),
			// BH-R6: per-segment auto rule matching (auto-rule-match.ts)
			autoAllowMatched: autoRules.allowMatched,
			autoSoftDenyMatched: autoRules.softDenyMatched,
			tier3ReviewLabel: deps.describeTier3Review(tool, input, ctx.cwd),
		};
	}

	return {
		fusionSchemaHint,
		scanFusionToolSchemas,
		collectAdjudicationFacts,
	};
}
