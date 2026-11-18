import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { notify as uiNotify } from "../ui/notify.ts";
import { confirmChoice } from "./ui/confirm.ts";
import {
	matchFamily,
	noteAdjudicated,
	grantSession,
} from "./rule-families.ts";
import { isMemoryWritePath } from "../memory/paths.ts";
import {
	addPermissionRule,
	warnIfLocalPermissionsNotGitignored,
} from "./permissions-loader.ts";
import {
	suggestAllowRuleForToolCall,
} from "./permissions.ts";
import {
	defaultAgentDir,
	isSubagentChildProcess,
	pollForwardedResponse,
	resolveParentSessionId,
	writeForwardedRequest,
} from "./permission-forwarding.ts";
import { readSessionId } from "./session-branch.ts";
import type { PermissionMode } from "./mode-prompt.ts";
import type { ToolCallRequest } from "./adjudicate.ts";

export type Block = { block: true; reason: string } | undefined;

export type ApprovalDecision =
	| "allow"
	| "allow_always_local"
	| "allow_always_global"
	| "bypass"
	| "block";

export interface ApprovalFlowAutoEngine {
	trackOutsideWriteIfNeeded(
		ctx: ExtensionContext,
		tool: "edit" | "write",
		pathStr: string,
	): void;
}

export interface ApprovalFlowDeps {
	reloadRules(cwd: string): void;
	setMode(mode: PermissionMode, ctx: ExtensionContext): Promise<void>;
	getAutoEngine(): ApprovalFlowAutoEngine;
	setCompliance(inject: boolean, category: string): void;
}

export function createApprovalFlow(deps: ApprovalFlowDeps) {
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
				deps.getAutoEngine().trackOutsideWriteIfNeeded(ctx, tool, String(input.path ?? ""));
			}
		};

		if (decision === "allow") {
			trackOutsideWrite();
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
					deps.reloadRules(ctx.cwd);
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
				deps.reloadRules(ctx.cwd);
			}
			trackOutsideWrite();
			return undefined;
		}
		if (decision === "bypass") {
			await deps.setMode("bypass", ctx);
			trackOutsideWrite();
			return undefined;
		}
		if (opts.complianceOnBlock !== false) {
			deps.setCompliance(true, opts.category ?? "user-prompt");
		}
		return {
			block: true,
			reason: opts.blockReason ?? `${tool} blocked by user`,
		};
	}

	function noteFamilyAdjudication(
		tool: string,
		input: Record<string, unknown>,
		outcome: "allow-once" | "rule-allow" | "session-grant",
	): void {
		const match = matchFamily(tool, input);
		if (match) noteAdjudicated(match.canonicalId, outcome);
	}

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
			return undefined as unknown as Block;
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
				deps.setCompliance(true, category);
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
				deps.setCompliance(true, category);
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

	async function firstSeenPrompt(
		ctx: ExtensionContext,
		canonicalId: string,
		tool: string,
		input: Record<string, unknown>,
		suggestedRule: string,
	): Promise<Block> {
		if (!ctx.hasUI) {
			return {
				block: true,
				reason:
					`${tool} (${canonicalId}) needs approval: no UI available. ` +
					`Pre-approve it by adding the rule \`${suggestedRule}\` to your permission rules ` +
					`in a parent/interactive session, then retry this call.`,
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
			return undefined as unknown as Block;
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
			deps.reloadRules(ctx.cwd);
			return undefined as unknown as Block;
		}
		return { block: true, reason: `${canonicalId} blocked by user` };
	}

	async function promptApproval(
		ctx: ExtensionContext,
		tool: string,
		label: string,
		input: Record<string, unknown> = {},
	): Promise<Block> {
		return promptWithPermissionOptions(ctx, tool, input, label, "user-prompt");
	}

	async function editWriteChoicePrompt(call: ToolCallRequest, pathVal: string): Promise<Block> {
		const ctx = call.ctx as ExtensionContext;
		const tool = call.tool;
		const input = call.input;
		if (!ctx.hasUI) {
			return promptApproval(ctx, tool, `on ${pathVal}`, input);
		}
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

	return {
		applyApprovalDecision,
		noteFamilyAdjudication,
		isMemoryDirWrite,
		promptWithPermissionOptions,
		firstSeenPrompt,
		promptApproval,
		editWriteChoicePrompt,
	};
}
