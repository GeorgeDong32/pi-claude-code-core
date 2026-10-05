import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import {
	buildGoalAuditorPrompt,
	goalAuditorConfigPath,
	loadGoalAuditorFileConfig,
	parseAuditorDecision,
	parseGoalAuditorConfig,
	saveGoalAuditorFileConfig,
} from "../goal-auditor.ts";
import type { GoalRecord } from "../goal-record.ts";

function goal(overrides: Partial<GoalRecord> = {}): GoalRecord {
	return {
		id: "g1",
		objective: "Write a complete tutorial, not just a scaffold.",
		status: "active",
		autoContinue: true,
		usage: { tokensUsed: 0, activeSeconds: 0, costUsed: 0 },
		sisyphus: false,
		createdAt: "2026-05-12T00:00:00.000Z",
		updatedAt: "2026-05-12T00:00:00.000Z",
		...overrides,
	};
}

test("parseAuditorDecision requires explicit approval and lets disapproval win", () => {
	assert.deepEqual(parseAuditorDecision("Looks good\n<approved/>"), { approved: true, disapproved: false });
	assert.deepEqual(parseAuditorDecision("Nope\n<disapproved/>"), { approved: false, disapproved: true });
	assert.deepEqual(parseAuditorDecision("confused <approved/> <disapproved/>"), { approved: false, disapproved: true });
	assert.deepEqual(parseAuditorDecision("no marker"), { approved: false, disapproved: false });
});

test("parseGoalAuditorConfig supports provider/model and thinking_level aliases", () => {
	assert.deepEqual(parseGoalAuditorConfig({ provider: "fireworks", model: "accounts/fireworks/routers/kimi", thinking_level: "high" }), {
		provider: "fireworks",
		model: "accounts/fireworks/routers/kimi",
		thinkingLevel: "high",
	});
	assert.deepEqual(parseGoalAuditorConfig({ provider: " ", model: 123, thinkingLevel: "ludicrous" }), {});
});

