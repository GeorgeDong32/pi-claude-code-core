import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, describe, it } from "node:test";

import {
	drainQueue,
	QUEUE_MAX_ATTEMPTS,
	type DrainCap,
	type QueueDrainPorts,
} from "../queue-drain.ts";
import { claimRecord, queueDir, releaseClaim, writeQueueRecord, type QueueRecord } from "../queue.ts";

let home: string;
let project: string;
let agentDir: string;
let projectsDir: string;

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "bh-e2-h-"));
	project = mkdtempSync(join(tmpdir(), "bh-e2-p-"));
	agentDir = join(home, ".pi", "agent");
	projectsDir = join(agentDir, "projects", project.replace(/\//g, "-"));
});

after(() => {
	rmSync(home, { recursive: true, force: true });
	rmSync(project, { recursive: true, force: true });
});

const DAY = 24 * 3600_000;

function cap(): DrainCap {
	return {
		d: { project: join(projectsDir, "memory"), projectsDir, agentDir },
		model: undefined,
		registry: undefined as never,
		projectKey: undefined,
		complete: undefined,
	};
}

function stage(id: string, over: Partial<QueueRecord> = {}): void {
	writeQueueRecord(agentDir, {
		v: 1,
		sessionId: id,
		projectsDir,
		cwd: project,
		savedAt: Date.now(),
		attempts: 0,
		parts: [{ role: "user", text: "tail" }],
		...over,
	} as QueueRecord);
}

function recordFiles(): string[] {
	return existsSync(queueDir(agentDir)) ? readdirSync(queueDir(agentDir)) : [];
}

function ports(calls: { completions: number }, over: Partial<QueueDrainPorts> = {}): QueueDrainPorts {
	return {
		complete: async () => {
			calls.completions++;
			return { ok: true as const, ops: [], stopReason: "stop", content: [] };
		},
		blacklistHas: () => false,
		blacklistAdd: () => {},
		...over,
	};
}

describe("BH-E2: expiry precedes the projectsDir routing skip", () => {
	it("an EXPIRED cross-project record is disposed, not skipped forever", async () => {
		stage("xp-expired", { projectsDir: "/somewhere/else", savedAt: Date.now() - 8 * DAY });
		const calls = { completions: 0 };
		const result = await drainQueue(cap(), ports(calls));
		assert.deepEqual(recordFiles(), [], "the expired cross-project record must be settled (gone), not released");
		assert.ok(
			result.drops.some((d) => d.includes("expired")),
			`expected the same expired-record diagnostic, got: ${JSON.stringify(result.drops)}`,
		);
		assert.equal(calls.completions, 0, "a disposed record never reaches the LLM lane");
	});

	it("an over-attempts cross-project record is dropped (attempt cap precedes routing)", async () => {
		stage("xp-attempts", { projectsDir: "/somewhere/else", attempts: QUEUE_MAX_ATTEMPTS });
		const calls = { completions: 0 };
		const result = await drainQueue(cap(), ports(calls));
		assert.deepEqual(recordFiles(), []);
		assert.ok(result.drops.some((d) => d.includes("dropped after")));
		assert.equal(calls.completions, 0);
	});

	it("a NON-expired cross-project record is still released/skipped as today", async () => {
		stage("xp-fresh", { projectsDir: "/somewhere/else" });
		const calls = { completions: 0 };
		const result = await drainQueue(cap(), ports(calls));
		assert.equal(calls.completions, 0);
		assert.deepEqual(result.drops, []);
		const files = recordFiles();
		assert.equal(files.length, 1, "the foreign record survives, released back for its own project");
		assert.match(files[0]!, /\.pending\./);
	});

	it("an expired record that was RELEASED (fresh mtime) still expires — age is the record's savedAt, not the file mtime", async () => {
		stage("xp-renamed", { projectsDir: "/somewhere/else", savedAt: Date.now() - 8 * DAY });
		const ready = recordFiles().find((f) => f.endsWith(".json"))!;
		const claim = claimRecord(agentDir, { file: ready });
		assert.notEqual(claim, null);
		assert.equal(releaseClaim(agentDir, claim!), true);
		assert.match(recordFiles()[0]!, /\.pending\./);
		const calls = { completions: 0 };
		const result = await drainQueue(cap(), ports(calls));
		assert.deepEqual(recordFiles(), [], "a released expired record must still be disposed on the next drain");
		assert.ok(result.drops.some((d) => d.includes("expired")));
		assert.equal(calls.completions, 0);
	});

	it("an expired blacklisted record is disposed too (expiry is absolute, not routing-scoped)", async () => {
		stage("bl-expired", { savedAt: Date.now() - 8 * DAY });
		const calls = { completions: 0 };
		const result = await drainQueue(cap(), ports(calls, { blacklistHas: () => true }));
		assert.deepEqual(recordFiles(), []);
		assert.ok(result.drops.some((d) => d.includes("expired")));
		assert.equal(calls.completions, 0);
	});

	it("a non-expired blacklisted record is still skipped without a completion call", async () => {
		stage("bl-fresh");
		const calls = { completions: 0 };
		const result = await drainQueue(cap(), ports(calls, { blacklistHas: () => true }));
		assert.equal(calls.completions, 0);
		assert.deepEqual(result.drops, []);
		assert.equal(recordFiles().length, 1);
		assert.match(recordFiles()[0]!, /\.pending\./);
	});

	it("same-project expiry disposal is unchanged (control)", async () => {
		stage("sp-expired", { savedAt: Date.now() - 8 * DAY });
		const calls = { completions: 0 };
		const result = await drainQueue(cap(), ports(calls));
		assert.deepEqual(recordFiles(), []);
		assert.ok(result.drops.some((d) => d.includes("expired")));
		assert.equal(calls.completions, 0);
	});
});
