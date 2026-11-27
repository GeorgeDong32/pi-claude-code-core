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
