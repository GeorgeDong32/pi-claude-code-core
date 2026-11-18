import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import type { IssueSeverity, Verdict } from "./types.js";

interface SeverityTotals {
	blocker: number;
	major: number;
	minor: number;
	nit: number;
}

interface ReportHeader {
	verdict: Verdict | "no-gate" | "error" | "partial";
	totals?: SeverityTotals;
}

export function extractHeader(markdown: string): ReportHeader {
	const m = markdown.match(/Verdict:\s*([A-Za-z_]+)\s*(?:（[^)]*）)?\s*\*{0,2}\s*\(([^)]*)\)/);
	if (!m) return { verdict: "comment" };
	const raw = m[1]?.toLowerCase() as ReportHeader["verdict"];
	const verdict = raw === "approve" || raw === "request_changes" || raw === "comment"
		? raw
		: raw === "no-gate" || raw === "error" || raw === "partial"
			? raw
			: "comment";
	const counts = (m[2] ?? "").match(/(\d+)\s*blocker\s*[·•]\s*(\d+)\s*major\s*[·•]\s*(\d+)\s*minor\s*[·•]\s*(\d+)\s*nit/);
	const totals: SeverityTotals | undefined = counts
		? {
				blocker: Number(counts[1] ?? 0),
				major: Number(counts[2] ?? 0),
				minor: Number(counts[3] ?? 0),
				nit: Number(counts[4] ?? 0),
			}
		: undefined;
	return { verdict, totals };
}

function displayVerdict(v: ReportHeader["verdict"]): string {
	switch (v) {
		case "approve":
			return "Approve";
		case "request_changes":
			return "Request changes";
		case "comment":
			return "Comment";
		case "no-gate":
			return "No gate";
		case "error":
			return "Error";
		case "partial":
			return "Partial";
	}
}

export function summaryLine(header: ReportHeader): string {
	const t = header.totals;
	const counts = t
		? ` · ${t.blocker} blocker · ${t.major} major · ${t.minor} minor · ${t.nit} nit`
		: "";
	return `pi-review result: ${displayVerdict(header.verdict)}${counts}`;
}

export interface CardTheme {
	fg(color: string, text: string): string;
	bold(text: string): string;
}

const GUTTER_VISIBLE_WIDTH = 5;
const CONTINUATION = " ".repeat(GUTTER_VISIBLE_WIDTH);

export function reportCard(header: ReportHeader, contentText: string, theme: CardTheme) {
	return {
		invalidate() {},
		render(width: number): string[] {
			const dotCell = visibleWidth("⏺ ");
			const avail = Math.max(10, width - dotCell);
			const head = `${theme.fg("accent", "⏺")} ${theme.bold(theme.fg("toolTitle", truncateToWidth(summaryLine(header), avail, "…")))}`;
			const body = contentText.replace(/\n+$/, "");
			if (!body.trim()) return [head];
			const gutter = theme.fg("dim", `  ⎿  `);
			const wrapW = Math.max(10, width - GUTTER_VISIBLE_WIDTH);
			const physical: string[] = [];
			for (const line of body.split("\n")) physical.push(...wrapTextWithAnsi(line, wrapW));
			return [
				head,
				...physical.map((l, i) =>
					`${i === 0 ? gutter : CONTINUATION}${l ? theme.fg("toolOutput", l) : l}`
				),
			];
		},
	};
}

export function commandEchoRow(contentText: string, theme: CardTheme) {
	return {
		invalidate() {},
		render(width: number): string[] {
			const bg = "\x1b[48;2;55;55;55m";
			const bgOff = "\x1b[49m";
			const white = "\x1b[38;2;255;255;255m";
			const reset = "\x1b[39m";
			const clipped = truncateToWidth(contentText, Math.max(10, width - 2), "…");
			const content = `${theme.fg("dim", "❯ ")}${white}${clipped}${reset}`;
			const pad = "\u00A0".repeat(Math.max(0, width - visibleWidth(content) - 1));
			return [`${bg}${content}${pad}${bgOff}`];
		},
	};
}

export function registerPiReviewRenderer(pi: ExtensionAPI): void {
	pi.registerMessageRenderer("pi-review", (message, _options, theme) => {
		const contentText = typeof message.content === "string"
			? message.content
			: (() => {
					const parts: string[] = [];
					for (const block of message.content) {
						if (block.type === "text") parts.push(block.text);
					}
					return parts.join("\n");
				})();
		if (contentText.startsWith("/review")) {
			return commandEchoRow(contentText, theme);
		}
		return reportCard(extractHeader(contentText), contentText, theme);
	});
}
