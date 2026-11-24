/**
 * memory/queue-drain.ts — the queue drain orchestration (SPEC 2026-10-07
 * P2-3 W5/W6; the protocol itself is P0-3's queue.ts).
 *
 * Everything between "a queue dir exists" and "each record is settled or
 * released" lives here: candidate enumeration, dead-claim recovery, the
 * claim → re-read → route/attempt/age validation, the attempt bump, the
 * completion call, the apply, and the token finalization. automation.ts
 * keeps settings, correction/review scheduling, the prompt templates and
 * the hooks — it only captures a cap at session_start and injects ports.
 *
 * The cap is IMMUTABLE from capture time (dirs/model/registry/projectKey);
 * the drain never holds or late-reads a ctx. The completion uses its own
 * 20s timeout and is deliberately NOT linked to any session abort — a /new
 * mid-drain must not corrupt the old drain's routing or diagnostics.
 *
 * applyOpsOutcome is the shared application summary: runOps (review /
 * correction) and this drain produce the SAME summary for the same ops.
 * Trigger wording, diagnostic fields, empty-ops counting and timestamps
 * stay with their own callers — code sharing must not change flush/review
 * semantics.
 *
 * Diagnostics are RETURNED (DrainSummary[]), never written to shared state
 * by concurrent workers — the caller aggregates after allSettled.
 *
 * BH-E2 (spec 2026-11-14-backtest-hardening): validateClaimed checks the
 * attempt cap and the record age BEFORE the blacklist/projectsDir skips —
 * expired records take the same settle-with-diagnostic disposal path no
 * matter their routing, so cross-project records can no longer be
 * skipped-and-released forever. Age is the record's own savedAt (the
 * release rename must not reset it).
 */

import type { Api, Model } from "@earendil-works/pi-ai";

import { applyMemoryOps, type MemoryOp, type OpsOutcome } from "./store.ts";
import {
	bumpClaimedAttempts,
	claimRecord,
	type ConversationPart,
	loadQueue,
	QUEUE_MAX_AGE_MS,
	type QueueClaim,
	reclaimStaleClaims,
	releaseClaim,
	settleClaim,
} from "./queue.ts";
import type { LlmComplete, OpsCompletion } from "./llm.ts";

export const FLUSH_QUEUE_MS = 20_000;
export const QUEUE_DRAIN_MAX = 5;
export const QUEUE_MAX_ATTEMPTS = 3;

export interface DrainCap {
	d: { project: string; projectsDir: string; agentDir: string };
	model: Model<Api> | undefined;
	registry: never;
	projectKey: string | undefined;
	complete: LlmComplete | undefined;
}

export interface QueueDrainPorts {
	complete: (cap: DrainCap, parts: ConversationPart[]) => Promise<OpsCompletion>;
	applyOps?: (ops: MemoryOp[], cap: DrainCap) => OpsOutcome;
	blacklistHas: (key: string) => boolean;
	blacklistAdd: (key: string) => void;
}

export interface DrainSummary {
	applied: number;
	lastFlush?: string;
	lastError?: string;
}

export function applyOpsOutcome(ops: MemoryOp[], cap: DrainCap): OpsOutcome {
	return applyMemoryOps(ops, { project: cap.d.project });
}

