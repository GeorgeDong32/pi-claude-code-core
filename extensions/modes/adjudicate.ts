import type { PermissionVerdict } from "./permissions.ts";

export type Mode = "ask" | "plan" | "auto" | "bypass";

export interface BlockShape {
	block: true;
	reason: string;
}

export interface FamilyFacts {
	canonicalId: string;
	suggestedRule: string;
	hasExplicitAskRule: boolean;
}

export interface AdjudicationFacts {
	mode: Mode;
	tool: string;
	input: Record<string, unknown>;
	hasUI: boolean;
	cwd: string;
	verdict: PermissionVerdict;
	planHardBlock?: BlockShape;
	family: FamilyFacts | null;
	familySessionGrant: boolean;
	embeddedCommands: string[];
	embeddedUnsafe: boolean[];
	embeddedHint: string;
	path: string;
	pathSensitive: boolean;
	pathOutsideCwd: boolean;
	pathCcSafety: boolean;
	bashPathCheck: { path: string; kind: "redirect" | "argument" | "mv-cp-flag-form" } | null;
	bashProtectedWrite: { target: string; kind: string } | null;
	bashDenyRule: string | null;
	bashFlagAsk: string | null;
	command: string;
	commandSafe: boolean;
	embeddedAuto: Array<{ command: string; sensitive: boolean; safe: boolean; autoApprovable: boolean }>;
	bashTiers?: { safe: boolean; autoApprovable: boolean };
	commandSensitive: boolean;
	autoAllowMatched: boolean;
	autoSoftDenyMatched: boolean;
	tier3ReviewLabel: string;
}

export interface AllowEffects {
	trackOutsideWrite?: boolean;
	familyAdjudication?: "rule-allow" | "session-grant";
	resetAutoDenialState?: boolean;
}

export type PromptFlavor =
	| "permission-options"
	| "approval"
	| "edit-write-choice";

export type Decision =
	| { kind: "allow"; effects: AllowEffects }
	| { kind: "deny"; reason: string }
	| { kind: "prompt"; flavor: PromptFlavor; label: string; category?: string; path?: string }
	| { kind: "firstSeen"; canonicalId: string; suggestedRule: string }
	| { kind: "classify"; tier3: { command?: string; path?: string } };


function bashProtectedWritePrompt(w: { target: string; kind: string }): Decision {
	return {
		kind: "prompt",
		flavor: "permission-options",
		label: `bash writes protected pi path "${w.target}" (${w.kind})`,
		category: "protected-path",
	};
}

function bashFlagAskPrompt(flagAsk: string): Decision {
	return {
		kind: "prompt",
		flavor: "permission-options",
		label: flagAsk,
		category: "sensitive-path",
	};
}

