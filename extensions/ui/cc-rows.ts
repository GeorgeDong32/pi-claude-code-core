/**
 * extensions/ui/cc-rows.ts — the CC visual-language primitives shared by
 * core's message renderers (2026-10-20 notification CC-ification, user
 * decision captured on the prototype page):
 *
 *   command bar   dim `❯` + white command text on the CC user-bar gray
 *   summary row   accent `⏺` + bold toolTitle summary
 *   body block    dim `⎿` gutter (5 visible cells), continuation rows
 *                 space-aligned, body painted toolOutput
 *
 * Single source for the whole family — the same shapes review's
 * tui-renderer.ts (v0.8.5 flat card + command echo) established; new
 * renderers must not re-roll their own copy. Only standard pi theme tokens
 * are consulted (accent/toolTitle/dim/toolOutput/success) with ONE
 * deliberate exception: the command-bar background is the CC user-bar
 * constant rgb(55,55,55), because CC themes deliberately blank
 * `userMessageBg` (CC-TUI owns user-message painting there) — a themed
 * lookup would render a transparent bar (review's commandEchoRow made the
 * same call).
 *
 * Every component is a plain pi-tui Component ({ invalidate, render });
 * render(width) NEVER throws — on internal failure it falls back to the
 * raw unstyled body lines (AGENTS trap 1 discipline: render callbacks run
 * in stacks pi cannot catch).
 *
 * Long bodies do not invent their own fold state: the host's global
 * expansion toggle (ctrl+o) drives `expanded`; collapsed renders the first
 * CLIP_LINES rows plus a dim hint (keyText is unreachable here — the
 * literal "ctrl+o" matches pi's default and CC-TUI's fallback wording).
 */
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

/** Minimum theme surface (same duck type as review's CardTheme). */
export interface CcRowTheme {
	fg(color: string, text: string): string;
	bold(text: string): string;
}

/** CC userMessageBackground — mirrors review's commandEchoRow constant. */
const BAR_BG = "\x1b[48;2;55;55;55m";
const BAR_BG_OFF = "\x1b[49m";
const BAR_FG = "\x1b[38;2;255;255;255m";
const BAR_FG_OFF = "\x1b[39m";

/** Gutter `  ⎿  ` is 5 visible cells; continuation rows align with spaces. */
const GUTTER_VISIBLE_WIDTH = 5;
const CONTINUATION = " ".repeat(GUTTER_VISIBLE_WIDTH);

/** Collapsed bodies clip here (host ctrl+o expands; no per-card state). */
export const CLIP_LINES = 12;

/** One body row: plain toolOutput text, or a white lead-in + rest. */
export type BodyLine = string | { strong: string; rest: string };

/** Component contract subset CustomMessageComponent consumes. */
export interface RowsComponent {
	invalidate(): void;
	render(width: number): string[];
}

/** Plain-text fallback rows for a failed styled render (never throws). */
function rawFallback(body: readonly BodyLine[]): string[] {
	return body.map((l) => (typeof l === "string" ? l : l.strong + l.rest));
}

/** CC user command bar: dim `❯ ` + white text on the CC user-bar gray. */
export function ccCommandBar(command: string, theme: CcRowTheme): RowsComponent {
	return {
		invalidate() {},
		render(width: number): string[] {
			const avail = Math.max(10, width - 2);
			const clipped = truncateToWidth(command, avail, "…");
			const content = `${theme.fg("dim", "❯ ")}${BAR_FG}${clipped}${BAR_FG_OFF}`;
			// NBSP padding: plain trailing spaces get trimmed downstream.
			const pad = "\u00A0".repeat(Math.max(0, width - visibleWidth(content) - 1));
			return [`${BAR_BG}${content}${pad}${BAR_BG_OFF}`];
		},
	};
}

/** `⏺ Summary` head row: accent dot + bold toolTitle, truncated to width. */
export function ccSummaryRow(summary: string, theme: CcRowTheme): RowsComponent {
	return {
		invalidate() {},
		render(width: number): string[] {
			const avail = Math.max(10, width - visibleWidth("⏺ "));
			const head = `${theme.fg("accent", "⏺")} ${theme.bold(theme.fg("toolTitle", truncateToWidth(summary, avail, "…")))}`;
			return [head];
		},
	};
}

