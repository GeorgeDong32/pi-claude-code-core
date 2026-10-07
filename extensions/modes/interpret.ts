/**
 * interpret.ts — the permission adjudication INTERPRET half (SPEC
 * 2026-10-07 P2-1, A2=B): executes a Decision's side effects through ports
 * injected by the adapter (index.ts owns the closure state; this module
 * never touches pi). Every port is an existing function of the gate —
 * behavior parity is pinned by the adjudication-parity golden.
 *
 * Port semantics (unchanged from the pre-refactor gate):
 *  - promptWithOptions: promptWithPermissionOptions — forwarding / headless
 *    fail-closed / memory carve-out / compliance-inject all live THERE.
 *  - promptApproval: plain user prompt (label only).
 *  - firstSeen: the family first-seen dialog (allow once / session / always).
 *  - editWriteChoice: the ask-mode 5-choice dialog + applyApprovalDecision.
 *  - legacyAutoGate: Step-1 transitional home of the embedded-auto scan +
 *    tier ladder + classifier (folds into decide in Step 2/3).
 */
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
	legacyAutoGate(call: ToolCallRequest): Promise<BlockShape | undefined>;
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
		case "legacyAuto": {
			return ports.legacyAutoGate(call);
		}
	}
}
