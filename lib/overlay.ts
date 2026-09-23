/**
 * Shared overlay picker skeleton (P0-LB-03).
 *
 * Wraps `ctx.ui.custom` + `overlayOptions` behind one helper that renders a
 * vertical list with a selected state and degrades gracefully outside the
 * TUI (rpc/json/print modes fall back to `ctx.ui.select`; headless returns
 * null). First consumer: pi-effort effort-picker (P1-EF-02); then pm
 * plan-approval-dialog (P1-PM-04 ③) and the goal dialog (P2-GO-03a).
 */

import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, visibleWidth } from "@earendil-works/pi-tui";
import type { Component, OverlayOptions } from "@earendil-works/pi-tui";

export interface OverlayItem {
	/** Value returned by showOverlay on confirm. */
	value: string;
	/** Visible label (may differ from value). */
	label: string;
	/** Optional dimmed right-aligned hint. */
	hint?: string;
}

export interface ShowOverlayOptions {
	title: string;
	items: OverlayItem[];
	/** Initial selection by value; defaults to the first item. */
	selected?: string;
	/** Footer hint line; sensible default provided. */
	footer?: string;
	/** Overlay geometry passthrough (anchor/width/margins...). */
	overlayOptions?: OverlayOptions;
}

/**
 * Show a list overlay. Resolves with the selected item's `value`, or null
 * when cancelled / unavailable (headless). Never throws to the caller: a
 * failing `custom` falls back to `select`.
 */
export async function showOverlay(
	ctx: ExtensionCommandContext,
	options: ShowOverlayOptions,
): Promise<string | null> {
	if (!ctx.hasUI) return null;

	if (ctx.mode === "tui" && typeof ctx.ui.custom === "function") {
		try {
			const result = await ctx.ui.custom<string | null>(
				(_tui, theme, _kb, done) =>
					createListComponent({ ...options, theme, done }),
				{
					overlay: true,
					overlayOptions: options.overlayOptions ?? defaultGeometry(),
				},
			);
			return result ?? null;
		} catch {
			// Fall through to the select() degradation.
		}
	}

	if (typeof ctx.ui.select !== "function") return null;
	const labels = options.items.map((i) => i.label);
	const chosen = await ctx.ui.select(options.title, labels);
	const item = options.items.find((i) => i.label === chosen);
	return item ? item.value : null;
}

/**
 * Shared overlay plumbing for a CUSTOM component (P0-LB-03; consumers:
 * effort-picker P1, pm plan-approval-dialog P1-PM-04③, goal dialog P2).
 *
 * Thin wrapper over `ctx.ui.custom` that centralizes the `overlay:true` +
 * geometry passthrough pattern. The component keeps full ownership of its
 * rendering and key handling; the caller owns the fallback behavior outside
 * TUI contexts. Throws through like `ctx.ui.custom` does (no silent
 * degradation for components that cannot be expressed as a select list).
 */
/** Minimal UI surface showComponentOverlay needs (both ctx variants have it). */
export interface CustomOverlayContext {
	ui: {
		custom: <T>(
			factory: (tui: unknown, theme: unknown, kb: unknown, done: (v: T) => void) => Component,
			options?: { overlay?: boolean; overlayOptions?: OverlayOptions },
		) => Promise<T>;
	};
}

export async function showComponentOverlay<T>(
	ctx: CustomOverlayContext,
	options: {
		/**
		 * `any` params deliberately: each consumer's component declares its own
		 * concrete tui/theme types (pi's Theme/TUI generics differ per ctx
		 * variant), so the shared plumbing stays type-agnostic.
		 */
		component: (tui: any, theme: any, kb: any, done: (value: T) => void) => Component;
		/**
		 * Geometry passthrough. Omitted = called WITHOUT overlay options,
		 * exactly like a bare `ctx.ui.custom(factory)` (goal questionnaire);
		 * provided = `overlay: true` + geometry (effort picker, plan dialog).
		 */
		overlayOptions?: OverlayOptions;
	},
): Promise<T> {
	return ctx.ui.custom<T>(
		(tui, theme, kb, done) => options.component(tui, theme, kb, done),
		options.overlayOptions
			? { overlay: true, overlayOptions: options.overlayOptions }
			: undefined,
	);
}

function defaultGeometry(): OverlayOptions {
	return {
		anchor: "center",
		width: 78,
		minWidth: 60,
		maxHeight: "40%",
	};
}

// ---- list component -------------------------------------------------------

const DEFAULT_FOOTER = "↑/↓ to move · Enter to confirm · Esc to cancel";

interface ListComponentOptions extends ShowOverlayOptions {
	theme: Theme | undefined;
	done: (value: string | null) => void;
}

export function createListComponent(options: ListComponentOptions): Component & { dispose?(): void } {
	return new ListComponent(options);
}

class ListComponent implements Component {
	private readonly items: OverlayItem[];
	private readonly title: string;
	private readonly footer: string;
	private readonly theme: Theme | undefined;
	private readonly done: (value: string | null) => void;
	private selectedIndex: number;
	private cachedLines: string[] | undefined;
	private cachedWidth: number | undefined;
	private disposed = false;

	constructor(options: ListComponentOptions) {
		this.items = options.items;
		this.title = options.title;
		this.footer = options.footer ?? DEFAULT_FOOTER;
		this.theme = options.theme;
		this.done = options.done;

		const initial = options.selected
			? this.items.findIndex((i) => i.value === options.selected)
			: 0;
		this.selectedIndex = initial >= 0 ? initial : 0;
	}

	handleInput(data: string): void {
		if (this.disposed) return;
		if (matchesKey(data, Key.up) || matchesKey(data, Key.left)) {
			if (this.selectedIndex > 0) {
				this.selectedIndex--;
				this.invalidate();
			}
			return;
		}
		if (matchesKey(data, Key.down) || matchesKey(data, Key.right) || matchesKey(data, Key.tab)) {
			if (this.selectedIndex < this.items.length - 1) {
				this.selectedIndex++;
				this.invalidate();
			}
			return;
		}
		if (matchesKey(data, Key.enter)) {
			this.finish(this.items[this.selectedIndex]?.value ?? null);
			return;
		}
		if (matchesKey(data, Key.escape)) {
			this.finish(null);
			return;
		}
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
		const lines = this.computeLines(width);
		this.cachedLines = lines;
		this.cachedWidth = width;
		return lines;
	}

	invalidate(): void {
		this.cachedLines = undefined;
		this.cachedWidth = undefined;
	}

	dispose(): void {
		this.disposed = true;
	}

	private finish(value: string | null): void {
		if (this.disposed) return;
		this.disposed = true;
		this.done(value);
	}

	private computeLines(width: number): string[] {
		const inner = Math.max(20, width - 2);
		const dim = (t: string): string => this.theme?.fg("dim", t) ?? t;
		const bold = (t: string): string => this.theme?.bold(t) ?? t;
		const inverse = (t: string): string => this.theme?.inverse(t) ?? t;
		const accent = (t: string): string => this.theme?.fg("accent", t) ?? t;

		const content: string[] = [bold(accent(this.title)), ""];
		for (let i = 0; i < this.items.length; i++) {
			const item = this.items[i];
			const marker = i === this.selectedIndex ? inverse(bold(` ${item.label} `)) : ` ${item.label} `;
			let line = marker;
			if (item.hint) {
				const pad = Math.max(1, inner - visibleWidth(marker) - visibleWidth(item.hint));
				line = marker + " ".repeat(pad) + dim(item.hint);
			}
			content.push(line);
		}
		content.push("", dim(this.footer));
		return content;
	}
}
