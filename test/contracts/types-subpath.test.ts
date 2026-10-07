/**
 * D4-READER-REMOVE acceptance (spec 2026-10-07 P1-1 §4.3, B7):
 * the `./types` package subpath is TYPE-ONLY after the D4=B withdrawal.
 *
 * 1. A real TypeScript consumer compiles against the subpath (external
 *    tsconfig — no repo paths; compiled via a spawned tsc, never a relative
 *    .d.mts import inside this suite).
 * 2. A runtime import of the subpath FAILS with ERR_PACKAGE_PATH_NOT_EXPORTED
 *    (package.json keeps only the "types" condition).
 * 3. The packed file list no longer contains the runtime reader
 *    (types/core-status.mjs) and still ships the declaration twin.
 */
import { describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function run(cmd: string, args: string[], opts: { cwd: string }) {
	return spawnSync(cmd, args, { ...opts, encoding: "utf-8" });
}

describe("D4-READER-REMOVE (B7): ./types is type-only", () => {
	it("external tsc compiles a type-only consumer against the package subpath", () => {
		const fixtureTsconfig = join(repoRoot, "test", "contracts", "fixtures", "tsconfig.json");
		expect(existsSync(fixtureTsconfig)).toBe(true);
		// The local typescript of this repo plays the role of the consumer's
		// compiler; resolution goes through package.json self-reference ONLY
		// (the fixture tsconfig has no paths/extends).
		const res = run("bun", ["x", "tsc", "-p", fixtureTsconfig], { cwd: repoRoot });
		expect(res.status).toBe(0);
	}, 60_000);

	it("runtime import of the subpath fails closed (no runtime export left)", () => {
		const res = run("node", ["-e", "import('@georgedong32/pi-claude-code-core/types').then(() => process.exit(0), (e) => { console.error(e.code || e.message); process.exit(1); })"], { cwd: repoRoot });
		expect(res.status).not.toBe(0);
		expect(res.stderr).toContain("ERR_PACKAGE_PATH_NOT_EXPORTED");
	});

	it("the runtime reader file is gone from the tree and from the packed file list", () => {
		expect(existsSync(join(repoRoot, "types", "core-status.mjs"))).toBe(false);
		expect(existsSync(join(repoRoot, "types", "index.d.mts"))).toBe(true);
		const res = run("npm", ["pack", "--dry-run", "--json"], { cwd: repoRoot });
		expect(res.status).toBe(0);
		const files = (JSON.parse(res.stdout) as Array<{ files?: Array<{ path: string }> }>)
			.flatMap((entry) => entry.files ?? [])
			.map((f) => f.path);
		expect(files).not.toContain("types/core-status.mjs");
		expect(files).toContain("types/index.d.mts");
	}, 120_000);
});
