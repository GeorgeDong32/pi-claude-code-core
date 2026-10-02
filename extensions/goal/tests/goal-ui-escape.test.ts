/**
 * INTERRUPT SAFETY pin (fix 2026-10-02): the goal Esc-to-pause raw-input
 * listener must never steal the user's interrupt. Observed failure: a hung
 * update_goal audit + Esc → the listener ran pauseActiveGoal synchronously
 * inside the TUI input-dispatch loop, breaking the chain before the focused
 * component saw Escape — no way to interrupt a stuck agent. Flat node:test.
 */
import assert from "node:assert/strict";
import test from "node:test";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createGoalUi, type GoalUiDeps } from "../ui.ts";

function fakeCtx(): { ctx: ExtensionContext; handlers: Array<(data: string) => unknown> } {
	const handlers: Array<(data: string) => unknown> = [];
	const ctx = {
		hasUI: true,
		ui: {
			onTerminalInput: (handler: (data: string) => unknown) => {
				handlers.push(handler);
				return () => {};
			},
		},
	} as unknown as ExtensionContext;
	return { ctx, handlers };
}

function deps(overrides: Partial<GoalUiDeps> = {}): GoalUiDeps {
	return {
		getDisplayGoal: () => null,
		getOpenGoalCount: () => 0,
		getOtherOpenGoalCount: () => 0,
		isGoalActive: () => true,
		shouldPauseOnEscape: () => true,
		isAgentIdle: () => true,
		pauseActiveGoal: () => {},
		...overrides,
	};
}

const ESC = "\x1b";
const flushMicrotask = () => new Promise<void>((resolve) => queueMicrotask(resolve));

test("busy agent: Escape is NOT claimed — pause never fires, key passes through", async () => {
	const { ctx, handlers } = fakeCtx();
	let paused = 0;
	createGoalUi(deps({ isAgentIdle: () => false, pauseActiveGoal: () => { paused += 1; } })).syncTerminalInputPause(ctx);
	const result = handlers[0]?.(ESC);
	await flushMicrotask();
	assert.equal(paused, 0, "busy agent: pause must not fire");
	assert.equal(result, undefined, "listener must return undefined — the interrupt passes through");
});

test("idle agent: Escape dispatches the pause asynchronously", async () => {
	const { ctx, handlers } = fakeCtx();
	let paused = 0;
	createGoalUi(deps({ pauseActiveGoal: () => { paused += 1; } })).syncTerminalInputPause(ctx);
	const result = handlers[0]?.(ESC);
	assert.equal(paused, 0, "the pause must NOT run synchronously inside the input-dispatch loop");
	await flushMicrotask();
	assert.equal(paused, 1);
	assert.equal(result, undefined, "still never consumed — the interrupt path stays intact");
});

test("a throwing pauseActiveGoal cannot break the input chain", async () => {
	const { ctx, handlers } = fakeCtx();
	createGoalUi(deps({ pauseActiveGoal: () => { throw new Error("disk exploded"); } })).syncTerminalInputPause(ctx);
	let threw = false;
	try {
		const result = handlers[0]?.(ESC);
		assert.equal(result, undefined);
		await flushMicrotask();
	} catch {
		threw = true;
	}
	assert.equal(threw, false, "the microtask wrapper swallows — nothing escapes into the TUI");
});

test("non-Escape keys and inactive goals never trigger the pause", async () => {
	const { ctx, handlers } = fakeCtx();
	let paused = 0;
	createGoalUi(deps({ pauseActiveGoal: () => { paused += 1; } })).syncTerminalInputPause(ctx);
	handlers[0]?.("a");
	handlers[0]?.("\x1b[A"); // arrow up — an escape SEQUENCE, not the bare Escape key
	await flushMicrotask();
	assert.equal(paused, 0);
});

test("headless ctx (no hasUI): no subscription at all", () => {
	const handlers: Array<(data: string) => unknown> = [];
	const ctx = {
		hasUI: false,
		ui: {
			onTerminalInput: (handler: (data: string) => unknown) => {
				handlers.push(handler);
				return () => {};
			},
		},
	} as unknown as ExtensionContext;
	createGoalUi(deps()).syncTerminalInputPause(ctx);
	assert.equal(handlers.length, 0);
});
