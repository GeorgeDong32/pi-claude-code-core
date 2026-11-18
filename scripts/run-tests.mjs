#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

for (const key of ["PI_SUBAGENT_CHILD", "PI_SUBAGENT_PARENT_SESSION", "PERMISSION_MODES_INHERITED_MODE"]) {
	delete process.env[key];
}

const bin = (name) => join(root, "node_modules", ".bin", name);
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
	join(root, "extensions", "memory", "tests"),
	join(root, "extensions", "web-gov", "tests"),
].filter(existsSync);

for (const dir of nodeTestDirs) {
	const files = testFiles(dir);
	if (files.length === 0) {
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
