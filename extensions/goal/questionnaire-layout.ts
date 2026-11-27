
export const DEFAULT_TERMINAL_HEIGHT = 24;

export const HEIGHT_RESERVE = 6;

export const MAX_OPTION_WINDOW = 7;

export function pickTerminalHeight(candidates: Array<number | undefined>): number {
	for (const value of candidates) {
		if (typeof value === "number" && Number.isFinite(value) && value > 0) return Math.floor(value);
	}
	return DEFAULT_TERMINAL_HEIGHT;
}

export function availableDialogHeight(terminalHeight: number): number {
	return Math.min(terminalHeight - HEIGHT_RESERVE, terminalHeight);
}

export function clampScrollOffset(offset: number, totalLines: number, viewport: number): number {
	return Math.min(Math.max(0, offset), Math.max(0, totalLines - viewport));
}

export function scrollStep(viewport: number, mode: "half" | "page"): number {
	if (mode === "page") return Math.max(1, Math.max(0, viewport));
	return Math.max(1, Math.floor(Math.max(0, viewport) / 2));
}

export function sliceScrollWindow(lines: string[], offset: number, viewport: number): string[] {
	const start = clampScrollOffset(offset, lines.length, viewport);
	return lines.slice(start, start + Math.max(0, viewport));
}

export function scrollIndicatorLine(offset: number, totalLines: number, viewport: number): string | null {
	if (viewport < 1 || totalLines <= viewport) return null;
	const start = clampScrollOffset(offset, totalLines, viewport);
	const from = start + 1;
	const to = Math.min(totalLines, start + viewport);
	return `(lines ${from}–${to} of ${totalLines} · ctrl+u/ctrl+d to scroll)`;
}

export interface OptionWindow {
	start: number;
	shown: number;
	hidden: number;
}

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
	header: string[];
	body: string[];
	footer: string[];
}

export interface DialogLayoutPlan {
	overflow: boolean;
	viewport: number;
	indicator: string | null;
	visibleBody: string[];
	totalHeight: number;
}

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
