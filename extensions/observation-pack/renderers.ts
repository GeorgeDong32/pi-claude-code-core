/**
 * observation-pack/renderers.ts — the obs_recall presentation layer
 * (spec 2026-10-02-core-tool-renderers TR §1/A).
 *
 * The tool's RESULT TEXT is a model protocol (paging header + retrieve
 * instruction) — fine for the provider, noise for the human. These
 * renderers rebuild the visible rows from `details` (id/offset/bytes/
 * lines/nextOffset/eof) and show the CONTENT as the preview, stripping the
 * two protocol header lines when details prove they are ours. Everything
 * here is read-only: the model-visible text and the disk store are never
 * touched (module invariant 9).
 *
 * Component discipline (TR-FACT F5): renderResult runs every frame — the
 * result component reuses `context.lastComponent` via clear+rebuild instead
 * of allocating a fresh tree.
 */
import { Container, Text } from "@earendil-works/pi-tui";

import { firstLines, humanBytes, resultText, type ThemeLike } from "../../lib/tool-render.ts";

/** Physical preview lines when collapsed (bash renderer uses the same 5). */
export const RECALL_PREVIEW_LINES = 5;

export interface RecallCallArgs {
	id?: string;
	offset?: number;
}

export interface RecallResultDetails {
	id?: string;
	offset?: number;
	bytes?: number;
	lines?: number;
	nextOffset?: number;
	eof?: boolean;
}

/** Short, scannable id: obs_4b1d7b39 (12 chars past the prefix). */
export function shortId(id: string): string {
	return id.length <= 16 ? id : id.slice(0, 16);
}

/** `· start` / `· +15.5KB` — where in the original this page begins. */
export function humanOffset(offset: number | undefined): string {
	if (!offset || offset <= 0) return "start";
	return `+${humanBytes(offset)}`;
}

/** One-line call row: `Recall Observation obs_4b1d7b39 · +15.5KB`. */
export function recallCallText(args: RecallCallArgs): string {
	const id = typeof args.id === "string" && args.id ? shortId(args.id) : "obs_?";
	return `Recall Observation ${id} · ${humanOffset(args.offset)}`;
}

/** Strip the two protocol header lines — only when details confirm this
 * result is a shaped recall page (TR A: honest fallback keeps them when
 * details are absent, e.g. error paths). */
export function stripProtocolHeader(text: string, details: RecallResultDetails): string {
	if (typeof details.bytes !== "number") return text;
	const lines = text.split("\n");
	if (lines.length >= 2 && lines[0]!.startsWith("[obs_recall id=") && lines[1]!.startsWith("[chunk_bytes=")) {
		return lines.slice(2).join("\n").replace(/^\n/, "");
	}
	return text;
}

/** The collapsed header row: `15.9KB · 189 lines · +0B→15.5KB · more ▸`. */
export function recallHeaderText(details: RecallResultDetails): string {
	const size = typeof details.bytes === "number" ? humanBytes(details.bytes) : "?";
	const lines = typeof details.lines === "number" ? `${details.lines} lines` : "? lines";
	if (details.eof) return `${size} · ${lines} · end ✓`;
	const from = humanOffset(details.offset);
	const to = typeof details.nextOffset === "number" ? `+${humanBytes(details.nextOffset)}` : "?";
	return `${size} · ${lines} · ${from}→${to} · more ▸`;
}

/** renderResult body lines (shared by collapsed preview and expanded). */
export function recallBodyLines(
	result: { content?: unknown; details?: unknown },
): { header: string | null; body: string[] } {
	const details = (result.details ?? {}) as RecallResultDetails;
	const hasDetails = typeof details.bytes === "number" || typeof details.eof === "boolean";
	const raw = resultText(result);
	const body = (hasDetails ? stripProtocolHeader(raw, details) : raw).split("\n").filter((l, i, all) => !(l === "" && i === all.length - 1));
	return { header: hasDetails ? recallHeaderText(details) : null, body };
}

/** A minimal reusable multi-row component (clear + rebuild per frame). */
export class RecallRows extends Container {
	rebuild(rows: string[]): void {
		this.clear();
		for (const row of rows) this.addChild(new Text(row, 0, 0));
	}
}

/** renderCall implementation — single Text row. */
export function renderRecallCall(args: RecallCallArgs, theme: ThemeLike): Text {
	return new Text(theme.fg("toolTitle", recallCallText(args)), 0, 0);
}

/** renderResult implementation — header + preview/expanded body. */
export function renderRecallResult(
	result: { content?: unknown; details?: unknown },
	options: { isError?: boolean; isPartial?: boolean; expanded?: boolean },
	theme: ThemeLike,
	lastComponent: unknown,
): RecallRows {
	const rows: RecallRows =
		lastComponent instanceof RecallRows ? lastComponent : new RecallRows();
	const { header, body } = recallBodyLines(result);
	const out: string[] = [];
	if (header) out.push(theme.fg("muted", header));
	if (options.isError) {
		out.push(...body.map((l) => theme.fg("error", l)));
	} else {
		const [shown, hidden] = options.expanded ? [body, 0] : firstLines(body, RECALL_PREVIEW_LINES);
		out.push(...shown.map((l) => theme.fg("toolOutput", l)));
		if (hidden > 0) out.push(theme.fg("muted", `… ${hidden} more lines`));
	}
	rows.rebuild(out);
	return rows;
}
