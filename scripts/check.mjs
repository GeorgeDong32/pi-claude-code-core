#!/usr/bin/env node
/**
 * Unified typecheck gate (P0-SK-03): `bun run check` must be exit-0.
 *
 * Runs TWO tsc passes:
 *   1. main project (tsconfig.json — core sources + unit tests)
 *   2. contract suite (tsconfig.contracts.json — test/contracts, which
 *      imports the four READ-ONLY source packages)
 *
 * Pass 2 carries an AUTO-EXPIRING allowlist: goal 0.6.0 (authored against
 * pi 0.74 types) has exactly two type drifts against 0.85.1 inside
 * goal-auditor.ts. When the P2 fork fixes them, the allowlisted lines stop
 * matching and this script FAILS with a "remove the allowlist" hint —
 * same semantics as @ts-expect-error, which cannot suppress errors that
 * live inside another file. Any NEW contract error fails immediately.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// The contract suite imports the four READ-ONLY sibling source packages;
// a fresh clone without them fails with confusing resolver errors.
const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const siblings = ["pi-permission-modes", "pi-effort", "pi-goal", "pi-review"];
const missing = siblings.filter((s) => !existsSync(join(repoRoot, "..", s)));
if (missing.length > 0) {
	console.error(
		`check: missing sibling source packages: ${missing.join(", ")}.\n` +
			"The contract suite imports them read-only — clone them next to this repo\n" +
			"(see test/contracts/README.md), or run `bun run test` for the core-only suites.",
	);
	process.exit(1);
}

// goal fork drift allowlist removed 2026-09-21: fixed in-tree (P2-GO).
const GOAL_DRIFTS = [];

function runTsc(args) {
	try {
		return { ok: true, output: execFileSync("bunx", ["tsc", ...args], { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }) };
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

const lines = contracts.output.split("\n").filter((l) => l.trim().length > 0);
const unexpected = [];
const matched = new Set();
for (const line of lines) {
	const hit = GOAL_DRIFTS.find((d, i) => line.includes(d) && !matched.has(i));
	if (hit !== undefined) matched.add(GOAL_DRIFTS.indexOf(hit));
	else unexpected.push(line);
}
if (unexpected.length > 0) {
	process.stdout.write(unexpected.join("\n") + "\n");
	console.error("check: CONTRACT project has unexpected type errors");
	process.exit(1);
}
if (matched.size < GOAL_DRIFTS.length) {
	console.error(
		"check: some goal-drift lines no longer occur (fixed?). " +
			"Update GOAL_DRIFTS in scripts/check.mjs — allowlist must stay exact.",
	);
	process.exit(1);
}
console.log("check: main OK; contracts OK");
process.exit(0);
