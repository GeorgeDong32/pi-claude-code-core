/**
 * Ordering is the contract: pi renders/commands/tools dispatch by registration
 * order for override resolution, and the compaction wiring relies on the
 * handler sequence around session_before_compact/session_compact.
 */
import test from "node:test";
import assert from "node:assert/strict";
import goalExtension from "../goal.ts";
import { FakeHost } from "../../../test/contracts/fake-host.ts";

const RENDERERS = ["pi-goal-event", "pi-goal-audit-event"];

const COMMANDS = [
	"goal",
	"goal-status",
	"goal-list",
	"goal-focus",
	"goal-settings",
	"goals",
	"sisyphus",
	"goals-set",
	"sisyphus-set",
	"goal-tweak",
	"goal-clear",
	"goal-abort",
	"goal-pause",
	"goal-resume",
	"goal-note",
];

const GOAL_TOOLS = [
	"get_goal",
	"create_goal",
	"propose_goal_draft",
	"update_goal",
	"pause_goal",
	"abort_goal",
	"step_complete",
	"apply_goal_tweak",
];

const PI_EVENTS = [
	"context",
	"turn_start",
	"tool_call",
	"tool_execution_end",
	"tool_result",
	"turn_end",
	"agent_settled",
	"message_end",
	"session_start",
	"session_before_compact",
	"session_compact",
	"session_tree",
	"before_agent_start",
	"agent_end",
	"session_shutdown",
];

const FACTORY_ACTIVE_TOOLS = ["read", "edit", "write", "bash", "grep", "find", "get_goal", "propose_goal_draft"];

interface Recording {
	log: string[];
	renderers: string[];
	commands: string[];
}

function record(): { host: FakeHost; pi: Record<string, unknown>; rec: Recording } {
	const host = new FakeHost();
	const base = host.asPi() as Record<string, unknown>;
	const rec: Recording = { log: [], renderers: [], commands: [] };
	const pi: Record<string, unknown> = {
		...base,
		registerMessageRenderer(type: string, renderer: unknown) {
			rec.renderers.push(type);
			rec.log.push(`renderer:${type}`);
			(base.registerMessageRenderer as (t: string, r: unknown) => void)(type, renderer);
		},
		registerCommand(name: string, def: unknown) {
			rec.commands.push(name);
			rec.log.push(`command:${name}`);
			(base.registerCommand as (n: string, d: unknown) => void)(name, def);
		},
		registerTool(def: { name: string }) {
			rec.log.push(`tool:${def.name}`);
			(base.registerTool as (d: { name: string }) => void)(def);
		},
		setActiveTools(names: string[]) {
			rec.log.push("setActiveTools");
			(base.setActiveTools as (n: string[]) => void)(names);
		},
	};
	return { host, pi, rec };
}

test("E13a pin: message renderers register in order", () => {
	const { rec, pi } = record();
	goalExtension(pi as never);
	assert.deepEqual(rec.renderers, RENDERERS);
});

test("E13a pin: all commands register in original order", () => {
	const { rec, pi } = record();
	goalExtension(pi as never);
	assert.deepEqual(rec.commands, COMMANDS);
});

test("E13a pin: the eight goal tools register in original order", () => {
	const { rec, pi } = record();
	goalExtension(pi as never);
	const goalToolLog = rec.log.filter((entry) => entry.startsWith("tool:") && GOAL_TOOLS.includes(entry.slice(5)));
	assert.deepEqual(goalToolLog, GOAL_TOOLS.map((name) => `tool:${name}`));
});

test("E13a pin: goal tools are the LAST eight tool registrations (questionnaire tools first)", () => {
	const { rec, pi } = record();
	goalExtension(pi as never);
	const toolEntries = rec.log.filter((entry) => entry.startsWith("tool:"));
	const lastEight = toolEntries.slice(-8);
	assert.deepEqual(lastEight, GOAL_TOOLS.map((name) => `tool:${name}`));
});

test("E13a pin: all fifteen pi.on handlers register in original order", () => {
	const { host, pi, rec } = record();
	goalExtension(pi as never);
	assert.deepEqual([...host.handlers.keys()], PI_EVENTS);
});

test("E13a pin: full registration sequence — renderers, commands, questionnaire+goal tools, setActiveTools last", () => {
	const { rec, pi } = record();
	goalExtension(pi as never);
	assert.deepEqual(rec.log.slice(0, 2), RENDERERS.map((name) => `renderer:${name}`));
	assert.deepEqual(rec.log.slice(2, 2 + COMMANDS.length), COMMANDS.map((name) => `command:${name}`));
	const tail = rec.log.slice(2 + COMMANDS.length);
	assert.equal(tail[tail.length - 1], "setActiveTools", "factory-time syncGoalTools must be the last registration action");
	const toolTail = tail.slice(0, -1);
	assert.ok(toolTail.length > 0 && toolTail.every((entry) => entry.startsWith("tool:")), "only tool registrations between commands and setActiveTools");
});

test("E13a pin: factory-time setActiveTools call content is unchanged", () => {
	const { host, pi, rec } = record();
	goalExtension(pi as never);
	assert.equal(host.activeToolsCalls.length, 1);
	assert.deepEqual(host.activeToolsCalls[0], FACTORY_ACTIVE_TOOLS);
});
