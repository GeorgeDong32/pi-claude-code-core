import { Container, Text } from "@earendil-works/pi-tui";

import { firstLines, humanBytes, resultText, type ThemeLike } from "../../lib/tool-render.ts";

export const RECALL_PREVIEW_LINES = 5;

export interface RecallCallArgs {
	id?: string;
	offset?: number;
	filter?: string;
	context?: number;
	tail?: number;
}

export interface RecallResultDetails {
	id?: string;
	offset?: number;
	bytes?: number;
	lines?: number;
	nextOffset?: number;
	eof?: boolean;
	filter?: string;
	tail?: number;
	matchedLines?: number;
	totalLines?: number;
}

export function shortId(id: string): string {
	return id.length <= 16 ? id : id.slice(0, 16);
}

export function humanOffset(offset: number | undefined): string {
	if (!offset || offset <= 0) return "start";
	return `+${humanBytes(offset)}`;
}

export function recallCallText(args: RecallCallArgs): string {
	const id = typeof args.id === "string" && args.id ? shortId(args.id) : "obs_?";
	const selection =
		typeof args.filter === "string" && args.filter
			? `filter ${JSON.stringify(args.filter)}`
				: typeof args.tail === "number"
					? `tail ${args.tail}`
					: null;
	const where = selection && !args.offset ? "" : ` · ${humanOffset(args.offset)}`;
	return `Recall Observation ${id}${selection ? ` · ${selection}` : ""}${where}`;
}

export function stripProtocolHeader(text: string, details: RecallResultDetails): string {
	if (typeof details.bytes !== "number") return text;
	const lines = text.split("\n");
	if (lines.length >= 2 && lines[0]!.startsWith("[obs_recall id=") && lines[1]!.startsWith("[chunk_bytes=")) {
		const body = lines.length >= 3 && lines[2]!.startsWith("[selection: ") ? lines.slice(3) : lines.slice(2);
		return body.join("\n").replace(/^\n/, "");
	}
	return text;
}

export function recallHeaderText(details: RecallResultDetails): string {
	const size = typeof details.bytes === "number" ? humanBytes(details.bytes) : "?";
	const lines = typeof details.lines === "number" ? `${details.lines} lines` : "? lines";
	const coverage =
		typeof details.matchedLines === "number" && typeof details.totalLines === "number"
			? `${details.matchedLines}/${details.totalLines} matched · `
			: typeof details.totalLines === "number" && typeof details.tail === "number"
				? `last ${details.tail} of ${details.totalLines} · `
				: "";
	if (details.eof) return `${coverage}${size} · ${lines} · end ✓`;
	const from = humanOffset(details.offset);
	const to = typeof details.nextOffset === "number" ? `+${humanBytes(details.nextOffset)}` : "?";
	return `${coverage}${size} · ${lines} · ${from}→${to} · more ▸`;
}

export function recallBodyLines(
	result: { content?: unknown; details?: unknown },
): { header: string | null; body: string[] } {
	const details = (result.details ?? {}) as RecallResultDetails;
	const hasDetails = typeof details.bytes === "number" || typeof details.eof === "boolean";
	const raw = resultText(result);
	const body = (hasDetails ? stripProtocolHeader(raw, details) : raw).split("\n").filter((l, i, all) => !(l === "" && i === all.length - 1));
	return { header: hasDetails ? recallHeaderText(details) : null, body };
}

export class RecallRows extends Container {
	rebuild(rows: string[]): void {
		this.clear();
		for (const row of rows) this.addChild(new Text(row, 0, 0));
	}
}

export function renderRecallCall(args: RecallCallArgs, theme: ThemeLike): Text {
	return new Text(theme.fg("toolTitle", recallCallText(args)), 0, 0);
}

export function renderRecallResult(
	result: { content?: unknown; details?: unknown },
	options: { isError?: boolean; isPartial?: boolean; expanded?: boolean },
	theme: ThemeLike,
	lastComponent: unknown,
): RecallRows {
	// pi-tui re-renders result components every frame — reuse lastComponent
	// (clear+rebuild) instead of allocating a fresh tree per frame.
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
