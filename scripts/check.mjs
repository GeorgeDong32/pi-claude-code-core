#!/usr/bin/env node
/**
 * Unified typecheck gate (P0-SK-03): `pnpm run check` must be exit-0.
 *
 * Runs TWO tsc passes:
 *   1. main project (tsconfig.json — core sources + unit tests)
 *   2. contract suite (tsconfig.contracts.json — test/contracts, which
 *      imports the four READ-ONLY source packages)
 *
 * CH E8b (2026-11-15): the formerly auto-expiring goal-drift allowlist
 * (GOAL_DRIFTS) was removed — it had been an empty array since the drift was
 * fixed in-tree (P2-GO), so its matching branch was unreachable noise. Any
 * contract error now fails the gate directly.
 */
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
// Sibling-source-packages gate removed 2026-09-30: the retired packages moved
// to Pi-Extension/archive/repos and the contract suite has imported the core
// modules exclusively since P1 (targets.ts) — no external checkout is needed.
// goal fork drift allowlist removed 2026-09-21 (fixed in-tree, P2-GO); the
// dead empty-array machinery itself deleted 2026-11-15 (CH E8b).

function runTsc(args) {
	try {
		// Resolve the local tsc binary directly — works identically under
		// pnpm/npm/bun installs and needs nothing on PATH (the old `bunx tsc`
		// tied this gate to bun).
		return { ok: true, output: execFileSync(join(repoRoot, "node_modules", ".bin", "tsc"), args, { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }) };
	} catch (error) {
		return { ok: false, output: String(error.stdout ?? "") + String(error.stderr ?? "") };
	}
}

const main = runTsc(["-p", "tsconfig.json"]);
if (!main.ok) {
	process.stdout.write(main.output);
	console.error("check: MAIN project has type errors");
	process.exit(1);
}

const contracts = runTsc(["-p", "tsconfig.contracts.json"]);
if (contracts.ok) {
	console.log("check: main OK; contracts OK");
	process.exit(0);
}
process.stdout.write(contracts.output);
console.error("check: CONTRACT project has type errors");
process.exit(1);
