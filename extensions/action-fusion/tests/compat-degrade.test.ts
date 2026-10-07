/**
 * B4 (arch) + P1-1 §4.4 (F2/B5): the self-disable regression pin — the
 * SoL-Pi failure mode this suite prevents is "a pi upgrade silently breaks
 * a mechanism with no error and no warning". An old injected host version
 * must (a) register NOTHING, (b) warn at LOAD time, and (c) publish the
 * footer line from the first session_start handler (bus invariant 3: no
 * publishing outside event handlers — the load-time publish was the
 * pre-P1-1 behavior). node:test, no nested describe (bun limitation).
 */
import assert from "node:assert/strict";
import test from "node:test";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { coreBus, resetCoreBusForTests } from "../../bus.ts";
import createActionFusion from "../index.ts";

function fakePi(): { pi: ExtensionAPI; registered: string[]; sessionStart: () => void } {
	const registered: string[] = [];
	const sessionStartHandlers: Array<() => void> = [];
	const pi = {
		registerTool: (t: { name?: string }) => {
			registered.push(t.name ?? "?");
		},
		on: (event: string, handler: () => void) => {
			if (event === "session_start") sessionStartHandlers.push(handler);
		},
		registerCommand: () => {},
	} as unknown as ExtensionAPI;
	return { pi, registered, sessionStart: () => sessionStartHandlers.forEach((h) => h()) };
}

test("B5 (P1-1): old host self-disables — load-time warn only, footer published at first session_start", () => {
	resetCoreBusForTests();
	const { pi, registered, sessionStart } = fakePi();
	const warns: string[] = [];
	const originalWarn = console.warn;
	console.warn = (m: string) => {
		warns.push(m);
	};
	try {
		createActionFusion({ version: "0.85.0" })(pi);
	} finally {
		console.warn = originalWarn;
	}
	assert.equal(registered.length, 0);
	assert.equal(warns.length, 1);
	assert.match(warns[0] ?? "", /^\[action-fusion\] disabled: pi 0\.85\.0 < 0\.87\.0$/);
	// load time: ZERO publishes (the snapshot is untouched)
	assert.equal(coreBus().snapshot().revision, 0);
	assert.equal(coreBus().snapshot().display?.footer, undefined);
	// first session_start publishes the degrade line
	sessionStart();
	const footer = coreBus()?.snapshot().display?.footer;
	assert.ok(footer?.includes("action-fusion requires pi >=0.87.0"), `footer was: ${JSON.stringify(footer)}`);
	// a second session_start does not add rows
	sessionStart();
	assert.equal(coreBus()?.snapshot().display?.footer?.length, 1);
	resetCoreBusForTests();
});
