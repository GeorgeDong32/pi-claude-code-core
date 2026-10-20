/**
 * B5-2 (cherry-batch2 spec): the PROFILE effort clamp — the path this batch
 * fixed (it previously wrote unvalidated). Pin: a single-tier model + a
 * profile asking for medium writes the clamped tier + an info notice.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { coreBus, resetCoreBusForTests } from "../../extensions/bus.ts";
import { createProfileController } from "./profile-apply.ts";
import { setModelsPath } from "./profiles.ts";
import { setConfigPath } from "./config.ts";

const dir = mkdtempSync(join(tmpdir(), "b5-profile-"));
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function fakePi() {
	return {
		registerCommand() {},
		registerShortcut() {},
		setModel: async () => true,
		getThinkingLevel: () => "off" as const,
		setThinkingLevel() {},
		on() {
			return () => {};
		},
	} as never;
}

describe("B5-2 profile effort clamp (cherry-batch2)", () => {
	beforeEach(() => {
		const cfg = join(dir, `pm-${Math.random().toString(36).slice(2)}.json`);
		writeFileSync(cfg, JSON.stringify({ classifier: { enabled: false } }));
		setConfigPath(cfg);
		const profiles = join(dir, "model-profiles.json");
		writeFileSync(profiles, JSON.stringify({ default: { plan: { model: "t/single-tier", effort: "medium" } } }));
		setModelsPath(profiles);
	});

	it("a single-tier model + profile=medium notifies the clamp to high (bus queue)", async () => {
		resetCoreBusForTests();
		const pi = fakePi();
		const controller = createProfileController(pi, {
			getMode: () => "plan",
			onStateChanged: () => {},
			sendList: () => {},
		} as never);
		const singleTier = {
			id: "single-tier",
			provider: "t",
			reasoning: true,
			thinkingLevelMap: { minimal: null, low: null, medium: null, high: "high", xhigh: null, max: null },
		};
		const ctx = {
			cwd: dir,
			hasUI: true,
			ui: {},
			modelRegistry: { find: (provider: string, id: string) => (provider === "t" && id === "single-tier" ? singleTier : undefined) },
			model: singleTier,
		};
		await (controller as unknown as { setActive: (n: string, c: unknown) => Promise<void> }).setActive("default", ctx);
		const notices = (coreBus().snapshot().notifications ?? []).map((n) => n.msg);
		expect(notices.some((n) => n.includes("clamped to high"))).toBe(true);
	});
});