async function drainOneRecord(cap: DrainCap, claim: QueueClaim, ports: QueueDrainPorts): Promise<DrainSummary> {
	const summary: DrainSummary = { applied: 0 };
	let finished = false;
	const finish = (consume: boolean): void => {
		if (finished) return;
		finished = true;
		try {
			if (consume) settleClaim(cap.d.agentDir, claim);
			else releaseClaim(cap.d.agentDir, claim);
		} catch {
		}
	};
	try {
		if (!bumpClaimedAttempts(cap.d.agentDir, claim)) {
			ports.blacklistAdd(`${claim.original}|${claim.record.sessionId}`);
			finish(false);
			return summary;
		}
		let completion: OpsCompletion;
		try {
			completion = await ports.complete(cap, claim.record.parts);
		} catch {
			finish(false);
			return summary;
		}
		if (completion.ok) {
			if (completion.ops.length > 0) {
				const apply = ports.applyOps ?? ((ops, c) => applyOpsOutcome(ops, c));
				let outcome: OpsOutcome;
				try {
					outcome = apply(completion.ops as MemoryOp[], cap);
				} catch (err) {
					summary.lastError = `flush-queued: apply threw: ${err instanceof Error ? err.message : String(err)}`;
					finish(false);
					return summary;
				}
				summary.applied = outcome.applied;
				summary.lastFlush = `flush-queued: ${outcome.applied} op(s)`;
				if (outcome.error) {
					// B2 apply-fatal: deterministic — retrying cannot fix it
					finish(true);
					summary.lastError = `flush-queued: ${outcome.error}`;
					return summary;
				}
			}
			finish(true);
		} else if (claim.record.attempts >= QUEUE_MAX_ATTEMPTS) {
			finish(true);
			summary.lastError = `flush-queued: dropped after ${claim.record.attempts} attempts (${completion.reason ?? "failed"})`;
		} else {
			finish(false);
		}
	} finally {
		finish(false);
	}
	return summary;
}

/** Claim-first validation on the RE-READ record (expiry, blacklist,
 *  routing). Settle-with-diagnostic, skip, or eligible.
 *
 *  BH-E2 (spec 2026-11-14-backtest-hardening): the attempt-cap and age
 *  checks run FIRST — on base the projectsDir routing skip preceded them,
 *  so cross-project records (and, equivalently, blacklisted ones) were
 *  skipped-and-released forever: never counted, never expired, re-released
 *  as NEW pending files at every startup. Expired records now take the
 *  SAME settle-with-diagnostic disposal path regardless of routing. Age
 *  comes from the record's own `savedAt`, never the file mtime — the
 *  release rename must not reset a record's age. The blacklist and the
 *  B1 routing skip keep their semantics for NON-expired records. */
function validateClaimed(cap: DrainCap, claim: QueueClaim, ports: QueueDrainPorts): { drop?: string; skip?: boolean } {
	if (claim.record.attempts >= QUEUE_MAX_ATTEMPTS) {
		return { drop: `flush-queued: dropped after ${claim.record.attempts} attempts` };
	}
	if (Date.now() - claim.record.savedAt > QUEUE_MAX_AGE_MS || claim.record.parts.length === 0) {
		return { drop: "flush-queued: expired record" };
	}
	if (ports.blacklistHas(`${claim.original}|${claim.record.sessionId}`)) return { skip: true };
	if (claim.record.projectsDir !== cap.d.projectsDir) return { skip: true };
	return {};
}

export interface DrainResult {
	summaries: DrainSummary[];
	drops: string[];
}

export async function drainQueue(cap: DrainCap, ports: QueueDrainPorts): Promise<DrainResult> {
	let processed = 0;
	const eligible: QueueClaim[] = [];
	const drops: string[] = [];
	const recovered = reclaimStaleClaims(cap.d.agentDir, Date.now());
	const candidates = loadQueue(cap.d.agentDir).map((c) => c.file);
	const claimIterator = (function* (): Generator<QueueClaim | null> {
		for (const file of candidates) {
			if (processed >= QUEUE_DRAIN_MAX) return;
			yield claimRecord(cap.d.agentDir, { file });
		}
		yield* recovered;
	})();
	for (const claim of claimIterator) {
		if (!claim) continue;
		const verdict = validateClaimed(cap, claim, ports);
		if (verdict.skip) {
			releaseClaim(cap.d.agentDir, claim);
			continue;
		}
		if (verdict.drop) {
			settleClaim(cap.d.agentDir, claim);
			drops.push(verdict.drop);
			continue;
		}
		processed++;
		eligible.push(claim);
	}
	if (eligible.length === 0) return { summaries: [], drops };
	const settled = await Promise.allSettled(eligible.map((claim) => drainOneRecord(cap, claim, ports)));
	const summaries: DrainSummary[] = [];
	for (const outcome of settled) {
		summaries.push(outcome.status === "fulfilled" ? outcome.value : { applied: 0 });
	}
	return { summaries, drops };
}
