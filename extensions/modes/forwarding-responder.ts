/**
 * modes/forwarding-responder.ts — the parent-side approval forwarding
 * responder, extracted verbatim from the modes extension factory (index.ts)
 * in SPEC SR W-M. When an interactive parent session holds a UI and a
 * headless subagent child forwards a permission request through
 * ~/.pi/agent/sessions/permission-modes-forwarding/sessions/<id>/ (P0-CT-05),
 * this module polls the inbox, prompts the parent user, and writes the
 * response back.
 *
 * State moved with the code: the live ForwardingPoller handle and the
 * claimed-ids set (survives poller restarts so the same inbox request is
 * not double-prompted). Lifecycle: start(ctx) on session start, shutdown()
 * on session_shutdown — the shutdown order (stop → drop handle → clear
 * claimed ids) matches the historical inline sequence exactly.
 *
 * Allow-always decisions route through the shared applyApprovalDecision
 * executor (approval-flow.ts) with ruleCwd=child cwd and trackWrite=false —
 * tracking is the child's job.
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	createForwardingPoller,
	defaultAgentDir,
	isSubagentChildProcess,
	writeForwardedResponse,
	type ForwardedDecision,
	type ForwardedPermissionRequest,
	type ForwardingPoller,
} from "./permission-forwarding.ts";
import { readSessionId } from "./session-branch.ts";

/** Structural mirror of approval-flow.ts's applyApprovalDecision signature
 *  (only the opts variants the responder actually passes). */
export interface ForwardingApplyApproval {
	(
		ctx: ExtensionContext,
		tool: string,
		input: Record<string, unknown>,
		decision: "allow_always_local" | "allow_always_global",
		opts?: { ruleCwd?: string; trackWrite?: boolean },
	): Promise<{ block: true; reason: string } | undefined>;
}

export interface ForwardingResponderDeps {
	applyApprovalDecision: ForwardingApplyApproval;
}

export function createForwardingResponder(deps: ForwardingResponderDeps) {
	let forwardingPoller: ForwardingPoller | undefined;
	/** Survives poller restarts so the same inbox request is not double-prompted. */
	const forwardingClaimedIds = new Set<string>();

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
				await deps.applyApprovalDecision(ctx, request.tool, request.input, "allow_always_local", {
					ruleCwd: request.cwd,
					trackWrite: false,
				});
			} else if (choice === "Allow always (global)") {
				decision = "allow_always_global";
				approved = true;
				denialReason = undefined;
				await deps.applyApprovalDecision(ctx, request.tool, request.input, "allow_always_global", {
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

	function start(ctx: ExtensionContext): void {
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

	function shutdown(): void {
		forwardingPoller?.stop();
		forwardingPoller = undefined;
		forwardingClaimedIds.clear();
	}

	return {
		handleForwardedPermissionRequest,
		start,
		shutdown,
	};
}
