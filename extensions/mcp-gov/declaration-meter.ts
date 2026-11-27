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

interface MeterState {
	last: DeclarationSnapshot | null;
}

// pi's ExtensionAPI has no runtime tool enumeration — core's own tool names are this static list.
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
	"plan_ready",
	"bg_wait",
]);

export function createDeclarationMeter(): {
	observe(payload: unknown): void;
	last(): DeclarationSnapshot | null;
} {
	const state: MeterState = { last: null };
	return {
		// pi's createMcpToolName already sanitizes names before declaring, so the
		// payload-side `mcp__<server>__<tool>` parsing needs no re-sanitization.
		observe(payload: unknown): void {
			try {
				const tools = extractTools(payload);
				if (!tools) return;
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
			}
		},
		last(): DeclarationSnapshot | null {
			return state.last;
		},
	};
}

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