export function decide(f: AdjudicationFacts): Decision {
	if (f.verdict.behavior === "deny") {
		return {
			kind: "deny",
			reason: `Denied by permission rule [${f.verdict.source}]: ${f.verdict.rule}`,
		};
	}

	if (f.bashDenyRule) {
		return { kind: "deny", reason: f.bashDenyRule };
	}

	if (f.mode === "bypass") {
		if (f.verdict.behavior === "ask" && (f.family === null || f.family.hasExplicitAskRule)) {
			return {
				kind: "prompt",
				flavor: "permission-options",
				label: `permission rule requires approval: ${f.verdict.rule}`,
				category: "permission-ask",
			};
		}
		if ((f.tool === "edit" || f.tool === "write") && f.pathCcSafety) {
			return {
				kind: "prompt",
				flavor: "permission-options",
				label: `sensitive path "${f.path}"`,
				category: "sensitive-path",
			};
		}
		if (f.bashPathCheck) {
			return {
				kind: "prompt",
				flavor: "permission-options",
				label: `bash writes sensitive path "${f.bashPathCheck.path}"`,
				category: "sensitive-path",
			};
		}
		if (f.bashProtectedWrite) {
			return bashProtectedWritePrompt(f.bashProtectedWrite);
		}
		if (f.bashFlagAsk) {
			return bashFlagAskPrompt(f.bashFlagAsk);
		}
		const effects: AllowEffects = {};
		if (f.tool === "edit" || f.tool === "write") effects.trackOutsideWrite = true;
		return { kind: "allow", effects };
	}

	if (f.planHardBlock) {
		return { kind: "deny", reason: f.planHardBlock.reason };
	}

	if (f.bashProtectedWrite) {
		return bashProtectedWritePrompt(f.bashProtectedWrite);
	}

	if (f.bashFlagAsk) {
		return bashFlagAskPrompt(f.bashFlagAsk);
	}

	if (f.verdict.behavior === "allow") {
		const effects: AllowEffects = {};
		if (f.tool === "edit" || f.tool === "write") effects.trackOutsideWrite = true;
		if (f.family) effects.familyAdjudication = f.familySessionGrant ? "session-grant" : "rule-allow";
		if (f.mode === "auto") effects.resetAutoDenialState = true;
		return { kind: "allow", effects };
	}

	if (f.verdict.behavior === "ask") {
		if (f.family && !f.family.hasExplicitAskRule) {
			return { kind: "firstSeen", canonicalId: f.family.canonicalId, suggestedRule: f.family.suggestedRule };
		}
		return {
			kind: "prompt",
			flavor: "permission-options",
			label: `permission rule requires approval: ${f.verdict.rule}`,
			category: "permission-ask",
		};
	}

	if (f.mode === "auto") {
		for (const e of f.embeddedAuto) {
			if (e.sensitive) {
				return {
					kind: "prompt",
					flavor: "permission-options",
					label: `sensitive path in command: ${e.command}${f.embeddedHint}`,
					category: "sensitive-path",
				};
			}
			if (!e.safe && !e.autoApprovable) {
				return {
					kind: "prompt",
					flavor: "permission-options",
					label: f.tier3ReviewLabel,
					category: "fusion-command",
				};
			}
		}

		if (f.tool === "tool_search") {
			return { kind: "allow", effects: {} };
		}
		if (f.tool === "read" || f.tool === "grep" || f.tool === "find" || f.tool === "ls") {
			if (f.pathSensitive) {
				return {
					kind: "prompt",
					flavor: "permission-options",
					label: `sensitive path "${f.path}"`,
					category: "sensitive-path",
				};
			}
			return { kind: "allow", effects: { resetAutoDenialState: true } };
		}
		if (f.tool === "edit" || f.tool === "write") {
			if (f.pathSensitive) {
				return {
					kind: "prompt",
					flavor: "permission-options",
					label: `sensitive path "${f.path}"`,
					category: "sensitive-path",
				};
			}
			if (!f.path || !f.pathOutsideCwd) {
				return { kind: "allow", effects: { resetAutoDenialState: true } };
			}
		}
		if (f.tool === "bash" || f.tool === "powershell") {
			if (f.command && f.commandSensitive) {
				return {
					kind: "prompt",
					flavor: "permission-options",
					label: `sensitive path in command: ${f.command}`,
					category: "sensitive-path",
				};
			}
			if (f.bashTiers?.safe) {
				return { kind: "allow", effects: { resetAutoDenialState: true } };
			}
			if (f.command && f.autoSoftDenyMatched) {
				return {
					kind: "prompt",
					flavor: "permission-options",
					label: "matched autoMode.soft_deny",
					category: "auto-deny",
				};
			}
			if (f.command && f.autoAllowMatched && f.bashTiers?.autoApprovable) {
				return { kind: "allow", effects: { resetAutoDenialState: true } };
			}
			if (f.bashTiers?.autoApprovable) {
				return { kind: "allow", effects: { resetAutoDenialState: true } };
			}
		}

		return {
			kind: "classify",
			tier3: {
				command: f.tool === "bash" || f.tool === "powershell" ? f.command : undefined,
				path: f.tool === "edit" || f.tool === "write" ? f.path : undefined,
			},
		};
	}

	if (f.mode === "ask" && f.embeddedUnsafe.some((u) => u)) {
		return {
			kind: "prompt",
			flavor: "approval",
			label: `${f.embeddedCommands.map((c) => `"${c}"`).join(", ")}${f.embeddedHint}`,
		};
	}

	if (f.mode === "plan") {
		return { kind: "allow", effects: {} };
	}

	if (f.mode === "ask") {
		if (f.tool === "read" || f.tool === "grep" || f.tool === "find" || f.tool === "ls") {
			if (f.path && f.pathOutsideCwd) {
				return { kind: "prompt", flavor: "approval", label: `outside cwd on "${f.path}"` };
			}
			return { kind: "allow", effects: {} };
		}
		if (f.tool === "edit" || f.tool === "write") {
			if (!f.hasUI) {
				return { kind: "prompt", flavor: "approval", label: `on ${f.path || "(unknown)"}` };
			}
			return {
				kind: "prompt",
				flavor: "edit-write-choice",
				label: `Allow ${f.tool} on ${f.path || "(unknown)"}?`,
				path: f.path || "(unknown)",
			};
		}
		if (f.tool === "bash" || f.tool === "powershell") {
			if (f.commandSafe) return { kind: "allow", effects: {} };
			return { kind: "prompt", flavor: "approval", label: `"${f.command}"` };
		}
		return { kind: "allow", effects: {} };
	}

	return { kind: "allow", effects: {} };
}

export interface ToolCallRequest {
	ctx: unknown;
	tool: string;
	input: Record<string, unknown>;
}

export interface AdjudicatorDeps {
	collectFacts(call: ToolCallRequest): AdjudicationFacts;
	interpret(call: ToolCallRequest, decision: Decision): Promise<BlockShape | undefined>;
}

export interface PermissionAdjudicator {
	check(call: ToolCallRequest): Promise<BlockShape | undefined>;
}

export function createPermissionAdjudicator(deps: AdjudicatorDeps): PermissionAdjudicator {
	return {
		async check(call) {
			const decision = decide(deps.collectFacts(call));
			return deps.interpret(call, decision);
		},
	};
}