test("saveGoalAuditorFileConfig persists UI-editable auditor settings", () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-goal-auditor-test-"));
	try {
		const saved = saveGoalAuditorFileConfig(cwd, {
			provider: "fireworks",
			model: "accounts/fireworks/routers/kimi",
			thinkingLevel: "high",
		});
		assert.deepEqual(saved, {
			provider: "fireworks",
			model: "accounts/fireworks/routers/kimi",
			thinkingLevel: "high",
		});
		assert.equal(goalAuditorConfigPath(cwd), path.join(cwd, ".pi", "goal-auditor.json"));
		assert.deepEqual(loadGoalAuditorFileConfig(cwd), saved);
		assert.match(fs.readFileSync(goalAuditorConfigPath(cwd), "utf8"), /"thinking_level": "high"/);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("buildGoalAuditorPrompt demands semantic approval markers", () => {
	const prompt = buildGoalAuditorPrompt({
		goal: goal(),
		completionSummary: "Generated a VitePress scaffold and build passes.",
		detailedSummary: "Goal: tutorial",
	});
	assert.match(prompt, /independent completion auditor/);
	assert.match(prompt, /scaffold-only|alpha scaffold|generated template/);
	assert.match(prompt, /<approved\/>/);
	assert.match(prompt, /<disapproved\/>/);
	assert.match(prompt, /Generated a VitePress scaffold/);
});

// ---------- prompt guardrails + timeout config (spec 2026-10-04-goal-audit-hang-fix §4.2) ----------

test("buildGoalAuditorPrompt forbids home/cloud-storage scans and long-running processes", () => {
	const prompt = buildGoalAuditorPrompt({ goal: goal(), completionSummary: "c", detailedSummary: "d" });
	assert.match(prompt, /project working directory|project directory/);
	assert.match(prompt, /CloudStorage/);
	assert.match(prompt, /long-running foreground/);
});

test("auditor resource-loader system prompt constrains inspection to the repository directory", async () => {
	const mod = await import("../goal-auditor.ts");
	const loader = (mod as { makeAuditorResourceLoader?: () => { getSystemPrompt(): string } }).makeAuditorResourceLoader?.();
	assert.ok(loader, "makeAuditorResourceLoader must be exported for audit wiring reuse");
	const sp = loader.getSystemPrompt();
	assert.match(sp, /repository working directory|project/);
});

test("parseGoalAuditorConfig parses auditTimeoutMs with clamping and fallbacks", () => {
	assert.deepEqual(parseGoalAuditorConfig({ auditTimeoutMs: 120_000 }), { auditTimeoutMs: 120_000 });
	assert.deepEqual(parseGoalAuditorConfig({ auditTimeoutMs: 1 }), { auditTimeoutMs: 60_000 });
	assert.deepEqual(parseGoalAuditorConfig({ auditTimeoutMs: "abc" }), {});
	assert.deepEqual(parseGoalAuditorConfig({}), {});
	assert.deepEqual(parseGoalAuditorConfig({ auditTimeoutMs: 0 }), {});
});

// ── AR1005-AU-02 (spec 2026-10-05 §5): the auditor session's full remaining
// lifecycle is covered by try/finally — cancel-during-creation, prompt
// cancellation, subscribe/unsubscribe failures all dispose exactly once.
// Driven through the controlled sessionAdapter seam (production adapter =
// the real createAgentSession). Baseline red evidence via stash. ──
import { runGoalCompletionAuditor, type AuditorSession } from "../goal-auditor.ts";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

interface CallLog { calls: string[] }

/** Controlled session with call-sequence recording and gated prompt. */
function fakeSession(log: CallLog, opts: { promptHangs?: boolean; subscribeThrows?: boolean; unsubscribeThrows?: boolean; disposeThrows?: boolean } = {}) {
	let resolvePrompt: (() => void) | null = null;
	const session: AuditorSession & { releasePrompt: () => void } = {
		subscribe(listener) {
			if (opts.subscribeThrows) throw new Error("subscribe boom");
			log.calls.push("subscribe");
			void listener;
			return () => {
				if (opts.unsubscribeThrows) throw new Error("unsubscribe boom");
				log.calls.push("unsubscribe");
			};
		},
		prompt(_prompt) {
			log.calls.push("prompt");
			if (opts.promptHangs) {
				return new Promise<void>((resolve) => {
					resolvePrompt = resolve;
				});
			}
			return Promise.resolve(undefined);
		},
		abort() {
			log.calls.push("abort");
			resolvePrompt?.();
			return Promise.resolve();
		},
		dispose() {
			if (opts.disposeThrows) throw new Error("dispose boom");
			log.calls.push("dispose");
		},
		releasePrompt() {
			resolvePrompt?.();
		},
	};
	return session;
}

function auCtx(cwd: string): ExtensionContext {
	return { cwd, hasUI: false, modelRegistry: { getAll: () => [{ provider: "test", id: "aud-1" }] } } as unknown as ExtensionContext;
}

test("AU-T03: cancel during creation — no prompt, dispose exactly once, error outcome", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "au-t03-"));
	const log: CallLog = { calls: [] };
	const controller = new AbortController();
	let releaseOpen: ((s: { session: AuditorSession }) => void) | null = null;
	const session = fakeSession(log);
	const outcome = runGoalCompletionAuditor({
		ctx: auCtx(dir),
		goal: goal(),
		detailedSummary: "s",
		signal: controller.signal,
		sessionAdapter: () => new Promise((resolve) => {
			releaseOpen = resolve;
		}),
	});
	await new Promise((r) => setTimeout(r, 5));
	controller.abort(); // cancelled WHILE the session is being created
	await new Promise((r) => setTimeout(r, 5));
	(releaseOpen as ((s: { session: AuditorSession }) => void) | null)?.({ session });
	const result = await outcome;
	assert.ok(!result.approved);
	assert.equal(result.error, "Auditor aborted.");
	assert.deepEqual(log.calls, ["subscribe", "unsubscribe", "dispose"]); // NO prompt
});

