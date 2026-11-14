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

describe("run-cmd timeout escalation (T1/T2/T3, SPEC CH 2026-11-15)", () => {
	/** Bound any run-cmd call so a regression surfaces as a rejection, not a
	 *  hung runner. Every T1/T2 test asserts its own tighter elapsed bound. */
	function bounded<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
		return Promise.race([
			p,
			new Promise<never>((_, reject) =>
				setTimeout(() => reject(new Error(`${label}: run-cmd did not resolve within ${ms}ms`)), ms)),
		]);
	}

	test("T1a: SIGTERM-ignoring child is SIGKILLed after the grace and returns bounded", async () => {
		const t0 = Date.now();
		const r = await bounded(
			defaultRunCmd("sh", ["-c", 'trap "" TERM; sleep 30'], { cwd: tmpdir(), timeoutMs: 200 }),
			6000,
			"T1a",
		);
		const elapsed = Date.now() - t0;
		assert.ok(r.exitCode !== 0, `expected non-zero exit, got ${r.exitCode}`);
		assert.ok(r.stderr.includes("timed out"), `stderr should note the timeout, got: ${r.stderr}`);
		// 200ms timeout + 2s grace + close latency — well under 4.5s.
		assert.ok(elapsed < 4500, `SIGTERM→SIGKILL escalation must stay bounded, took ${elapsed}ms`);
	});

	test("T1b: grandchild holding the stdio pipes still resolves bounded", async () => {
		const t0 = Date.now();
		const r = await bounded(
			// The shell execs into sleep 30 (dies on SIGTERM); the orphaned
			// `sleep 5` keeps the shared stdout pipe open, so `close` cannot
			// fire until it exits — unless the adapter drains + destroys.
			defaultRunCmd("sh", ["-c", "sleep 5 & exec sleep 30"], { cwd: tmpdir(), timeoutMs: 200 }),
			6000,
			"T1b",
		);
		const elapsed = Date.now() - t0;
		assert.ok(r.exitCode !== 0);
		assert.ok(r.stderr.includes("timed out"));
		assert.ok(elapsed < 2000, `pipe drain must bound the resolve, took ${elapsed}ms`);
	});

	test("T2: timer firing after the child already exited resolves with the REAL exit code", async () => {
		const t0 = Date.now();
		const r = await bounded(
			defaultRunCmd("sh", ["-c", "echo hi; sleep 3 & exit 0"], { cwd: tmpdir(), timeoutMs: 500 }),
			2500,
			"T2",
		);
		const elapsed = Date.now() - t0;
		assert.equal(r.exitCode, 0, `real exit code expected, got ${r.exitCode} (stderr: ${r.stderr})`);
		assert.match(r.stdout, /hi/);
		assert.ok(!r.stderr.includes("timed out"), "an exited child is not a timeout");
		assert.ok(elapsed < 2000, `must not wait for the orphaned pipe, took ${elapsed}ms`);
	});

	test("T3: timeoutMs <= 0 means NO timeout (Node convention)", async () => {
		const r = await defaultRunCmd("sleep", ["0.3"], { cwd: tmpdir(), timeoutMs: 0 });
		assert.equal(r.exitCode, 0, `sleep 0.3 must survive a 0 timeout, got ${r.exitCode} (${r.stderr})`);
		assert.ok(!r.stderr.includes("timed out"));
	});

	test("T3: non-finite timeoutMs means NO timeout", async () => {
		for (const t of [Number.NaN, Number.POSITIVE_INFINITY]) {
			const r = await defaultRunCmd("sleep", ["0.1"], { cwd: tmpdir(), timeoutMs: t });
			assert.equal(r.exitCode, 0, `sleep must survive timeoutMs=${t}, got ${r.exitCode} (${r.stderr})`);
		}
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
