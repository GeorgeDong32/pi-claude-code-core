#!/usr/bin/env node
/**
 * Unified test entry (P0-SK-03): runs every module suite with its own
 * framework. Migration rule: each migrated package keeps the framework it
 * came with (modes → vitest; effort/goal/review → node:test via tsx).
 *
 *   - vitest suites : test/lib, extensions/modes (colocated, P1)
 *   - node:test     : extensions/{effort,goal,review,action-fusion,observation-pack,bg-shell,compaction,memory,web-gov}/tests
 *
 * Missing or empty directories are skipped so the entry works at every phase.
 * Exit code is non-zero if any suite fails.
 *
 * CH E9 (2026-11-15): the node:test suites are no longer run through a shell
 * (`shell: "/bin/zsh"` existed only so `dir/*.test.ts` would expand). The
 * `*.test.ts` files are enumerated with readdirSync and handed to execFileSync
 * of the LOCAL tsx/vitest binaries — same pattern as check.mjs's tsc — so the
 * gate no longer depends on a shell or on PATH.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

// Test runs model PARENT-session semantics: strip session-coupling env that
// pi-subagents injects into every child process. Without this, running the
// suite from inside a subagent (e.g. a dispatched reviewer) false-reds the
// goal suites and contracts (adversarial review F1, 2026-10-01). Tests that
// need child semantics set the vars explicitly.
for (const key of ["PI_SUBAGENT_CHILD", "PI_SUBAGENT_PARENT_SESSION", "PERMISSION_MODES_INHERITED_MODE"]) {
	delete process.env[key];
}

const bin = (name) => join(root, "node_modules", ".bin", name);
/** Top-level `*.test.ts` files of one suite directory, in stable name order. */
const testFiles = (dir) => readdirSync(dir).filter((f) => f.endsWith(".test.ts")).sort().map((f) => join(dir, f));

let failed = false;

const vitestTargets = [join(root, "test", "lib"), join(root, "extensions", "modes")].filter(existsSync);
if (vitestTargets.length > 0) {
	console.log(`[run-tests] vitest → ${vitestTargets.join(", ")}`);
	try {
		execFileSync(bin("vitest"), ["run", ...vitestTargets], { stdio: "inherit", cwd: root });
	} catch {
		failed = true;
	}
} else {
	console.log("[run-tests] no vitest targets yet");
}

const nodeTestDirs = [
	join(root, "extensions", "effort", "tests"),
	join(root, "extensions", "goal", "tests"),
	join(root, "extensions", "review", "tests"),
	join(root, "extensions", "action-fusion", "tests"),
	join(root, "extensions", "observation-pack", "tests"),
	join(root, "extensions", "bg-shell", "tests"),
	join(root, "extensions", "compaction", "tests"),
	// BH review P2-1 (2026-11-14): memory already had colocated node:test
	// suites that never ran in the gate; web-gov gained suites with BH-S2.
	join(root, "extensions", "memory", "tests"),
	join(root, "extensions", "web-gov", "tests"),
].filter(existsSync);

for (const dir of nodeTestDirs) {
	const files = testFiles(dir);
	if (files.length === 0) {
		// An empty dir must not reach tsx: with no file args it would glob-
		// discover **/*.test.* across the whole repo, pulling vitest suites
		// into node:test (CH-6).
		console.log(`\n[run-tests] node:test → ${dir}: no *.test.ts files, skipped`);
		continue;
	}
	console.log(`\n[run-tests] node:test → ${dir}`);
	try {
		execFileSync(bin("tsx"), ["--test", ...files], { stdio: "inherit", cwd: root });
	} catch {
		failed = true;
	}
}

process.exit(failed ? 1 : 0);
