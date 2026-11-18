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
