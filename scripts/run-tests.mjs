#!/usr/bin/env node
/**
 * Unified test entry (P0-SK-03): runs every module suite with its own
 * framework. Migration rule: each migrated package keeps the framework it
 * came with (modes → vitest; effort/goal/review → node:test via tsx).
 *
 *   - vitest suites : test/lib, extensions/modes (colocated, P1)
 *   - node:test     : extensions/{effort,goal,review}/tests (P1/P2)
 *
 * Missing directories are skipped so the entry works at every phase.
 * Exit code is non-zero if any suite fails.
 */
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

const vitestTargets = [join(root, "test", "lib"), join(root, "extensions", "modes")].filter(existsSync);
const nodeTestDirs = [
	join(root, "extensions", "effort", "tests"),
	join(root, "extensions", "goal", "tests"),
	join(root, "extensions", "review", "tests"),
].filter(existsSync);

let failed = false;

if (vitestTargets.length > 0) {
	try {
		execSync(`vitest run ${vitestTargets.map((t) => `"${t}"`).join(" ")}`, { stdio: "inherit", cwd: root });
	} catch {
		failed = true;
	}
} else {
	console.log("[run-tests] no vitest targets yet");
}

for (const dir of nodeTestDirs) {
	console.log(`\n[run-tests] node:test → ${dir}`);
	try {
		execSync(`tsx --test "${dir}"/*.test.ts`, { stdio: "inherit", cwd: root, shell: "/bin/zsh" });
	} catch {
		failed = true;
	}
}

process.exit(failed ? 1 : 0);
