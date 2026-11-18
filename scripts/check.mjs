#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

function runTsc(args) {
	try {
		return { ok: true, output: execFileSync(join(repoRoot, "node_modules", ".bin", "tsc"), args, { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }) };
	} catch (error) {
		return { ok: false, output: String(error.stdout ?? "") + String(error.stderr ?? "") };
	}
}

execFileSync(process.execPath, [join(repoRoot, "scripts", "lint-comments.mjs")], { stdio: "inherit" });

const main = runTsc(["-p", "tsconfig.json"]);
if (!main.ok) {
	process.stdout.write(main.output);
	console.error("check: MAIN project has type errors");
	process.exit(1);
}

const contracts = runTsc(["-p", "tsconfig.contracts.json"]);
if (contracts.ok) {
	console.log("check: lint OK; main OK; contracts OK");
	process.exit(0);
}
process.stdout.write(contracts.output);
console.error("check: CONTRACT project has type errors");
process.exit(1);
