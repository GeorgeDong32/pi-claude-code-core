import type { BlockShape, Decision, ToolCallRequest } from "./adjudicate.ts";

export interface InterpretPorts {
	promptWithOptions(
		call: ToolCallRequest,
		label: string,
		category: string,
	): Promise<BlockShape | undefined>;
	promptApproval(call: ToolCallRequest, label: string): Promise<BlockShape | undefined>;
	firstSeen(call: ToolCallRequest, canonicalId: string, suggestedRule: string): Promise<BlockShape | undefined>;
	editWriteChoice(call: ToolCallRequest, path: string): Promise<BlockShape | undefined>;
	classifyTier3(
		call: ToolCallRequest,
		tier3: { command?: string; path?: string },
	): Promise<BlockShape | undefined>;
	recordAutoAllow(): void;
	trackOutsideWrite(call: ToolCallRequest): void;
	noteFamilyAdjudication(
		call: ToolCallRequest,
		outcome: "rule-allow" | "session-grant",
	): void;
}

export async function interpretDecision(
	ports: InterpretPorts,
	call: ToolCallRequest,
	decision: Decision,
): Promise<BlockShape | undefined> {
	switch (decision.kind) {
		case "allow": {
			if (decision.effects.trackOutsideWrite) ports.trackOutsideWrite(call);
			if (decision.effects.familyAdjudication) {
				ports.noteFamilyAdjudication(call, decision.effects.familyAdjudication);
			}
			if (decision.effects.resetAutoDenialState) ports.recordAutoAllow();
			return undefined;
		}
		case "deny": {
			return { block: true, reason: decision.reason };
		}
		case "prompt": {
			if (decision.flavor === "permission-options") {
				return ports.promptWithOptions(call, decision.label, decision.category ?? "user-prompt");
			}
			if (decision.flavor === "edit-write-choice") {
				return ports.editWriteChoice(call, decision.path ?? "");
			}
			return ports.promptApproval(call, decision.label);
		}
		case "firstSeen": {
			return ports.firstSeen(call, decision.canonicalId, decision.suggestedRule);
		}
		case "classify": {
			return ports.classifyTier3(call, decision.tier3);
		}
	}
}
