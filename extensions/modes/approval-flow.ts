/**
 * modes/approval-flow.ts — the approval side-effect layer, extracted
 * verbatim from the modes extension factory (index.ts) in SPEC SR W-M.
 * Owns every user-approval interaction path and the ONE decision executor:
 * - noteFamilyAdjudication: the single record point for family-tool allow
 *   outcomes (P4-MC-03) — every gate allow path funnels through
 *   applyApprovalDecision or the step-2 allow branch, both of which call
 *   this, so the broker mirror's cache view can never miss an approved call.
 * - applyApprovalDecision: single place executing an approval decision's
 *   side effects (allow-always persistence + rule reload + gitignore
 *   warning + notify, outside-write tracking on EVERY allow path,
 *   compliance-inject on block). The three approval flows (interactive
 *   select, ask-mode inline select, forwarded-parent responder) used to
 *   duplicate this and had diverged — the ask flow dropped write tracking
 *   and notifications (plan B2).
 * - promptWithPermissionOptions: the 4-choice approval prompt, including
 *   the parent-forwarding child path and the P3-PM-01 memory-dir carve-out.
 * - firstSeenPrompt: the P4-FAM-02/05 first-seen dialog for family tools.
 * - promptApproval / editWriteChoicePrompt: the gate's prompt ports.
 *
 * Live state reaches this module through injected deps (index.ts owns it):
 * reloadRules (rule reload after persistence), setMode (bypass decision),
 * a lazy auto-engine getter (outside-write tracking), and a compliance
 * setter (the factory's pendingComplianceInject/complianceCategory pair).
 * Rule families are resolved lazily per call — never captured at factory
 * time.
 */
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

/** The slice of the auto engine the approval flow needs (lazy — the engine
 *  is constructed after this module in the factory). */
export interface ApprovalFlowAutoEngine {
	trackOutsideWriteIfNeeded(
		ctx: ExtensionContext,
		tool: "edit" | "write",
		pathStr: string,
	): void;
}

export interface ApprovalFlowDeps {
	/** reloadMergedPermissionRules — re-merge + strip + cache invalidation. */
	reloadRules(cwd: string): void;
	setMode(mode: PermissionMode, ctx: ExtensionContext): Promise<void>;
	/** Lazy getter: the auto engine is built after this module in the factory. */
	getAutoEngine(): ApprovalFlowAutoEngine;
	/** Writes the factory's pendingComplianceInject/complianceCategory pair. */
	setCompliance(inject: boolean, category: string): void;
}

export function createApprovalFlow(deps: ApprovalFlowDeps) {
	/**
	 * Single place that executes an approval decision's side effects:
	 * allow-always persistence + rule reload + gitignore warning + notify,
	 * outside-write tracking on EVERY allow path, compliance-inject on block.
	 * Options narrow execution for the forwarding paths:
	 * - ruleCwd: parent responder persists rules against the child's cwd
	 * - persistRules:false when the other side already persisted (child poll)
	 * - trackWrite:false on the parent responder (tracking is the child's job)
	 * - complianceOnBlock:false in ask mode (no classifier compliance there)
	 */
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
				// Rules were persisted by the other side; just pick them up.
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

	// P4-FAM-02/05: the first-seen dialog for family-claimed tools.
	async function firstSeenPrompt(
		ctx: ExtensionContext,
		canonicalId: string,
		tool: string,
		input: Record<string, unknown>,
		suggestedRule: string,
	): Promise<Block> {
		if (!ctx.hasUI) {
			// headless/forwarded path: fail closed (unchanged from 2.8.0).
			// D6=B (user 2026-10-08, spec 2026-10-07 P3-1 S3): keep the original
			// reason prefix and append the family's own suggested allow rule so the
			// user can pre-approve in a parent/interactive session. No grant is
			// written, no dialog, and no parent-forwarding request is created —
			// family first-seen never enters the forwarding protocol.
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
			deps.reloadRules(ctx.cwd);
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

	// The ask-mode 5-choice edit/write dialog (verbatim from the old gate;
	// the bypass switch stays ask-mode-only — CC-aligned, adjudicated
	// 2026-09-12; side effects route through the shared executor).
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
