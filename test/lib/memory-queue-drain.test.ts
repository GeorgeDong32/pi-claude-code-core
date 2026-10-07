/**
 * memory-queue-drain.test.ts — SPEC 2026-10-07 P2-3 §5 D-T1/D-T2: the drain
 * orchestration is directly testable WITHOUT the hook harness — ports are
 * injected, the queue protocol is the real one on a real temp dir.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	applyOpsOutcome,
	drainQueue,
	QUEUE_MAX_ATTEMPTS,
	type DrainCap,
	type QueueDrainPorts,
} from "../../extensions/memory/queue-drain.ts";
import { queueDir, writeQueueRecord, type QueueRecord } from "../../extensions/memory/queue.ts";
import { applyMemoryOps, type MemoryOp } from "../../extensions/memory/store.ts";

let home: string;
let project: string;
let agentDir: string;
let memoryDir: string;
let projectsDir: string;

const OPS: Array<MemoryOp> = [
	{ action: "add", layer: "user", name: "drain-fact", description: "d", body: "body text" },
];

function cap(): DrainCap {
	return { d: { project: memoryDir, user: join(home, "memory"), projectsDir, agentDir }, model: undefined, registry: undefined as never, projectKey: undefined, complete: undefined };
}

function stage(id: string, over: Partial<QueueRecord> = {}): void {
	writeQueueRecord(agentDir, {
		v: 1, sessionId: id, projectsDir, cwd: project, savedAt: Date.now(), attempts: 0,
		parts: [{ role: "user", text: "tail" }],
		...over,
	} as QueueRecord);
}

function recordFiles(): string[] {
	return existsSync(queueDir(agentDir)) ? readdirSync(queueDir(agentDir)) : [];
}

const okCompletion = (ops: MemoryOp[]) => ({ ok: true as const, ops, stopReason: "stop", content: [] });
const failCompletion = { ok: false as const, reason: "provider_error", error: "down" };

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "p23-drain-h-"));
	project = mkdtempSync(join(tmpdir(), "p23-drain-p-"));
	const sanitized = project.replace(/\//g, "-");
	agentDir = join(home, ".pi", "agent");
	projectsDir = join(agentDir, "projects", sanitized);
	memoryDir = join(projectsDir, "memory");
	mkdirSync(memoryDir, { recursive: true });
});

afterEach(() => {
	rmSync(home, { recursive: true, force: true });
	rmSync(project, { recursive: true, force: true });
});

function ports(over: Partial<QueueDrainPorts> = {}): QueueDrainPorts {
	return {
		complete: async () => okCompletion(OPS),
		blacklistHas: () => false,
		blacklistAdd: () => {},
		...over,
	};
}

describe("drainQueue direct (D-T1)", () => {
	it("ok + apply → settled (file gone), summary carries the applied count", async () => {
		stage("dt1");
		const result = await drainQueue(cap(), ports());
		expect(result.summaries).toHaveLength(1);
		expect(result.summaries[0]!.applied).toBe(1);
		expect(result.summaries[0]!.lastFlush).toContain("flush-queued: 1 op(s)");
		expect(recordFiles()).toEqual([]);
	});

	it("completion THROW → released to pending (retryable), no unhandled rejection", async () => {
		stage("dt1b");
		const result = await drainQueue(cap(), ports({ complete: async () => { throw new Error("infra"); } }));
		expect(result.summaries).toHaveLength(1);
		expect(result.summaries[0]!.applied).toBe(0);
		const files = recordFiles();
		expect(files).toHaveLength(1);
		expect(files[0]).toMatch(/\.pending\./);
	});

	it("completion FAIL with attempts left → released; at the cap → settled with a drop diagnostic", async () => {
		stage("dt1c", { attempts: QUEUE_MAX_ATTEMPTS - 1 });
		const result = await drainQueue(cap(), ports({ complete: async () => failCompletion as never }));
		expect(result.summaries[0]!.lastError).toContain("dropped after");
		expect(recordFiles()).toEqual([]);
		// attempts left → pending
		stage("dt1d");
		const result2 = await drainQueue(cap(), ports({ complete: async () => failCompletion as never }));
		expect(result2.summaries[0]!.lastError).toBeUndefined();
		expect(recordFiles()[0]).toMatch(/\.pending\.|\.claim\./);
	});

	it("apply-fatal → settled with the error diagnostic (consume, not retry)", async () => {
		stage("dt1e");
		const result = await drainQueue(cap(), ports({
			applyOps: () => ({ applied: 0, skipped: [], error: "deterministic" }),
		}));
		expect(result.summaries[0]!.lastError).toContain("flush-queued: deterministic");
		expect(recordFiles()).toEqual([]);
	});

	it("routing mismatch → skipped (released), foreign record survives; expired → dropped with diagnostic", async () => {
		stage("foreign", { projectsDir: "/somewhere/else" });
		let called = 0;
		const result = await drainQueue(cap(), ports({ complete: async () => { called++; return okCompletion([]); } }));
		expect(result.summaries).toHaveLength(0);
		expect(called).toBe(0);
		expect(recordFiles()).toHaveLength(1); // released back, untouched by us
		stage("expired", { savedAt: Date.now() - 8 * 24 * 3600_000 });
		const result2 = await drainQueue(cap(), ports());
		expect(result2.drops.some((d) => d.includes("expired"))).toBe(true);
		expect(recordFiles()).toHaveLength(1); // only the foreign one remains
	});

	it("blacklisted keys are skipped without a completion call", async () => {
		stage("bl");
		let called = 0;
		const result = await drainQueue(cap(), ports({
			complete: async () => { called++; return okCompletion([]); },
			blacklistHas: () => true,
		}));
		expect(result.summaries).toHaveLength(0);
		expect(called).toBe(0);
	});
});

describe("cap order (review R2 on the fix)", () => {
	it("beyond QUEUE_DRAIN_MAX, surplus records STAY ready — never stranded as this-pid claims", async () => {
		for (let i = 0; i < 7; i++) stage(`cap-${i}`, { savedAt: Date.parse("2026-10-07T10:00:00.000Z") + i });
		let completions = 0;
		const result = await drainQueue(cap(), ports({ complete: async () => { completions++; return { ok: true as const, ops: [], stopReason: "stop", content: [] }; } }));
		expect(result.summaries).toHaveLength(5); // QUEUE_DRAIN_MAX
		expect(completions).toBe(5); // the cap counted records that reached the LLM lane
		const files = recordFiles();
		expect(files).toHaveLength(2);
		// the untouched surplus is still a consumable record shape (ready or
		// pending — NOT a claim stranded under our pid)
		expect(files.every((f) => f.endsWith(".json") || f.includes(".pending."))).toBe(true);
		expect(files.some((f) => f.includes(".claim."))).toBe(false);
	});
});

describe("reclaim path through drainQueue (review P2 regression)", () => {
	it("a dead claim recovered BY drainQueue itself never nests suffixes; release lands on a clean pending name", async () => {
		stage("rcv");
		// forge a dead-owner claim past the TTL (pid 999999 does not exist →
		// the default signal probe says dead)
		const ready = readdirSync(queueDir(agentDir)).find((f) => f.endsWith(".json"))!;
		const nonce = "deadbeef-0000-4000-8000-000000000000";
		const foreignName = `${ready}.claim.999999.${Date.now() - 11 * 60_000}.${nonce}`;
		require("node:fs").renameSync(join(queueDir(agentDir), ready), join(queueDir(agentDir), foreignName));
		// drain through the real orchestration: the internal recovery hands the
		// reclaimed token DIRECTLY into validation (no re-claim → no nesting)
		const result = await drainQueue(cap(), ports({ complete: async () => ({ ok: false as const, reason: "provider_error" }) as never }));
		expect(result.summaries).toHaveLength(1);
		const files = recordFiles();
		expect(files).toHaveLength(1);
		expect(files[0]).toMatch(/^rcv-\d+\.json\.pending\.[0-9a-f-]{36}$/); // NO nested .claim. inside
		// and the record content survived with its attempts bumped
		const rec = JSON.parse(readFileSync(join(queueDir(agentDir), files[0]!), "utf-8")) as { attempts: number };
		expect(rec.attempts).toBe(1);
	});
});

describe("applyOpsOutcome parity (D-T2)", () => {
	it("runOps' summary and the drain's summary agree for the same ops on equal fresh dirs", async () => {
		// two PARALLEL fresh dirs — applying the same add twice into ONE dir
		// would trivially disagree (the second is a duplicate skip)
		const dirsA = { user: join(home, "memA"), project: join(home, "projA") };
		const dirsB = { user: join(home, "memB"), project: join(home, "projB") };
		const runOpsOutcome = applyMemoryOps(OPS, dirsA, { projectKey: undefined, routedNotes: [] });
		const notesA: string[] = [];
		const viaShared = applyOpsOutcome(OPS, dirsB, undefined, notesA);
		expect(viaShared.applied).toBe(runOpsOutcome.applied);
		expect(viaShared.error).toBe(runOpsOutcome.error);
		expect(viaShared.skipped).toEqual(runOpsOutcome.skipped);
		// empty ops: both count zero, no timestamps involved
		expect(applyOpsOutcome([], { user: "", project: "" }, undefined, []).applied).toBe(0);
	});
});
