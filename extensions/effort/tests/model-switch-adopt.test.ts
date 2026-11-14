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

// ─── FX-2 (spec 2026-11-14-followup-small-fixes) ─────────────────────────
//
// The BH-E5 span only covers profile-driven switches. Manual switches
// (/model, ctrl+p) run unbracketed: the host assigns agent.state.model
// BEFORE setThinkingLevel emits, so a tls handler can classify the reset by
// comparing the live model against a remembered baseline key, and the
// confirming model_select then restores the chain (afterHostModelSwitch).
//
// Degradation (spec FX-2): if an external extension registers its tls
// handler AHEAD of core's and stalls the dispatch, the extension sees
// model_select BEFORE the host's reset event. The baseline is already
// updated when the late event finally lands, so the reset is adopted as an
// explicit choice — exactly today's (pre-FX-2) behavior. This test pins that
// degradation so a future host/runner ordering change cannot silently
// change it.

interface Fx2Model {
	provider: string;
	id: string;
}

interface Fx2TlsEvent {
	level: FakeLevel;
	previousLevel: FakeLevel;
}

interface Fx2FakePi {
	thinkingLevel: FakeLevel;
	model: Fx2Model | undefined;
	getThinkingLevel(): FakeLevel;
	/** REAL host primitive: state first, then emit to tls handlers. */
	setThinkingLevel(level: FakeLevel): void;
	/** Deliver a model_select to the registered handlers. */
	emitModelSelect(model: Fx2Model): void;
	/** Deliver a tls event whose dispatch was stalled behind another handler. */
	deliverStalledTls(event: Fx2TlsEvent): void;
	on(event: "thinking_level_select", handler: (event: Fx2TlsEvent) => void): () => void;
	on(event: "model_select", handler: (event: { model: Fx2Model }) => void): () => void;
}

function makeFx2FakePi(initial: FakeLevel = "off"): Fx2FakePi {
	const tlsListeners: Array<(event: Fx2TlsEvent) => void> = [];
	const modelSelectListeners: Array<(event: { model: Fx2Model }) => void> = [];
	const pi = {
		thinkingLevel: initial,
		model: undefined as Fx2Model | undefined,
		getThinkingLevel: () => pi.thinkingLevel,
		setThinkingLevel(level: FakeLevel) {
			// REAL ordering: state first, then the event.
			const previous = pi.thinkingLevel;
			pi.thinkingLevel = level;
			if (previous !== level) {
				for (const listener of tlsListeners) listener({ level, previousLevel: previous });
			}
		},
		emitModelSelect(model: Fx2Model) {
			for (const listener of modelSelectListeners) listener({ model });
		},
		deliverStalledTls(event: Fx2TlsEvent) {
			for (const listener of tlsListeners) listener(event);
		},
		on(_event: "thinking_level_select" | "model_select", handler: (event: never) => void) {
			if (_event === "model_select") {
				modelSelectListeners.push(handler as (event: { model: Fx2Model }) => void);
			} else {
				tlsListeners.push(handler as (event: Fx2TlsEvent) => void);
			}
			return () => {};
		},
	};
	return pi as unknown as Fx2FakePi;
}

/** Mirror of the FX-2 extension listener including baseline bookkeeping. */
function attachFx2Listener(pi: Fx2FakePi, owner: EffortOwner, adopted: FakeLevel[]): void {
	let switchBaselineKey: string | undefined;
	const modelKey = (model: Fx2Model | undefined | null): string | undefined =>
		model ? `${model.provider}\u0000${model.id}` : undefined;
	pi.on("thinking_level_select", (event) => {
		if (event.level === owner.lastApplied()) return;
		const liveKey = modelKey(pi.model);
		const hostSwitch =
			owner.inModelSwitch() ||
			(switchBaselineKey !== undefined && liveKey !== undefined && liveKey !== switchBaselineKey);
		if (hostSwitch) {
			owner.noteModelSwitchLevel(event.level);
			return;
		}
		const outcome = owner.setExplicit(event.level, "shortcut");
		if (outcome === "pinned-by-env") return;
		adopted.push(event.level);
	});
	pi.on("model_select", (event) => {
		const previousKey = switchBaselineKey;
		const nextKey = modelKey(event.model);
		if (!owner.inModelSwitch() && previousKey !== undefined && nextKey !== undefined && nextKey !== previousKey) {
			owner.afterHostModelSwitch();
		}
		if (nextKey !== undefined) switchBaselineKey = nextKey;
	});
}

test("FX-2⑥ degenerate dispatch order (model_select before tls): behavior equals today", () => {
	const pi = makeFx2FakePi("off");
	const owner = newEffortOwner(pi as never);
	const adopted: FakeLevel[] = [];
	attachFx2Listener(pi, owner, adopted);

	const modelA = { provider: "prov", id: "m-a" };
	const modelB = { provider: "prov", id: "m-b" };
	pi.model = modelA;
	pi.emitModelSelect(modelA); // baseline seeded, no restore (same model)

	// user's explicit /effort choice
	owner.setExplicit("high", "command");
	assert.equal(pi.thinkingLevel, "high");

	// host switch to m-b: the reset is applied but its tls dispatch is
	// stalled behind an external handler — model_select arrives first
	pi.model = modelB;
	pi.thinkingLevel = "low";
	pi.emitModelSelect(modelB);
	// the restore still runs while the baseline names the previous model
	assert.equal(pi.thinkingLevel, "high");

	// the stalled reset finally lands: the baseline already names m-b, so it
	// classifies as user intent — the pre-FX-2 adoption, deliberately pinned
	pi.deliverStalledTls({ level: "low", previousLevel: "high" });
	assert.deepEqual(adopted, ["low"]);
	assert.equal(pi.thinkingLevel, "low");
	assert.equal(owner.currentSource(), "session");
});
