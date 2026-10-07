/**
 * B4 (arch) + P1-1 §4.4 (F2/B5): observation-pack self-disable regression
 * pin — same shape as action-fusion's: an old injected host version
 * registers nothing, warns at load time, and publishes the footer line from
 * the first session_start (bus invariant 3). node:test, no nested describe.
 */
import assert from "node:assert/strict";
import test from "node:test";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { coreBus, resetCoreBusForTests } from "../../bus.ts";
import createObservationPackExtension from "../index.ts";

function fakePi(): { pi: ExtensionAPI; handlers: { count: number }; sessionStart: () => void } {
	const handlers = { count: 0 };
	const sessionStartHandlers: Array<() => void> = [];
	const pi = {
		registerTool: () => {},
		on: (event: string, handler: () => void) => {
			handlers.count++;
			if (event === "session_start") sessionStartHandlers.push(handler);
		},
		registerCommand: () => {},
	} as unknown as ExtensionAPI;
	return { pi, handlers, sessionStart: () => sessionStartHandlers.forEach((h) => h()) };
}

test("B5 (P1-1): old host self-disables — load-time warn only, footer published at first session_start", () => {
	resetCoreBusForTests();
	const { pi, handlers, sessionStart } = fakePi();
	const warns: string[] = [];
	const originalWarn = console.warn;
	console.warn = (m: string) => {
		warns.push(m);
	};
	try {
		createObservationPackExtension({ version: "0.85.0" })(pi);
	} finally {
		console.warn = originalWarn;
	}
	assert.equal(handlers.count, 1); // exactly the session_start handler
	assert.equal(warns.length, 1);
	assert.match(warns[0] ?? "", /^\[observation-pack\] disabled: pi 0\.85\.0 < 0\.87\.0$/);
	// load time: zero publishes
	assert.equal(coreBus().snapshot().revision, 0);
	assert.equal(coreBus().snapshot().display?.footer, undefined);
	sessionStart();
	const footer = coreBus()?.snapshot().display?.footer;
	assert.ok(footer?.includes("observation-pack requires pi >=0.87.0"), `footer was: ${JSON.stringify(footer)}`);
	sessionStart();
	assert.equal(coreBus()?.snapshot().display?.footer?.length, 1);
	resetCoreBusForTests();
});