/** Single terminal-state row (`⏺ Plan Complete ✓`) — no body, no bar. */
export function ccSingleRow(title: string, theme: CcRowTheme, tail?: { text: string; color: string }): RowsComponent {
	return {
		invalidate() {},
		render(width: number): string[] {
			const avail = Math.max(10, width - visibleWidth("⏺ "));
			const core = truncateToWidth(title, avail - visibleWidth(tail?.text ?? ""), "…");
			const head = `${theme.fg("accent", "⏺")} ${theme.bold(theme.fg("toolTitle", core))}${tail ? theme.fg(tail.color, tail.text) : ""}`;
			return [head];
		},
	};
}

/** Paint one wrapped fragment: the leading `strong` region stays white. */
function paintFragment(fragment: string, strongLeft: number, theme: CcRowTheme): { painted: string; strongLeft: number } {
	const take = Math.min(strongLeft, fragment.length);
	const strongPart = take > 0 ? theme.fg("toolTitle", fragment.slice(0, take)) : "";
	const restPart = fragment.length > take ? theme.fg("toolOutput", fragment.slice(take)) : "";
	return { painted: strongPart + restPart, strongLeft: strongLeft - take };
}

/**
 * `⎿` body block: dim gutter on the first row, 5-space continuation, every
 * row wrapped to the viewport. Collapsed (`expanded === false`) bodies past
 * CLIP_LINES clip with a dim hint row.
 */
export function ccBodyBlock(body: readonly BodyLine[], theme: CcRowTheme, expanded: boolean): RowsComponent {
	return {
		invalidate() {},
		render(width: number): string[] {
			const rows: string[] = [];
			const gutter = theme.fg("dim", `  ⎿  `);
			const wrapW = Math.max(10, width - GUTTER_VISIBLE_WIDTH);
			const lines = body.slice(0, expanded ? body.length : CLIP_LINES);
			for (const line of lines) {
				const text = typeof line === "string" ? line : line.strong + line.rest;
				let strongLeft = typeof line === "string" ? 0 : line.strong.length;
				// Body rows are plain text (shapers strip styling), so fragments
				// offset cleanly against the strong budget.
				for (const fragment of wrapTextWithAnsi(text, wrapW)) {
					const { painted, strongLeft: next } = paintFragment(fragment, strongLeft, theme);
					strongLeft = next;
					rows.push(`${rows.length === 0 ? gutter : CONTINUATION}${painted}`);
				}
			}
			if (!expanded && body.length > CLIP_LINES) {
				const hint = `… +${body.length - CLIP_LINES} more lines (ctrl+o to expand)`;
				rows.push(`${rows.length === 0 ? gutter : CONTINUATION}${theme.fg("dim", hint)}`);
			}
			return rows;
		},
	};
}

/** Assembled panel: optional bar / summary / body (each part skippable). */
export interface CcPanelParts {
	/** Command bar text (usually details.command); absent = no bar. */
	bar?: string;
	/** Summary row text; absent = degraded panel (body only). */
	summary?: string;
	/** Body rows under the ⎿ gutter. */
	body?: BodyLine[];
	/** Alternative single-row form (plan-complete); wins over bar/summary/body. */
	single?: { title: string; tail?: { text: string; color: string } };
}

/** Flat panel assembly — bar + ⏺ summary + ⎿ body, in the CC language. */
export function ccPanel(parts: CcPanelParts, theme: CcRowTheme, expanded: boolean): RowsComponent {
	return {
		invalidate() {},
		render(width: number): string[] {
			try {
				if (parts.single) return ccSingleRow(parts.single.title, theme, parts.single.tail).render(width);
				const rows: string[] = [];
				if (parts.bar) rows.push(...ccCommandBar(parts.bar, theme).render(width));
				if (parts.summary) rows.push(...ccSummaryRow(parts.summary, theme).render(width));
				if (parts.body && parts.body.length > 0) rows.push(...ccBodyBlock(parts.body, theme, expanded).render(width));
				return rows;
			} catch {
				// Styled assembly failed — emit the raw text rather than throwing
				// from a render callback (AGENTS trap 1; pi cannot catch us here).
				return rawFallback(parts.body ?? []);
			}
		},
	};
}
