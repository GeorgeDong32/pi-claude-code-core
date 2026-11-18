import { Container, Text, type Component } from "@earendil-works/pi-tui";

import { type ThemeLike } from "../../lib/tool-render.ts";
import { interpretThenRunResult, type ThenRunOutcome } from "./outcome.ts";

export interface ThenRunArgs {
	then_run?: { command?: unknown };
}

export interface ThenRunRenderFacts {
	args?: ThenRunArgs;
	isPartial?: boolean;
}

export function withThenRunBadge(component: Component, args: ThenRunArgs | undefined, theme: ThemeLike): Component {
	const raw = args?.then_run?.command;
	if (typeof raw !== "string" || raw.trim() === "") return component;
	const wrapper = new Container();
	wrapper.addChild(component);
	wrapper.addChild(new Text(theme.fg("muted", `↳ then_run: ${raw.trim()}`), 0, 0));
	return wrapper;
}

const OUTCOME_ROWS: Record<ThenRunOutcome, { label: string; role: string }> = {
	failed: { label: "✗ failed", role: "error" },
	skipped: { label: "⊘ skipped", role: "muted" },
	succeeded: { label: "✓ ok", role: "toolTitle" },
};

export function thenRunStatusRow(result: { content?: unknown; details?: unknown }, theme: ThemeLike, facts: ThenRunRenderFacts = {}): string | null {
	if (facts.isPartial) return null;
	if (facts.args !== undefined && (typeof facts.args.then_run?.command !== "string" || facts.args.then_run.command.trim() === "")) {
		return null;
	}
	const outcome = interpretThenRunResult(result);
	if (outcome === null) return null;
	const spec = OUTCOME_ROWS[outcome];
	return theme.fg(spec.role, `↳ then_run ${spec.label}`);
}

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
