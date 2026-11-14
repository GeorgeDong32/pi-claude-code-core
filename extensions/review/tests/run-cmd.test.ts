/**
 * Tests for src/run-cmd.ts — D-FX-1 (2026-11-14) timeout + env opts.
 *
 * Pins the REAL spawn loop (defaultRunCmd, no injection):
 *   - `timeoutMs` kills a hung child, resolves non-zero with a "timed out"
 *     note on stderr, well under the 2s budget the spec demands;
 *   - `env` merges over process.env for one call (GIT_TERMINAL_PROMPT=0
 *     relies on this) and is NOT visible to children when omitted;
 *   - no opts passed → legacy behavior unchanged (fast command, exit 0).
 */
import { strict as assert } from "node:assert";
import { tmpdir } from "node:os";
import { afterEach, describe, test } from "node:test";

import { defaultRunCmd, resetRunCmd, runCmd, setRunCmd } from "../src/run-cmd.js";

afterEach(() => {
	resetRunCmd();
});

describe("run-cmd timeout (D-FX-1)", () => {
	test("timeoutMs kills a hung child: non-zero exit + 'timed out' on stderr, under 2s", async () => {
		const t0 = Date.now();
		const r = await defaultRunCmd("sleep", ["10"], { cwd: tmpdir(), timeoutMs: 200 });
		const elapsed = Date.now() - t0;
		assert.ok(r.exitCode !== 0, `expected non-zero exit, got ${r.exitCode}`);
		assert.ok(r.stderr.includes("timed out"), `stderr should note the timeout, got: ${r.stderr}`);
		assert.ok(elapsed < 2000, `kill must land well under 2s, took ${elapsed}ms`);
	});

	test("timeoutMs does not fire for a child that exits in time", async () => {
		const r = await defaultRunCmd("sleep", ["0.1"], { cwd: tmpdir(), timeoutMs: 5000 });
		assert.equal(r.exitCode, 0);
		assert.ok(!r.stderr.includes("timed out"));
	});
});

describe("run-cmd env merge (D-FX-1)", () => {
	const PROBE = "FX_RUN_CMD_PROBE_SHOULD_NOT_BE_SET_ANYWHERE";

	test("env is merged over process.env and visible to the child", async () => {
		const r = await defaultRunCmd("sh", ["-c", `printf %s "$${PROBE}"`], {
			cwd: tmpdir(),
			env: { [PROBE]: "on" },
		});
		assert.equal(r.exitCode, 0);
		assert.equal(r.stdout, "on");
	});

	test("without env the probe variable is absent (no accidental leakage)", async () => {
		const r = await defaultRunCmd("sh", ["-c", `printf %s "$${PROBE}"`], { cwd: tmpdir() });
		assert.equal(r.exitCode, 0);
		assert.equal(r.stdout, "");
	});
});

describe("run-cmd legacy behavior (no new opts)", () => {
	test("no timeoutMs/env: fast command resolves with its real exit code", async () => {
		const r = await defaultRunCmd("sh", ["-c", "echo legacy"], { cwd: tmpdir() });
		assert.equal(r.exitCode, 0);
		assert.match(r.stdout, /legacy/);
	});

	test("injected fakes still receive the full opts object (signature compatible)", async () => {
		let seen: unknown;
		setRunCmd(async (_cmd, _args, opts) => {
			seen = opts;
			return { stdout: "", stderr: "", exitCode: 0 };
		});
		await runCmd("git", ["status"], { cwd: tmpdir(), timeoutMs: 5, env: { A: "b" } });
		assert.deepEqual(seen, { cwd: tmpdir(), timeoutMs: 5, env: { A: "b" } });
	});
});
