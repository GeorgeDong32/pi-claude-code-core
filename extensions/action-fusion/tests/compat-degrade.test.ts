/**
 * B4 (arch): the self-disable regression pin — the SoL-Pi failure mode this
 * suite exists to prevent was "a pi upgrade silently breaks a mechanism with
 * no error and no warning". An old injected host version must (a) register
 * NOTHING and (b) publish the footer line through the real bus. node:test,
 * no nested describe (bun limitation).
 */
import assert from "node:assert/strict";
import test from "node:test";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { coreBus, resetCoreBusForTests } from "../../bus.ts";
import createActionFusion from "../index.ts";

function fakePi(): { pi: ExtensionAPI; registered: string[] } {
	const registered: string[] = [];
	const pi = {
		registerTool: (t: { name?: string }) => {
			registered.push(t.name ?? "?");
		},
		on: () => {},
		registerCommand: () => {},
	} as unknown as ExtensionAPI;
	return { pi, registered };
}

test("old host version self-disables: no tools registered, footer published", () => {
	resetCoreBusForTests();
	const { pi, registered } = fakePi();
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
	assert.match(warns[0] ?? "", /^\[action-fusion\] disabled: pi 0.85\.0 < 0\.87\.0$/);
	const footer = coreBus()?.snapshot().display?.footer;
	assert.ok(footer?.includes("action-fusion requires pi >=0.87.0"), `footer was: ${JSON.stringify(footer)}`);
	resetCoreBusForTests();
});
