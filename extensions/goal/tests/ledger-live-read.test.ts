/**
 * goal-ledger live-read tests (cherry-batch1 B2-9): the ledger read path
 * rides lib/live-jsonl.ts — torn tails from a concurrent appender are
 * dropped (fail-open), bad lines are counted, and LiveReadError maps to
 * an empty result + cache drop (the ledger never throws on read).
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { mkdirSync } from "node:fs";
import { GOAL_LEDGER_FILE, GoalLedgerContext, goalLedgerPath, readGoalLedger } from "../goal-ledger.ts";

const dir = mkdtempSync(join(tmpdir(), "ledger-live-"));
after(() => rmSync(dir, { recursive: true, force: true }));

/** Each case gets its own cwd so the derived ledger path is isolated. */
function ctxFor(name: string): GoalLedgerContext {
	const cwd = join(dir, name);
	mkdirSync(join(cwd, ".pi", "goals"), { recursive: true });
	return { cwd };
}

const ev = (goalId: string) =>
	JSON.stringify({ type: "goal_created", at: new Date().toISOString(), goalId, objective: "o", sisyphus: false, autoContinue: true }) + "\n";

describe("goal-ledger live JSONL read (cherry-batch1 B2-9)", () => {
	it("a committed multi-line ledger reads back every complete event", () => {
		const ctx = ctxFor("case-a");
		writeFileSync(goalLedgerPath(ctx), ev("g1") + ev("g2"));
		const r = readGoalLedger(ctx);
		assert.equal(r.events.length, 2);
	});

	it("a torn tail (another process mid-append) is dropped, not thrown; the prefix survives", () => {
		const ctx = ctxFor("case-b");
		writeFileSync(goalLedgerPath(ctx), ev("g1") + '{"type":"goal_created","at":"2026');
		const r = readGoalLedger(ctx);
		// the half-written second line is a torn tail: dropped, first event kept
		assert.equal(r.events.length, 1);
	});

	it("bad lines count as malformed alongside parse failures; valid lines survive", () => {
		const ctx = ctxFor("case-c");
		writeFileSync(goalLedgerPath(ctx), ev("g1") + "garbage line\n" + ev("g3"));
		const r = readGoalLedger(ctx);
		assert.ok(r.events.length >= 1);
		assert.ok(r.malformed >= 1);
	});

	it("a vanished ledger (first read, file not created) is an empty result, never a throw", () => {
		const r = readGoalLedger(ctxFor("case-d"));
		assert.equal(r.events.length, 0);
		assert.equal(r.malformed, 0);
	});

	it("a symlinked ledger fails closed (empty result + cache drop), never followed", () => {
		const ctx = ctxFor("case-e");
		const target = goalLedgerPath(ctx);
		writeFileSync(target, ev("g1"));
		// replace the real ledger with a symlink pointing elsewhere
		rmSync(target);
		symlinkSync(join(dir, "elsewhere.jsonl"), target);
		const r = readGoalLedger(ctx);
		assert.equal(r.events.length, 0);
	});
});
