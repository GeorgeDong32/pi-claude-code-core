/*
 * P0-1 pipefail guard (2026-11-24) — detection on the real command shapes
 * seen in 30 days of session logs, argv shaping per shell, and one real
 * launch proving the marker carries the upstream exit status.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { realPort } from "../port.ts";
import { needsPipefail, pipefailArgs } from "../pipefail.ts";
import { cleanup, root, waitFor } from "./harness.ts";

after(() => cleanup());

describe("needsPipefail: check commands piped without pipefail", () => {
	it("flags the shapes the session logs actually contain", () => {
		for (const command of [
			"pnpm test 2>&1 | tail -25",
			"pnpm test 2>&1 | grep -E '^ℹ (tests|pass|fail|skipped)'",
			"pnpm test 2>&1 | grep -E '^# (pass|fail|tests)|parity|renderer:' | head -30",
			"cd /Volumes/MacDev/CherryDev-worktrees/qwen-fix\nNODE_OPTIONS=--max-old-space-size=8192 pnpm exec tsc 2>&1 | head -30",
			"cd x && pnpm run check | tail -5",
			"cargo test 2>&1 | tail",
			"./gradlew build | tail -20",
			"pnpm test | tail -25 || echo failed",
			"pnpm test |& tail -25",
			"ls | wc -l && pnpm test | tail -3",
			"( pnpm test 2>&1 | tail -5 )",
			"time pnpm test | tail -5",
		]) {
			assert.equal(needsPipefail(command), true, command);
		}
	});

	it("leaves alone: no pipe, redirect-to-log, || only, quoted pipes, grep -q probes, explicit pipefail, non-check upstreams", () => {
		for (const command of [
			"pnpm run check",
			"pnpm test > /tmp/test-19810.log 2>&1; echo \"exit=$?\"; tail -n 50 /tmp/test-19810.log",
			"pnpm test || echo failed",
			'echo "pnpm test | tail"',
			"grep 'pnpm test | tail' notes.md",
			"if pnpm test 2>&1 | grep -q failed; then echo has-failures; fi",
			"pnpm test 2>&1 | rg -q 'FAIL'",
			"pnpm test 2>&1 | grep -c '✖'",
			"set -o pipefail; pnpm test 2>&1 | tail -25",
			"set -o pipefail\npnpm test | tail -25",
			"git diff vitest.config.ts | head -20",
			"ls | wc -l",
			"cat package.json | grep name",
			"python3 - <<'EOF'\nimport subprocess\n# make | tail\nprint('x' | 'y')\nEOF",
			"echo $(pnpm test | tail -1)",
			"",
		]) {
			assert.equal(needsPipefail(command), false, command);
		}
	});
});

describe("pipefailArgs: only shells that accept -o pipefail", () => {
	it("bash and zsh get the option in front of the configured args; others are untouched", () => {
		assert.deepEqual(pipefailArgs("/bin/bash", ["-c"]), ["-o", "pipefail", "-c"]);
		assert.deepEqual(pipefailArgs("/bin/zsh", ["-l", "-c"]), ["-o", "pipefail", "-l", "-c"]);
		assert.deepEqual(pipefailArgs("/bin/sh", ["-c"]), ["-c"]);
		assert.deepEqual(pipefailArgs("/usr/local/bin/fish", ["-c"]), ["-c"]);
	});
});

describe("launch: the exit marker carries the upstream status for a guarded pipeline", () => {
	const marker = (nonce: string, logPath: string): string => {
		const text = readFileSync(logPath, "utf8");
		return /__CC_BG_EXIT__:[^:\n]+:(\d+)/.exec(text)?.[1] ?? "";
	};

	it("./gradlew (missing) piped into tail reports 127, not tail's 0", async () => {
		const logPath = join(root, `pipefail-${process.pid}.log`);
		await realPort.launch({ command: "./gradlew build 2>&1 | tail -1", cwd: root, logPath, nonce: "pf" });
		await waitFor(() => marker("pf", logPath) !== "", "the exit marker");
		assert.equal(marker("pf", logPath), "127");
	});

	it("control: a non-check pipeline keeps the last stage's status", async () => {
		const logPath = join(root, `control-${process.pid}.log`);
		await realPort.launch({ command: "ls /definitely-missing-cc 2>/dev/null | wc -l", cwd: root, logPath, nonce: "ct" });
		await waitFor(() => marker("ct", logPath) !== "", "the exit marker");
		assert.equal(marker("ct", logPath), "0");
	});
});
