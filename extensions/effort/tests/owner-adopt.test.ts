/*
 * SPEC EFF-04: external thinking-change adoption through the
 * thinking_level_select listener guard (lastApplied semantics).
 * The fake pi reproduces the REAL pi ordering: setThinkingLevel updates its
 * state FIRST, then emits the event (agent-session.js 0.87/0.99) — a fake
 * that emits before updating hides the exact no-slot false-skip this suite
 * pins (spec review finding).
 */
import test from "node:test";
import assert from "node:assert/strict";
import type { ThinkingLevel } from "@earendil-works/pi-ai";
import { getSharedEffortOwner, newEffortOwner, type EffortOwner } from "../../../lib/effort-owner.ts";

interface FakePi {
	thinkingLevel: ThinkingLevel;
	listeners: Array<(event: { type: "thinking_level_select"; level: ThinkingLevel; previousLevel: ThinkingLevel }) => void>;
	getThinkingLevel(): ThinkingLevel;
	setThinkingLevel(level: ThinkingLevel): void;
	on(event: "thinking_level_select", handler: (event: { level: ThinkingLevel; previousLevel: ThinkingLevel }) => void): () => void;
}

function makeFakePi(initial: ThinkingLevel = "medium"): FakePi {
	const pi: FakePi = {
		thinkingLevel: initial,
		listeners: [],
		getThinkingLevel: () => pi.thinkingLevel,
		setThinkingLevel(level) {
			// REAL ordering: state first...
			pi.thinkingLevel = level;
			// ...then the event.
			for (const listener of pi.listeners) listener({ type: "thinking_level_select", level, previousLevel: initial });
		},
		on(_event, handler) {
			pi.listeners.push(handler);
			return () => {};
		},
	};
	return pi;
}

/** Mirror of the extension listener (extensions/effort/index.ts). */
function attachAdopter(pi: FakePi, owner: EffortOwner, publish: (source: string) => void): void {
	pi.on("thinking_level_select", (event) => {
		if (event.level === owner.lastApplied()) return;
		const outcome = owner.setExplicit(event.level, "shortcut");
		if (outcome === "pinned-by-env") return;
		publish(owner.currentSource());
	});
}

test("EFF-04① no-slot state: external change adopts as session-level explicit (main scenario)", () => {
	const pi = makeFakePi("medium");
	const owner = newEffortOwner(pi as never);
	const sources: string[] = [];
	attachAdopter(pi, owner, (source) => sources.push(source));
	assert.equal(owner.lastApplied(), null);

	// External writer (pi's thinking.cycle) — state updates, event fires.
	pi.setThinkingLevel("high");

	assert.equal(owner.effective(), "high");
	assert.equal(owner.currentSource(), "session");
	assert.deepEqual(sources, ["session"]);
});

test("EFF-04② owner's own apply is skipped (echo guard via lastApplied)", () => {
	const pi = makeFakePi("medium");
	const owner = newEffortOwner(pi as never);
	let adoptions = 0;
	attachAdopter(pi, owner, () => {
		adoptions += 1;
	});

	// Owner write → apply → setThinkingLevel → event(level==lastApplied) → skip.
	owner.setExplicit("low", "command");
	assert.equal(pi.thinkingLevel, "low");
	assert.equal(owner.lastApplied(), "low");
	assert.equal(adoptions, 0);
	assert.equal(owner.currentSource(), "session"); // stays the command write
});

test("EFF-04③ env pin refuses the external change", () => {
	const pi = makeFakePi("medium");
	const owner = newEffortOwner(pi as never);
	owner.setFromEnv("low");
	const sources: string[] = [];
	attachAdopter(pi, owner, (source) => sources.push(source));

	pi.setThinkingLevel("high"); // event fires; owner refuses

	assert.equal(owner.effective(), "low"); // env pin wins
	assert.deepEqual(sources, []); // pinned-by-env: no bus publish
});

test("EFF-04④ reset falls back to profile and the echo is swallowed", () => {
	const pi = makeFakePi("medium");
	const owner = newEffortOwner(pi as never);
	attachAdopter(pi, owner, () => {});

	owner.setFromProfile("high", "main"); // profile slot; apply writes high
	owner.setExplicit("low", "command"); // user override; apply writes low
	assert.equal(pi.thinkingLevel, "low");

	owner.resetExplicit(); // apply writes profile's high → echo skipped
	assert.equal(pi.thinkingLevel, "high");
	assert.equal(owner.currentSource(), "profile");
	assert.equal(owner.effective(), "high");
});

test("shared owner: lastApplied survives getSharedEffortOwner identity", () => {
	const pi = makeFakePi("medium");
	const owner = getSharedEffortOwner(pi as never);
	owner.setExplicit("xhigh", "command");
	assert.equal(getSharedEffortOwner(pi as never).lastApplied(), "xhigh");
});
