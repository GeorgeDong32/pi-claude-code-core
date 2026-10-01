/**
 * Pure layout math for the goal questionnaire / confirmation dialog
 * (spec: 2026-10-01 goal-dialog-scroll, GDS-01).
 *
 * The dialog renders as three sections: a pinned header (separator, tab
 * bar, question), a scrollable body (question context / answer summary),
 * and a pinned footer (option window + key hints + separator). When the
 * body exceeds the viewport, header and footer stay visible and the body
 * is sliced by a clamped scroll offset. Everything here is pure so the
 * geometry is table-testable; the component (goal-questionnaire.ts) owns
 * state, key routing and theming.
 *
 * Height policy (GDS-05): terminal rows come from the pi-tui TUI instance
 * (`tui.terminal.rows`) first, then `process.stdout.rows`, then 24; the
 * usable dialog height is `min(rows - 6, rows)` — conservative so neither
 * the fullscreen dock (bottom-clipping) nor the non-fullscreen viewport
 * (top overflow into scrollback) is triggered.
 */

/** Fallback terminal height when no live source is available (GDS-05). */
export const DEFAULT_TERMINAL_HEIGHT = 24;

/** Rows reserved outside the dialog (transcript minimum, dock chrome). */
export const HEIGHT_RESERVE = 6;

/** Maximum option rows shown in the pinned footer window (spec §2.2). */
export const MAX_OPTION_WINDOW = 7;

/**
 * First usable (> 0, finite) value from `candidates`, else the 24-row
 * default. Candidates are injected by the caller (tui.terminal.rows, then
 * process.stdout.rows) so tests stay pure.
 */
export function pickTerminalHeight(candidates: Array<number | undefined>): number {
	for (const value of candidates) {
		if (typeof value === "number" && Number.isFinite(value) && value > 0) return Math.floor(value);
	}
	return DEFAULT_TERMINAL_HEIGHT;
}

/** Usable dialog height: reserve 6 rows, never exceed the terminal. */
export function availableDialogHeight(terminalHeight: number): number {
	return Math.min(terminalHeight - HEIGHT_RESERVE, terminalHeight);
}

/** Clamp a scroll offset to [0, max(0, totalLines - viewport)]. */
export function clampScrollOffset(offset: number, totalLines: number, viewport: number): number {
	return Math.min(Math.max(0, offset), Math.max(0, totalLines - viewport));
}

/** Half-page (ctrl+u/ctrl+d) or full-page (PageUp/PageDown) scroll step. */
export function scrollStep(viewport: number, mode: "half" | "page"): number {
	if (mode === "page") return Math.max(1, Math.max(0, viewport));
	return Math.max(1, Math.floor(Math.max(0, viewport) / 2));
}

/** Slice `lines` by the clamped offset into a full viewport window. */
export function sliceScrollWindow(lines: string[], offset: number, viewport: number): string[] {
	const start = clampScrollOffset(offset, lines.length, viewport);
	return lines.slice(start, start + Math.max(0, viewport));
}

/**
 * Scroll indicator text (1-based), e.g. `(lines 1–18 of 42 · ctrl+u/ctrl+d
 * to scroll)`, or null when everything fits or the viewport is degenerate.
 */
export function scrollIndicatorLine(offset: number, totalLines: number, viewport: number): string | null {
	if (viewport < 1 || totalLines <= viewport) return null;
	const start = clampScrollOffset(offset, totalLines, viewport);
	const from = start + 1;
	const to = Math.min(totalLines, start + viewport);
	return `(lines ${from}–${to} of ${totalLines} · ctrl+u/ctrl+d to scroll)`;
}

export interface OptionWindow {
	/** First option index shown. */
	start: number;
	/** Number of option rows shown (<= maxRows). */
	shown: number;
	/** Options hidden above/below the window. */
	hidden: number;
}

/**
 * Footer option window (spec §2.2): at most `maxRows` option rows, window
 * centered on the selected row so the selection always stays visible.
 */
export function optionWindow(optionCount: number, selectedIndex: number, maxRows: number = MAX_OPTION_WINDOW): OptionWindow {
	if (optionCount <= 0) return { start: 0, shown: 0, hidden: 0 };
	const shown = Math.min(optionCount, Math.max(1, Math.floor(maxRows)));
	if (optionCount <= shown) return { start: 0, shown: optionCount, hidden: 0 };
	const selected = Math.min(Math.max(0, selectedIndex), optionCount - 1);
	const centered = selected - Math.floor(shown / 2);
	const start = Math.min(Math.max(0, centered), optionCount - shown);
	return { start, shown, hidden: optionCount - shown };
}

export interface DialogSections {
	/** Pinned top lines. */
	header: string[];
	/** Scrollable candidate lines. */
	body: string[];
	/** Pinned bottom lines. */
	footer: string[];
}

export interface DialogLayoutPlan {
	/** True when the body must be sliced (indicator + pinned footer). */
	overflow: boolean;
	/** Body viewport after reserving header/footer (+ indicator). */
	viewport: number;
	/** Scroll indicator line (1-based), null when not shown. */
	indicator: string | null;
	/** Body lines to render (the full body when not overflowing). */
	visibleBody: string[];
	/** Final rendered line count. */
	totalHeight: number;
}

/**
 * Decide how the three sections fit into `availableHeight`. When the body
 * fits it passes through unchanged (short dialogs render exactly as the
 * legacy flat layout); otherwise one line is reserved for the scroll
 * indicator and the body is sliced by the clamped offset. Degenerate
 * budgets (header + footer alone >= availableHeight) never throw: the
 * viewport floors at 0 and the indicator is skipped.
 */
export function planDialogLayout(sections: DialogSections, args: { availableHeight: number; scrollOffset: number }): DialogLayoutPlan {
	const fit = Math.max(0, args.availableHeight - sections.header.length - sections.footer.length);
	if (sections.body.length <= fit) {
		return {
			overflow: false,
			viewport: fit,
			indicator: null,
			visibleBody: sections.body,
			totalHeight: sections.header.length + sections.body.length + sections.footer.length,
		};
	}
	// Overflow: reserve one line for the indicator when it fits.
	const withIndicator = fit - 1;
	const viewport = withIndicator >= 1 ? withIndicator : fit;
	const indicator = viewport >= 1 ? scrollIndicatorLine(args.scrollOffset, sections.body.length, viewport) : null;
	const visibleBody = sliceScrollWindow(sections.body, args.scrollOffset, viewport);
	return {
		overflow: true,
		viewport,
		indicator,
		visibleBody,
		totalHeight: sections.header.length + (indicator ? 1 : 0) + visibleBody.length + sections.footer.length,
	};
}
