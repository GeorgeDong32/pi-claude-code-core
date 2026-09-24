/**
 * TUI renderer for `pi-review` custom messages. v0.8.3 (user decision):
 * the FULL report is always rendered — no collapsed/expanded split (the
 * host's global expansion toggle made the card look like it "didn't show
 * the report"). A `pi-review result:` summary line sits at the TOP of the
 * card; the report body follows verbatim.
 *
 * v0.8.5: the report card dropped its `customMessageBg` Box and renders
 * flat in the Claude Code visual language — an accent `⏺` summary row and
 * the body under a `⎿  ` gutter. Only standard pi theme tokens are used
 * (no CC-TUI dependency), so the flat block renders identically in the
 * default TUI.
 *
 * v0.8.6 (user decision): live reports no longer arrive through this
 * renderer — the report tool returns the markdown to the main agent, which
 * outputs it as plain chat text. This card now serves only the `/review`
 * command echo, `/review-show` re-renders, and replay of older sessions.
 *
 * Fused-followup: the `/review` command echo dropped its `[pi-review]` box
 * and renders as a CC-style user command bar (dim `❯` + white text on the
 * CC user background), matching CC-TUI's typed-message bars.
 */
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

/** Title-case display form: approve -> Approve, request_changes -> Request changes. */
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

/** `pi-review result: Approve · 0 blocker · 0 major · 0 minor · 0 nit` */
export function summaryLine(header: ReportHeader): string {
	const t = header.totals;
	const counts = t
		? ` · ${t.blocker} blocker · ${t.major} major · ${t.minor} minor · ${t.nit} nit`
		: "";
	return `pi-review result: ${displayVerdict(header.verdict)}${counts}`;
}

/** Minimal theme surface of the flat card (same pattern as CC-TUI's CCTheme). */
export interface CardTheme {
	fg(color: string, text: string): string;
	bold(text: string): string;
}

/** Gutter `  ⎿  ` is 5 visible cells; continuation rows align with spaces. */
const GUTTER_VISIBLE_WIDTH = 5;
const CONTINUATION = " ".repeat(GUTTER_VISIBLE_WIDTH);

/**
 * Flat report card in the CC visual language: `⏺ <summary>` head row, body
 * wrapped under a `  ⎿  ` gutter (dim), continuation rows space-aligned.
 * Plain object implementing the pi-tui Component interface.
 */
export function reportCard(header: ReportHeader, contentText: string, theme: CardTheme) {
	return {
		invalidate() {},
		render(width: number): string[] {
			// Truncate the PLAIN summary before styling so ANSI escapes are never cut.
			const dotCell = visibleWidth("⏺ ");
			const avail = Math.max(10, width - dotCell);
			const head = `${theme.fg("accent", "⏺")} ${theme.bold(theme.fg("toolTitle", truncateToWidth(summaryLine(header), avail, "…")))}`;
			const body = contentText.replace(/\n+$/, "");
			if (!body.trim()) return [head];
			const gutter = theme.fg("dim", `  ⎿  `);
			const wrapW = Math.max(10, width - GUTTER_VISIBLE_WIDTH);
			const physical: string[] = [];
			for (const line of body.split("\n")) physical.push(...wrapTextWithAnsi(line, wrapW));
			// Body painted `toolOutput` — the theme token for tool output keeps the
			// report visually subordinate to the summary without a background box
			// and adapts to every theme; the raw default fg would blur into
			// assistant prose. Blank separators stay truly blank.
			return [
				head,
				...physical.map((l, i) =>
					`${i === 0 ? gutter : CONTINUATION}${l ? theme.fg("toolOutput", l) : l}`
				),
			];
		},
	};
}

/**
 * CC renders slash-command echoes like ordinary user bars
 * (UserCommandMessage): dim `❯` + white command text on the CC
 * userMessageBackground, spanning the row. Constants mirror CC-TUI's
 * user-bar transform so the echo reads exactly like a typed message there.
 */
export function commandEchoRow(contentText: string, theme: CardTheme) {
	return {
		invalidate() {},
		render(width: number): string[] {
			const bg = "\x1b[48;2;55;55;55m"; // CC userMessageBackground rgb(55,55,55)
			const bgOff = "\x1b[49m";
			const white = "\x1b[38;2;255;255;255m";
			const reset = "\x1b[39m";
			const clipped = truncateToWidth(contentText, Math.max(10, width - 2), "…");
			const content = `${theme.fg("dim", "❯ ")}${white}${clipped}${reset}`;
			// NBSP padding: plain trailing spaces get trimmed downstream.
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
		// The `/review` command echo shares this customType with reports.
		// Echoes render as a CC-style user command bar, no prefix.
		if (contentText.startsWith("/review")) {
			return commandEchoRow(contentText, theme);
		}
		return reportCard(extractHeader(contentText), contentText, theme);
	});
}
