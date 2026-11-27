import { Text } from "@earendil-works/pi-tui";

import { resultText, type ThemeLike } from "../../lib/tool-render.ts";

export interface SessionRecallArgs {
	query?: string;
	since?: string;
	until?: string;
}

export function sessionRecallCallText(args: SessionRecallArgs): string {
	const query = (args.query ?? "").replace(/\s+/g, " ").trim();
	const clipped = query.length > 24 ? `${query.slice(0, 24)}…` : query;
	const range = args.since ? ` [${args.since}${args.until ? `→${args.until}` : ""}]` : "";
	return `Session Recall "${clipped}"${range}`;
}

export function renderSessionRecallCall(args: SessionRecallArgs, theme: ThemeLike): Text {
	return new Text(theme.fg("toolTitle", sessionRecallCallText(args)), 0, 0);
}

export function sessionRecallResultRows(result: { content?: unknown; details?: unknown }): string[] {
	const details = (result.details ?? {}) as { hits?: number; skippedLines?: number };
	const lines = resultText(result).split("\n").map((l) => l.trim()).filter(Boolean);
	const firstHit = lines.find((l) => l.startsWith("[") && l.includes(":"));
	const header = `${typeof details.hits === "number" ? details.hits : "?"} hit(s)${details.skippedLines ? ` · ${details.skippedLines} malformed skipped` : ""}`;
	const out = [header];
	if (firstHit) out.push(firstHit.length > 72 ? `${firstHit.slice(0, 72)}…` : firstHit);
	const hits = details.hits ?? 0;
	if (hits > 1) out.push(`… ${hits - 1} more`);
	return out;
}

export interface MemoryLookupArgs {
	name?: string;
}

export function renderMemoryLookupCall(args: MemoryLookupArgs, theme: ThemeLike): Text {
	return new Text(theme.fg("toolTitle", `Memory Lookup "${(args.name ?? "").trim()}"`), 0, 0);
}

export function memoryLookupResultRows(result: { content?: unknown; details?: unknown }): string[] {
	const details = (result.details ?? {}) as { ok?: boolean; near?: string[] };
	if (details.ok === false) return [resultText(result).split("\n")[0].slice(0, 120)];
	const lines = (resultText(result).split("\n").filter((l) => l.trim()).length) || 1;
	return ["memory file", `${lines} line(s)`];
}

export interface KnowledgeSearchArgs {
	query?: string;
	scope?: string;
}

export function renderKnowledgeSearchCall(args: KnowledgeSearchArgs, theme: ThemeLike): Text {
	const query = (args.query ?? "").replace(/\s+/g, " ").trim();
	const clipped = query.length > 24 ? `${query.slice(0, 24)}…` : query;
	return new Text(theme.fg("toolTitle", `Knowledge Search "${clipped}"${args.scope ? ` [${args.scope}]` : ""}`), 0, 0);
}

export function knowledgeSearchResultRows(result: { content?: unknown }): string[] {
	const lines = resultText(result).split("\n").map((l) => l.trim()).filter(Boolean);
	const counts = lines.filter((l) => /^(notes|sessions):/.test(l)).map((l) => l.replace(/\(.*\)/, "").trim());
	const out = counts.length > 0 ? [counts.join(" · ")] : ["no result"];
	const first = lines.find((l) => l.startsWith("- "));
	if (first) out.push(first.length > 72 ? `${first.slice(0, 72)}…` : first);
	const total = lines.filter((l) => l.startsWith("- ")).length;
	if (total > 1) out.push(`… ${total - 1} more`);
	return out;
}

export interface ConsolidateArgs {
	writes?: Array<{ file?: string }>;
	deletes?: Array<string>;
}

export function consolidateCallText(args: ConsolidateArgs): string {
	const w = Array.isArray(args.writes) ? args.writes.length : 0;
	const d = Array.isArray(args.deletes) ? args.deletes.length : 0;
	return `Memory Consolidate · ${w}W/${d}D`;
}

export function renderConsolidateCall(args: ConsolidateArgs, theme: ThemeLike): Text {
	return new Text(theme.fg("toolTitle", consolidateCallText(args)), 0, 0);
}

export function consolidateResultRows(result: { content?: unknown; details?: unknown }): string[] {
	const details = (result.details ?? {}) as { written?: number; deleted?: number };
	if (typeof details.written === "number" || typeof details.deleted === "number") {
		return [`applied ${details.written ?? 0} write(s) · ${details.deleted ?? 0} delete(s)`];
	}
	return resultText(result).split("\n").filter(Boolean).slice(0, 3);
}
