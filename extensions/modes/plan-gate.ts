import { classifyBashTiers, isSafeCommand } from "./bash-analysis.ts";
import { extractEmbeddedCommandInputs } from "./fusion-tools.ts";
import { shortenPath } from "./ui/footer.ts";

export interface PlanGateFacts {
	planFilePath: string;
	isPlanFile: boolean;
	mcpShaped: boolean;
	familyClaimed: boolean;
	fusionSchemaHint: string;
}

export interface PlanGateBlock {
	block: true;
	reason: string;
}

export function planHardBlock(
	tool: string,
	input: Record<string, unknown>,
	facts: PlanGateFacts,
): PlanGateBlock | undefined {
	if (tool === "codemode") {
		return {
			block: true,
			reason: "Plan mode: codemode is not available (it can execute other tools).",
		};
	}
	if (tool === "edit" || tool === "write") {
		const pathStr = String(input.path ?? "");
		if (!(pathStr && facts.isPlanFile)) {
			return {
				block: true,
				reason: `Plan mode: only ${shortenPath(facts.planFilePath)} may be edited.`,
			};
		}
	} else if (tool === "bash" || tool === "powershell") {
		const cmd = String(input.command ?? "");
		if (!isSafeCommand(cmd)) {
			return {
				block: true,
				reason: `Plan mode: read-only commands only.\n  Command: ${cmd}`,
			};
		}
	} else if (facts.mcpShaped) {
		if (!facts.familyClaimed) {
			return {
				block: true,
				reason: `Plan mode: MCP tool ${tool} is not available (plan is read-only).`,
			};
		}
		return undefined;
	}

	const embedded = extractEmbeddedCommandInputs(tool, input);
	const offender = embedded.find((c) => !classifyBashTiers(c.command).safe);
	if (offender) {
		return {
			block: true,
			reason: `Plan mode: read-only commands only.\n  Command: ${offender.command}${facts.fusionSchemaHint}`,
		};
	}
	return undefined;
}
