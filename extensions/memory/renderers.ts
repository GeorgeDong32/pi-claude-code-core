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

export interface ConsolidateArgs {
	writes?: Array<{ file?: string }>;
	deletes?: Array<string>;
	layer?: string;
}

export function consolidateCallText(args: ConsolidateArgs): string {
	const layer = args.layer === "user" ? "user" : "project";
	const w = Array.isArray(args.writes) ? args.writes.length : 0;
	const d = Array.isArray(args.deletes) ? args.deletes.length : 0;
	return `Memory Consolidate ${layer} · ${w}W/${d}D`;
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
