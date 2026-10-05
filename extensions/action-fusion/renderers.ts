/**
 * action-fusion/renderers.ts — the then_run presentation badges
 * (spec 2026-10-02-core-tool-renderers TR §2/B, revised per self-review R1;
 * AR1005-FU 2026-10-05: result interpretation delegated to outcome.ts).
 *
 * Principle: WRAP, never rewrite. The built-in edit/write renderers keep
 * rendering their own output untouched (CMP-03 zero-new-rendering-surface
 * stays true for the payload); the badges are APPENDED rows in a Container
 * wrapper.
 *
 * AR1005-FU-01: the status row comes from interpretThenRunResult — the
 * structured `details.thenRun` outcome is the first authority, so a log
 * body containing the opposite marker can no longer flip a known success,
 * and the production `[then_run:succeeded]` token now actually shows the
 * success badge (the old scan looked for a `[then_run:ok]` token that
 * production never writes). The UI label keeps its design ("✓ ok"); the
 * protocol token is NOT renamed. No marker constants live here.
 *
 * AR1005-FU-02: renderers consume the host-provided render facts
 * (ToolRenderContext.args / .isPartial / ToolRenderResultOptions.isPartial)
 * by capability detection — a result whose call args carry no then_run is
 * NEVER wrapped (zero-wrap rule, even if the body contains a marker); a
 * partial/streaming result never shows a terminal state. Hosts without
 * these fields (args undefined) fall back to the legacy marker-scan path
 * so historical replay on old hosts keeps working.
 */
import { Container, Text, type Component } from "@earendil-works/pi-tui";

import { type ThemeLike } from "../../lib/tool-render.ts";
import { interpretThenRunResult, type ThenRunOutcome } from "./outcome.ts";

export interface ThenRunArgs {
	then_run?: { command?: unknown };
}

/** Host-provided render facts (FU-02) — capability-detected, all optional. */
export interface ThenRunRenderFacts {
	/** The call's arguments (ToolRenderContext.args). Present-but-without
	 * then_run = plain write/edit = never wrap. undefined = old host / not
	 * available → legacy marker-scan behavior. */
	args?: ThenRunArgs;
	/** Partial/streaming results never show a terminal state. */
	isPartial?: boolean;
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

/** Outcome → row styling. The success label keeps the TR-era design text
 * ("✓ ok"); the protocol token itself stays `[then_run:succeeded]`. */
const OUTCOME_ROWS: Record<ThenRunOutcome, { label: string; role: string }> = {
	failed: { label: "✗ failed", role: "error" },
	skipped: { label: "⊘ skipped", role: "muted" },
	succeeded: { label: "✓ ok", role: "toolTitle" },
};

/** The styled status row for a fused result, or null when there is nothing
 * to show: no then_run outcome, a plain (then_run-less) call, or a partial
 * stream (FU-02: no terminal state before the result is final). */
export function thenRunStatusRow(result: { content?: unknown; details?: unknown }, theme: ThemeLike, facts: ThenRunRenderFacts = {}): string | null {
	if (facts.isPartial) return null;
	if (facts.args !== undefined && (typeof facts.args.then_run?.command !== "string" || facts.args.then_run.command.trim() === "")) {
		return null; // zero-wrap rule: plain write/edit, marker-bearing body or not
	}
	const outcome = interpretThenRunResult(result);
	if (outcome === null) return null;
	const spec = OUTCOME_ROWS[outcome];
	return theme.fg(spec.role, `↳ then_run ${spec.label}`);
}

/** Badge wrapper for the RESULT renderer (same zero-wrap rule). */
export function withThenRunStatus(
	component: Component,
	result: { content?: unknown; details?: unknown },
	theme: ThemeLike,
	facts: ThenRunRenderFacts = {},
): Component {
	const row = thenRunStatusRow(result, theme, facts);
	if (row === null) return component;
	const wrapper = new Container();
	wrapper.addChild(component);
	wrapper.addChild(new Text(row, 0, 0));
	return wrapper;
}
