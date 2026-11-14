/*
 * BH-E5 (spec 2026-11-14-backtest-hardening): the host resets the thinking
 * level INSIDE a model switch. AgentSession.setModel resolves
 * _getThinkingLevelForModelSwitch(model) (per-model override → global
 * default → current level) and calls setThinkingLevel, which emits
 * thinking_level_select from inside the setModel call (dist
 * agent-session.js 2115-2125 / 2210-2229; the runner dispatches handlers
 * synchronously up to the first await). The pre-fix listener adopted that
 * reset via setExplicit(…, "shortcut") — the model's switch default became
 * an EXPLICIT user choice (source "session"), which then outranks the
 * profile slot forever; a mode profile's :effort mapping died on the first
 * profile-driven model switch.
 *
 * The fake pi models the REAL contract: setModel applies the switch level
 * through setThinkingLevel (which emits), and the listener below mirrors
 * extensions/effort/index.ts including the BH-E5 model-switch branch.
 */
import test from "node:test";
import assert from "node:assert/strict";
import type { ThinkingLevel } from "@earendil-works/pi-ai";
import { newEffortOwner, type EffortOwner, type OwnerEffortLevel } from "../../../lib/effort-owner.ts";

/** pi's ThinkingLevel does not carry "off"; the owner's union does. */
type FakeLevel = OwnerEffortLevel;

interface FakePi {
	thinkingLevel: FakeLevel;
	listeners: Array<(event: { type: "thinking_level_select"; level: FakeLevel; previousLevel: FakeLevel }) => void>;
	getThinkingLevel(): FakeLevel;
	setThinkingLevel(level: FakeLevel): void;
	/** REAL host contract: setModel → setThinkingLevel(switch default) → emit. */
	setModel(model: { switchLevel?: FakeLevel }): Promise<boolean>;
	on(event: "thinking_level_select", handler: (event: { level: FakeLevel; previousLevel: FakeLevel }) => void): () => void;
}

function makeFakePi(initial: FakeLevel = "off"): FakePi {
	const pi = {
		thinkingLevel: initial,
		listeners: [] as FakePi["listeners"],
		getThinkingLevel: () => pi.thinkingLevel,
		setThinkingLevel(level: FakeLevel) {
			// REAL ordering: state first, then the event.
			const previous = pi.thinkingLevel;
			pi.thinkingLevel = level;
			if (previous !== level) {
				for (const listener of pi.listeners) listener({ type: "thinking_level_select", level, previousLevel: previous });
			}
		},
		async setModel(model: { switchLevel?: FakeLevel }) {
			const switchLevel = model?.switchLevel ?? pi.thinkingLevel;
			pi.setThinkingLevel(switchLevel);
			return true;
		},
		on(_event: "thinking_level_select", handler: FakePi["listeners"][number]) {
			pi.listeners.push(handler);
			return () => {};
		},
	};
	return pi as FakePi;
}

/** Mirror of the extension listener (extensions/effort/index.ts, post BH-E5). */
function attachAdopter(pi: FakePi, owner: EffortOwner, sources: string[]): void {
	pi.on("thinking_level_select", (event) => {
		if (event.level === owner.lastApplied()) return;
		if (owner.inModelSwitch()) {
			owner.noteModelSwitchLevel(event.level);
			return;
		}
		const outcome = owner.setExplicit(event.level, "shortcut");
		if (outcome === "pinned-by-env") return;
		sources.push(owner.currentSource());
	});
}

async function runModelSwitch(pi: FakePi, owner: EffortOwner, switchLevel: FakeLevel): Promise<void> {
	owner.beginModelSwitch();
	try {
		await pi.setModel({ switchLevel });
	} finally {
		owner.endModelSwitch();
	}
}

test("BH-E5① profile-driven switch: the host reset is recorded, not adopted as explicit", async () => {
	const pi = makeFakePi("off");
	const owner = newEffortOwner(pi as never);
	const sources: string[] = [];
	attachAdopter(pi, owner, sources);

	// profile applies high for the current model
	owner.setFromProfile("high", "main");
	assert.equal(pi.thinkingLevel, "high");
	assert.equal(owner.currentSource(), "profile");

	// mode switch → new model; the host resets thinking to the model's
	// switch default ("medium") from INSIDE setModel
	await runModelSwitch(pi, owner, "medium");

	assert.equal(pi.thinkingLevel, "medium");
	assert.notEqual(owner.currentSource(), "session"); // the core assertion
	assert.equal(owner.currentSource(), "model-default"); // profile was for the previous model
	assert.equal(owner.effective(), "medium");

	// the mode's profile application then re-asserts the profile effort
	owner.setFromProfile("low", "main");
	assert.equal(pi.thinkingLevel, "low");
	assert.equal(owner.currentSource(), "profile");
});

test("BH-E5② an explicit user choice survives the model switch (② > ③ intact)", async () => {
	const pi = makeFakePi("off");
	const owner = newEffortOwner(pi as never);
	attachAdopter(pi, owner, []);

	owner.setExplicit("high", "command");
	assert.equal(pi.thinkingLevel, "high");

	await runModelSwitch(pi, owner, "low");
	assert.equal(pi.thinkingLevel, "low"); // host reset happened
	// the explicit slot was NOT overwritten by the switch default
	assert.equal(owner.currentSource(), "session");
	assert.equal(owner.effective(), "high");
	// the chain still works: a profile write loses to the surviving explicit
	owner.setFromProfile("medium", "main");
	assert.equal(pi.thinkingLevel, "high");
});

test("BH-E5③ the echo guard stays truthful and external changes still adopt", async () => {
	const pi = makeFakePi("off");
	const owner = newEffortOwner(pi as never);
	const sources: string[] = [];
	attachAdopter(pi, owner, sources);

	await runModelSwitch(pi, owner, "medium");
	assert.equal(owner.lastApplied(), "medium");

	// echo of the recorded reset: same level → guard skips
	pi.setThinkingLevel("medium");
	assert.deepEqual(sources, []);

	// a REAL external change outside the span still adopts (EFF-01 preserved)
	pi.setThinkingLevel("xhigh");
	assert.deepEqual(sources, ["session"]);
	assert.equal(owner.effective(), "xhigh");
});

test("BH-E5④ switch spans nest depth-safely (parallel profile applications)", () => {
	const pi = makeFakePi("off");
	const owner = newEffortOwner(pi as never);
	assert.equal(owner.inModelSwitch(), false);
	owner.beginModelSwitch();
	owner.beginModelSwitch();
	assert.equal(owner.inModelSwitch(), true);
	owner.endModelSwitch();
	assert.equal(owner.inModelSwitch(), true);
	owner.endModelSwitch();
	assert.equal(owner.inModelSwitch(), false);
});
