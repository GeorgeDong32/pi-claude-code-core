import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CORE_ECONOMY, loadCoreEconomy, setCoreEconomyPath } from "../../lib/core-economy.ts";

const originalPath = join(tmpdir(), "core-economy-original-unlikely-to-exist.json");

describe("core-economy config (SPEC DEC-02/ASM-03)", () => {
	afterEach(() => {
		setCoreEconomyPath(originalPath);
	});

	it("absent file yields both mechanisms enabled", () => {
		setCoreEconomyPath(join(tmpdir(), "does-not-exist-core-economy.json"));
		expect(loadCoreEconomy()).toEqual(DEFAULT_CORE_ECONOMY);
	});

	it("reads explicit toggles", () => {
		const dir = mkdtempSync(join(tmpdir(), "core-econ-"));
		const file = join(dir, "core-economy.json");
		writeFileSync(file, JSON.stringify({ version: 1, actionFusion: false, observationPack: true }));
		setCoreEconomyPath(file);
		expect(loadCoreEconomy()).toEqual({ actionFusion: false, observationPack: true });
		rmSync(dir, { recursive: true, force: true });
	});

	it("malformed JSON degrades to defaults without throwing", () => {
		const dir = mkdtempSync(join(tmpdir(), "core-econ-bad-"));
		const file = join(dir, "core-economy.json");
		writeFileSync(file, "{ not json");
		setCoreEconomyPath(file);
		expect(loadCoreEconomy()).toEqual(DEFAULT_CORE_ECONOMY);
		rmSync(dir, { recursive: true, force: true });
	});

	it("non-boolean fields fall back to true per-field", () => {
		const dir = mkdtempSync(join(tmpdir(), "core-econ-partial-"));
		const file = join(dir, "core-economy.json");
		writeFileSync(file, JSON.stringify({ actionFusion: "yes", observationPack: false }));
		setCoreEconomyPath(file);
		expect(loadCoreEconomy()).toEqual({ actionFusion: true, observationPack: false });
		rmSync(dir, { recursive: true, force: true });
	});
});
