/**
 * lib/tool-render.ts — shared presentation helpers for core tool renderers
 * (spec 2026-10-02-core-tool-renderers TR).
 *
 * Structural ThemeLike only: lib/ must not import extension or pi types
 * (invariant 1); renderers receive the live `theme` from pi's factory args
 * (TR-FACT F2/F4 — never capture ctx.ui.theme, it goes stale across session
 * switches).
 */

/** The slice of pi's Theme the renderers use (structural, no pi import). */
export interface ThemeLike {
	fg(role: string, text: string): string;
}

/** 1024-based human byte size, one decimal below 10. humanBytes(0) = "0B". */
export function humanBytes(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes <= 0) return "0B";
	const units = ["B", "KB", "MB", "GB"];
	let value = bytes;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit++;
	}
	const text = value >= 10 || unit === 0 ? Math.round(value).toString() : value.toFixed(1);
	return `${text}${units[unit]}`;
}

/** Keep at most `max` lines; returns [lines, hiddenCount]. */
export function firstLines(lines: readonly string[], max: number): [string[], number] {
	if (lines.length <= max) return [[...lines], 0];
	return [lines.slice(0, max), lines.length - max];
}

/** First text part of a tool result ("" when none) — the renderers' data
 * source alongside `details`. */
export function resultText(result: { content?: unknown }): string {
	const c = result.content;
	if (!Array.isArray(c)) return "";
	return (c as Array<{ type?: string; text?: string }>)
		.filter((p) => p?.type === "text" && typeof p.text === "string")
		.map((p) => p.text!)
		.join("\n");
}

/* ── Component assembly (pi-tui is a package dep, allowed in lib) ── */
import { Container, Text } from "@earendil-works/pi-tui";

/** A plain multi-row component: row 0 renders muted (header convention),
 * the rest as body. Fresh allocation per frame is acceptable for the small
 * C-tool rows (TR-FACT F5 discipline applies to the large obs_recall body). */
export function renderRows(rows: readonly string[], theme: ThemeLike, bodyRole = "toolOutput"): Container {
	const container = new Container();
	for (const [i, row] of rows.entries()) container.addChild(new Text(theme.fg(i === 0 ? "muted" : bodyRole, row), 0, 0));
	return container;
}
