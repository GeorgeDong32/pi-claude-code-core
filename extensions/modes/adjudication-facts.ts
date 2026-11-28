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
}

export function createAdjudicationFacts(deps: AdjudicationFactsDeps) {
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
				if (info.name === "bash" || info.name === "powershell") continue;
				const fields = declaredCommandFields(info.parameters);
				if (fields.length > 0) found.set(info.name, fields);
			}
			fusionToolSchemaFields = found;
		} catch {
			fusionToolSchemaFields = new Map();
		}
	}

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
		const checkMode = isBashLike || embedded.length
			? resolveBashPathChecks(loadPermissionModesConfig())
			: "off";
		const safetyOn = checkMode === "all" || checkMode === "safety";
		const denyOn = checkMode === "all" || checkMode === "deny";
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
		const bashPathCheck = safetyOn
			? firstHit((c) => checkBashWriteTargets(c, ctx.cwd))
			: null;
		const bashProtectedWrite: BashProtectedWrite | null = safetyOn
			? firstHit((c) => checkBashProtectedWrite(c, ctx.cwd))
			: null;
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
			if (flagEsc) {
				bashFlagAsk = `bash write targets unverifiable: unrecognized mv/cp flag "${flagEsc.flag}" — approve, or rewrite with explicit paths`;
			}
		}
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
