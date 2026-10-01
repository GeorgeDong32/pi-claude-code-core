/**
 * B4 (arch): observation-pack self-disable regression pin — same shape as
 * action-fusion's: an old injected host version registers nothing and
 * publishes the footer through the real bus. node:test, no nested describe.
 */
import assert from "node:assert/strict";
import test from "node:test";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { coreBus, resetCoreBusForTests } from "../../bus.ts";
import createObservationPackExtension from "../index.ts";

function fakePi(): { pi: ExtensionAPI; handlers: { count: number } } {
	const handlers = { count: 0 };
	const pi = {
		registerTool: () => {},
		on: () => {
			handlers.count++;
		},
		registerCommand: () => {},
	} as unknown as ExtensionAPI;
	return { pi, handlers };
}

test("old host version self-disables: no handlers registered, footer published", () => {
	resetCoreBusForTests();
	const { pi, handlers } = fakePi();
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
	assert.equal(handlers.count, 0);
	assert.equal(warns.length, 1);
	assert.match(warns[0] ?? "", /^\[observation-pack\] disabled: pi 0\.85\.0 < 0\.87\.0$/);
	const footer = coreBus()?.snapshot().display?.footer;
	assert.ok(footer?.includes("observation-pack requires pi >=0.87.0"), `footer was: ${JSON.stringify(footer)}`);
	resetCoreBusForTests();
});
