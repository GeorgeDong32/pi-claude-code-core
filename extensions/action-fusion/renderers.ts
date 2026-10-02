/**
 * action-fusion/renderers.ts — the then_run presentation badges
 * (spec 2026-10-02-core-tool-renderers TR §2/B, revised per self-review R1).
 *
 * Principle: WRAP, never rewrite. The built-in edit/write renderers keep
 * rendering their own output untouched (CMP-03 zero-new-rendering-surface
 * stays true for the payload); the badges are APPENDED rows in a Container
 * wrapper. The result status row is SCANNED read-only from the result text
 * markers — the model-visible protocol text is never modified.
 */
import { Container, Text, type Component } from "@earendil-works/pi-tui";

import { resultText, type ThemeLike } from "../../lib/tool-render.ts";

export interface ThenRunArgs {
	then_run?: { command?: unknown };
}

/** Badge row for the CALL renderer: `↳ then_run: <command>`. Returns the
 * builtin component untouched when no then_run command is present (no
 * wrapper, no layout delta for plain write/edit). */
export function withThenRunBadge(component: Component, args: ThenRunArgs | undefined, theme: ThemeLike): Component {
	const raw = args?.then_run?.command;
	if (typeof raw !== "string" || raw.trim() === "") return component;
	const wrapper = new Container();
	wrapper.addChild(component);
	wrapper.addChild(new Text(theme.fg("muted", `↳ then_run: ${raw.trim()}`), 0, 0));
	return wrapper;
}

interface MarkerSpec {
	marker: string;
	label: string;
	role: string;
}

/** Result markers written by then-run.ts — the badge re-states the OUTCOME
 * (colored, gutter-aligned with the call badge); exit output stays in the
 * builtin-rendered body. */
const MARKERS: readonly MarkerSpec[] = [
	{ marker: "[then_run:failed]", label: "✗ failed", role: "error" },
	{ marker: "[then_run:skipped]", label: "⊘ skipped", role: "muted" },
	{ marker: "[then_run:ok]", label: "✓ ok", role: "toolTitle" },
];

/** The styled status row for a fused result, or null when the result text
 * carries no then_run marker (plain write/edit — returns untouched). */
export function thenRunStatusRow(result: { content?: unknown }, theme: ThemeLike): string | null {
	const text = resultText(result);
	if (!text) return null;
	for (const spec of MARKERS) {
		if (text.includes(spec.marker)) return theme.fg(spec.role, `↳ then_run ${spec.label}`);
	}
	return null;
}

/** Badge wrapper for the RESULT renderer (same zero-wrap rule). */
export function withThenRunStatus(component: Component, result: { content?: unknown }, theme: ThemeLike): Component {
	const row = thenRunStatusRow(result, theme);
	if (row === null) return component;
	const wrapper = new Container();
	wrapper.addChild(component);
	wrapper.addChild(new Text(row, 0, 0));
	return wrapper;
}
