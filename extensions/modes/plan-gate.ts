/**
 * plan-gate.ts — the plan-mode hard-limit gate (SPEC 2026-10-07 P0-1 §4.1).
 *
 * The plan hard limits sit BETWEEN the permission-rule deny and the verdict
 * execution (allow/ask): rules can never unlock plan's read-only invariant
 * (D2a), a deny rule still wins (step 1, kept in the handler), and an ask
 * verdict only prompts for calls the hard gate did NOT reject (step 3) — a
 * hard-blocked call never prompts. Full order:
 *
 *   1. evaluateToolPermission → deny                       (handler)
 *   2. planHardBlock (this module) — block, never prompts  (handler, plan only)
 *   3. verdict = ask → prompt/forward, result honored      (handler, D1)
 *   4. verdict = allow → allow (only plan-legal calls left)(handler)
 *   5. passthrough → plan read tools / tool_search / default allow
 *
 * Scan boundary (D2, review R2): built-in edit/write/bash/powershell/codemode
 * names are NEVER exempted by family claims. For every other tool, only calls
 * that are BOTH authoritative-MCP-shaped AND claimed by a registered family
 * skip the generic embedded-command scan — their command/run/cmd/then_run are
 * remote schema parameters, not local shell; the family's deny/ask/allow
 * adjudicates them instead. Unclaimed MCP shapes stay denied (D2c,
 * fail-closed); unknown non-MCP tools keep the original scan behavior.
 *
 * Pure data in / Block out: path probing, family matching and env reads stay
 * in the adapter (facts). The MCP shape verdict itself comes from
 * lib/mcp-shape.ts via the adapter — never a second shape test here.
 */

import { classifyBashTiers, isSafeCommand } from "./bash-analysis.ts";
import { extractEmbeddedCommandInputs } from "./fusion-tools.ts";
import { shortenPath } from "./ui/footer.ts";

export interface PlanGateFacts {
	/** Absolute plan file path for the current cwd (error text only). */
	planFilePath: string;
	/** Adapter-side isPlanFilePath probe for THIS call's path. */
	isPlanFile: boolean;
	/** Authoritative MCP-shape verdict (lib/mcp-shape, collected by adapter). */
	mcpShaped: boolean;
	/** Whether a registered rule family claims this call. */
	familyClaimed: boolean;
	/** Display hint from the fusion schema annotation (may be ""). */
	fusionSchemaHint: string;
}

export interface PlanGateBlock {
	block: true;
	reason: string;
}

const BUILTIN_LIMIT_TOOLS = new Set([
	"codemode",
	"edit",
	"write",
	"bash",
	"powershell",
]);

/**
 * The plan hard limits (P0-1 §4.1 step 2). Returns the block when the call
 * violates plan's read-only invariant, undefined when it may proceed to
 * verdict execution / the plan allowlist dispatch.
 */
export function planHardBlock(
	tool: string,
	input: Record<string, unknown>,
	facts: PlanGateFacts,
): PlanGateBlock | undefined {
	// Built-in names: hard limits apply regardless of family claims.
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
			// D2c: no family governs it — fail closed (independent modes load).
			return {
				block: true,
				reason: `Plan mode: MCP tool ${tool} is not available (plan is read-only).`,
			};
		}
		// Family-governed MCP: skip the generic embedded-command scan; the
		// family's deny/ask/allow (verdict execution in the handler) decides.
		return undefined;
	}

	// Generic embedded-command scan: built-ins and unknown non-MCP tools.
	// (Family-governed MCP returned above; unclaimed MCP blocked above.)
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

/** The built-in tool names whose plan hard limits family claims cannot exempt. */
export function isPlanBuiltinLimitTool(tool: string): boolean {
	return BUILTIN_LIMIT_TOOLS.has(tool);
}
