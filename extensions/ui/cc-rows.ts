import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

export interface CcRowTheme {
	fg(color: string, text: string): string;
	bold(text: string): string;
}

// CC themes deliberately blank `userMessageBg` (CC-TUI owns user-message
// painting there) — a themed lookup would render a transparent bar, so the
// command bar uses CC's user-bar constant rgb(55,55,55).
const BAR_BG = "\x1b[48;2;55;55;55m";
const BAR_BG_OFF = "\x1b[49m";
const BAR_FG = "\x1b[38;2;255;255;255m";
const BAR_FG_OFF = "\x1b[39m";

const GUTTER_VISIBLE_WIDTH = 5;
const CONTINUATION = " ".repeat(GUTTER_VISIBLE_WIDTH);

export const CLIP_LINES = 12;

export type BodyLine = string | { strong: string; rest: string };

export interface RowsComponent {
	invalidate(): void;
	render(width: number): string[];
}

/** Render callbacks run in stacks pi cannot catch — a render must never
 * throw; these are the raw unstyled body lines. */
function rawFallback(body: readonly BodyLine[]): string[] {
	return body.map((l) => (typeof l === "string" ? l : l.strong + l.rest));
}

export function ccCommandBar(command: string, theme: CcRowTheme): RowsComponent {
	return {
		invalidate() {},
		render(width: number): string[] {
			const avail = Math.max(10, width - 2);
			const clipped = truncateToWidth(command, avail, "…");
			const content = `${theme.fg("dim", "❯ ")}${BAR_FG}${clipped}${BAR_FG_OFF}`;
			const pad = "\u00A0".repeat(Math.max(0, width - visibleWidth(content) - 1));
			return [`${BAR_BG}${content}${pad}${BAR_BG_OFF}`];
		},
	};
}

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

function paintFragment(fragment: string, strongLeft: number, theme: CcRowTheme): { painted: string; strongLeft: number } {
	const take = Math.min(strongLeft, fragment.length);
	const strongPart = take > 0 ? theme.fg("toolTitle", fragment.slice(0, take)) : "";
	const restPart = fragment.length > take ? theme.fg("toolOutput", fragment.slice(take)) : "";
	return { painted: strongPart + restPart, strongLeft: strongLeft - take };
}

export function ccBodyBlock(body: readonly BodyLine[], theme: CcRowTheme, expanded: boolean): RowsComponent {
	// `expanded` mirrors the host's global expansion toggle (ctrl+o) — no
	// per-component fold state; the hint literal matches pi's default wording.
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

export interface CcPanelParts {
	bar?: string;
	summary?: string;
	body?: BodyLine[];
	single?: { title: string; tail?: { text: string; color: string } };
}

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
				return rawFallback(parts.body ?? []);
			}
		},
	};
}