test("AU-T04: cancel during prompt — session.abort called, prompt settles, dispose+unsubscribe exactly once", { timeout: 3000 }, async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "au-t04-"));
	const log: CallLog = { calls: [] };
	const controller = new AbortController();
	const session = fakeSession(log, { promptHangs: true });
	const outcomePromise = runGoalCompletionAuditor({
		ctx: auCtx(dir),
		goal: goal(),
		detailedSummary: "s",
		signal: controller.signal,
		sessionAdapter: async () => ({ session }),
	});
	await new Promise((r) => setTimeout(r, 5));
	assert.deepEqual(log.calls, ["subscribe", "prompt"]);
	controller.abort(); // mid-prompt
	const result = await outcomePromise;
	assert.deepEqual(log.calls, ["subscribe", "prompt", "abort", "unsubscribe", "dispose"]);
	assert.ok(!result.approved); // aborted prompt produces no approval
});

test("AU-T06a: subscribe throws — dispose still runs, error outcome, no prompt", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "au-t06a-"));
	const log: CallLog = { calls: [] };
	const session = fakeSession(log, { subscribeThrows: true });
	const result = await runGoalCompletionAuditor({
		ctx: auCtx(dir),
		goal: goal(),
		detailedSummary: "s",
		sessionAdapter: async () => ({ session }),
	});
	assert.ok(!result.approved);
	assert.match(result.error ?? "", /subscribe boom/);
	assert.deepEqual(log.calls, ["dispose"]); // disposed despite the subscribe failure
});

test("AU-T06b: unsubscribe throws — dispose still ran first, primary result unmasked", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "au-t06b-"));
	const log: CallLog = { calls: [] };
	const session = fakeSession(log, { unsubscribeThrows: true });
	session.subscribe(() => {}); // warm: not needed, adapter drives real flow below
	const result = await runGoalCompletionAuditor({
		ctx: auCtx(dir),
		goal: goal(),
		detailedSummary: "s",
		sessionAdapter: async () => ({ session }),
	});
	// the run itself completes (output empty → disapproved), unsubscribe failure skipped nothing
	assert.deepEqual(log.calls.filter((c) => c !== "subscribe" && c !== "unsubscribe"), ["prompt", "dispose"]);
	assert.ok(!result.approved);
});

test("AU-T06c: dispose throws — result is still returned, not masked", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "au-t06c-"));
	const log: CallLog = { calls: [] };
	const session = fakeSession(log, { disposeThrows: true });
	const result = await runGoalCompletionAuditor({
		ctx: auCtx(dir),
		goal: goal(),
		detailedSummary: "s",
		sessionAdapter: async () => ({ session }),
	});
	assert.ok(!result.approved);
	assert.ok(result.error === undefined || !/dispose boom/.test(result.error), "dispose failure must not become the outcome");
	assert.deepEqual(log.calls, ["subscribe", "prompt", "unsubscribe"]);
});

test("AU-T05: signal already aborted after a late creation — cleanup only, no passed", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "au-t05-"));
	const log: CallLog = { calls: [] };
	const controller = new AbortController();
	controller.abort(); // the flow already timed out before this auditor invocation
	const session = fakeSession(log);
	const result = await runGoalCompletionAuditor({
		ctx: auCtx(dir),
		goal: goal(),
		detailedSummary: "s",
		signal: controller.signal,
		sessionAdapter: async () => ({ session }),
	});
	assert.ok(!result.approved); // late work can never produce passed
	assert.equal(result.error, "Auditor aborted.");
	assert.ok(!log.calls.includes("prompt"));
	assert.deepEqual(log.calls, ["subscribe", "unsubscribe", "dispose"]);
});
