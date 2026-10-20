/**
 * mcp-gov/declaration-meter.ts — [cherry-batch3 B4-F1] measures the tool
 * declaration volume of every provider request (spec
 * docs/zh/cherry-batch3-b4-spec.md; data basis docs/{en,zh}/b4-declaration-recon.md:
 * one direct MCP server costs ≈1.3K tokens per request).
 *
 * Dialect-tolerant extraction (review R1 P2-1): flat `tools` /
 * Bedrock `toolConfig.tools`; names via `name ?? function?.name`; Google's
 * nested `tools:[{functionDeclarations:[…]}]` is expanded; unextractable
 * shapes fall into the "other" bucket; no tools at all → silently skipped
 * (fail-open — the meter must never affect the request; it only READS the
 * payload).
 *
 * Three buckets (R1 P2-2 — ExtensionAPI has no runtime tool enumeration):
 * mcp__<server>__* → that server, parsed from the PAYLOAD-side as-sanitized
 * name (pi's createMcpToolName already sanitizes before declaring — so no
 * id-side re-sanitization is needed here; GATE-side "is this MCP-shaped"
 * classification remains lib/mcp-shape's authority, invariant 4 — this meter
 * only BUCKETES names for display and never gates); a static list of core's
 * own registered tool names (imported from the registering modules where a
 * shared constant exists) → "core"; everything else → "other(builtin+ext)".
 *
 * Pure in-memory: latest snapshot + maxBytes. No disk writes, no timers,
 * never on the bus — the /core panel pulls it synchronously. A request
 * carrying NO tools (or an unrecognizable dialect) keeps the previous
 * snapshot — deliberate: the meter shows the last MEANINGFUL measurement.
 */

import {
	ABORT_GOAL_TOOL_NAME,
	CREATE_GOAL_TOOL_NAME,
	PROPOSE_DRAFT_TOOL_NAME,
	QUESTIONNAIRE_TOOL_NAME,
	QUESTION_TOOL_NAME,
	SISYPHUS_STEP_TOOL_NAME,
	TWEAK_APPLY_TOOL_NAME,
} from "../goal/goal-tool-names.ts";

export interface DeclarationSnapshot {
	totalBytes: number;
	maxBytes: number;
	perClass: Record<string, number>;
	perServer: Record<string, number>;
	toolCount: number;
}

/** Latest-snapshot + historical-max meter state. */
interface MeterState {
	last: DeclarationSnapshot | null;
}

// Core's own registered tool names (static — see the header; NOT a runtime
// query). Extensions may add tools; unknowns land in "other". Names shared
// with the registering module import its constant to prevent drift
// (code-review R1 P2). bg_wait is registered by pi-subagents in SOME
// deployments — kept; TaskOutput/TaskList/TaskStop are registered by core's
// vendored bg-shell (code-review R2 P3: not pi builtins).
const CORE_TOOL_NAMES = new Set<string>([
	"TaskOutput",
	"TaskList",
	"TaskStop",
	"obs_recall",
	"pi_review_report",
	"memory_consolidate",
	"session_recall",
	"contact_supervisor",
	"subagent_supervisor",
	// goal module (shared constants)
	CREATE_GOAL_TOOL_NAME,
	QUESTION_TOOL_NAME,
	QUESTIONNAIRE_TOOL_NAME,
	SISYPHUS_STEP_TOOL_NAME,
	TWEAK_APPLY_TOOL_NAME,
	PROPOSE_DRAFT_TOOL_NAME,
	ABORT_GOAL_TOOL_NAME,
	"get_goal",
	"update_goal",
	"pause_goal",
	// modes module
	"plan_ready",
	// bg-shell
	"bg_wait",
]);

export function createDeclarationMeter(): {
	observe(payload: unknown): void;
	last(): DeclarationSnapshot | null;
} {
	const state: MeterState = { last: null };
	return {
		observe(payload: unknown): void {
			try {
				const tools = extractTools(payload);
				if (!tools) return; // no tools on this dialect/request — skip
				let total = 0;
				let count = 0;
				const perClass: Record<string, number> = {};
				const perServer: Record<string, number> = {};
				for (const entry of tools) {
					const decl = JSON.stringify(entry.raw);
					total += decl.length;
					count += 1;
					const name = entry.name;
					if (name && name.startsWith("mcp__")) {
						// mcp__<server>__<tool> — empty server segment lands in "unknown"
						const rest = name.slice("mcp__".length);
						const sep = rest.indexOf("__");
						const server = sep > 0 ? rest.slice(0, sep) : "unknown";
						perServer[server] = (perServer[server] ?? 0) + decl.length;
						perClass.mcp = (perClass.mcp ?? 0) + decl.length;
					} else if (name && CORE_TOOL_NAMES.has(name)) {
						perClass.core = (perClass.core ?? 0) + decl.length;
					} else {
						perClass.other = (perClass.other ?? 0) + decl.length;
					}
				}
				const maxBytes = Math.max(total, state.last?.maxBytes ?? 0);
				state.last = { totalBytes: total, maxBytes, perClass, perServer, toolCount: count };
			} catch {
				/* fail-open: metering must never break a request */
			}
		},
		last(): DeclarationSnapshot | null {
			return state.last;
		},
	};
}

/** dialect-tolerant extraction — returns [{name, raw}] or null when the
 *  payload carries no recognizable tool list. */
function extractTools(payload: unknown): Array<{ name: string | null; raw: unknown }> | null {
	if (!payload || typeof payload !== "object") return null;
	const p = payload as Record<string, unknown>;
	const rawList =
		(Array.isArray(p.tools) && p.tools) ||
		(p.toolConfig && typeof p.toolConfig === "object" && Array.isArray((p.toolConfig as Record<string, unknown>).tools)
			? ((p.toolConfig as Record<string, unknown>).tools as unknown[])
			: null);
	if (!rawList) return null;
	const out: Array<{ name: string | null; raw: unknown }> = [];
	for (const item of rawList) {
		if (item && typeof item === "object") {
			const t = item as Record<string, unknown>;
			// flat form: name / function.name / Bedrock toolSpec.name
			const toolSpec = t.toolSpec && typeof t.toolSpec === "object" ? (t.toolSpec as Record<string, unknown>) : null;
			const flatName =
				(typeof t.name === "string" && t.name) ||
				(t.function && typeof t.function === "object" && typeof (t.function as Record<string, unknown>).name === "string"
					? ((t.function as Record<string, unknown>).name as string)
					: null) ||
				(toolSpec && typeof toolSpec.name === "string" ? (toolSpec.name as string) : null);
			if (flatName || typeof t.type === "string" || t.inputSchema || t.parameters) {
				out.push({ name: flatName, raw: item });
				continue;
			}
			// Google nested form: tools: [{ functionDeclarations: [...] }]
			if (Array.isArray(t.functionDeclarations)) {
				for (const fd of t.functionDeclarations as Array<Record<string, unknown>>) {
					out.push({ name: typeof fd.name === "string" ? fd.name : null, raw: fd });
				}
				continue;
			}
		}
		out.push({ name: null, raw: item });
	}
	if (out.length === 0 && rawList.length === 0) return null;
	return out;
}
