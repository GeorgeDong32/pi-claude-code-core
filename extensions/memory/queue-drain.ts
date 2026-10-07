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

/** Drain lane constants (P0-3/2026-10-03): one 20s LLM budget per record;
 * at most 5 records per session; at most 3 attempts per record. */
export const FLUSH_QUEUE_MS = 20_000;
export const QUEUE_DRAIN_MAX = 5;
export const QUEUE_MAX_ATTEMPTS = 3;

export interface DrainCap {
	d: { project: string; user: string; projectsDir: string; agentDir: string };
	model: Model<Api> | undefined;
	registry: never;
	projectKey: string | undefined;
	complete: LlmComplete | undefined;
}

export interface QueueDrainPorts {
	/** Run the extraction completion for one record's parts (prompt template,
	 *  model wiring and the 20s budget live with the automation's injection). */
	complete: (cap: DrainCap, parts: ConversationPart[]) => Promise<OpsCompletion>;
	/** Apply extracted ops — defaults to applyMemoryOps via applyOpsOutcome. */
	applyOps?: (ops: MemoryOp[], cap: DrainCap, routedNotes: string[]) => OpsOutcome;
	/** Session blacklist (bump-failure records): consulted and extended by
	 *  key `original|sessionId` so a rename to pending cannot bypass it. */
	blacklistHas: (key: string) => boolean;
	blacklistAdd: (key: string) => void;
}

export interface DrainSummary {
	applied: number;
	routedNotes: string[];
	lastFlush?: string;
	lastError?: string;
}

/** W6: the ONE application summary shared by runOps and the drain — same
 *  ops, same dirs, same routing produce the same numbers and notes. */
export function applyOpsOutcome(
	ops: MemoryOp[],
	dirs: { user: string; project: string },
	projectKey: string | undefined,
	routedNotes: string[],
): OpsOutcome {
	return applyMemoryOps(ops, dirs, { projectKey, routedNotes });
}

/** One claimed record, best-effort (P0-3 §4.3). Every exit settles or
 *  releases the token (finally-guarded — no happy-path-only cleanup). */
async function drainOneRecord(cap: DrainCap, claim: QueueClaim, ports: QueueDrainPorts): Promise<DrainSummary> {
	const summary: DrainSummary = { applied: 0, routedNotes: [] };
	let finished = false;
	const finish = (consume: boolean): void => {
		if (finished) return;
		finished = true;
		try {
			if (consume) settleClaim(cap.d.agentDir, claim);
			else releaseClaim(cap.d.agentDir, claim);
		} catch {
			/* settle/release itself failed — leave the diagnosable claim
			 * for the stale-recovery protocol; never leak a rejected promise */
		}
	};
	try {
		// B4: persist the attempt BEFORE the call — a SIGKILL mid-call counts
		if (!bumpClaimedAttempts(cap.d.agentDir, claim)) {
			ports.blacklistAdd(`${claim.original}|${claim.record.sessionId}`);
			finish(false);
			return summary;
		}
		let completion: OpsCompletion;
		try {
			completion = await ports.complete(cap, claim.record.parts);
		} catch {
			finish(false); // infra failure — released, retry next session
			return summary;
		}
		if (completion.ok) {
			if (completion.ops.length > 0) {
				const routedNotes: string[] = [];
				const apply = ports.applyOps ?? ((ops, c, notes) => applyOpsOutcome(ops, c.d, c.projectKey, notes));
				let outcome: OpsOutcome;
				try {
					outcome = apply(completion.ops as MemoryOp[], cap, routedNotes);
				} catch (err) {
					summary.lastError = `flush-queued: apply threw: ${err instanceof Error ? err.message : String(err)}`;
					finish(false);
					return summary;
				}
				summary.applied = outcome.applied;
				summary.routedNotes = routedNotes;
				summary.lastFlush = `flush-queued: ${outcome.applied} op(s)`;
				if (outcome.error) {
					// B2 apply-fatal: deterministic — retrying cannot fix it
					finish(true);
					summary.lastError = `flush-queued: ${outcome.error}`;
					return summary;
				}
			}
			finish(true); // ok (incl. zero ops = confirmed nothing salvageable)
		} else if (claim.record.attempts >= QUEUE_MAX_ATTEMPTS) {
			finish(true);
			summary.lastError = `flush-queued: dropped after ${claim.record.attempts} attempts (${completion.reason ?? "failed"})`;
		} else {
			finish(false); // attempts left — retry next session
		}
	} finally {
		finish(false);
	}
	return summary;
}

/** Claim-first validation on the RE-READ record (routing, blacklist,
 *  attempt cap, age). Settle-with-diagnostic, skip, or eligible. */
function validateClaimed(cap: DrainCap, claim: QueueClaim, ports: QueueDrainPorts): { drop?: string; skip?: boolean } {
	if (ports.blacklistHas(`${claim.original}|${claim.record.sessionId}`)) return { skip: true };
	// B1 routing: exact projectsDir match (projectKey substring heuristics
	// can cross-project collide).
	if (claim.record.projectsDir !== cap.d.projectsDir) return { skip: true };
	if (claim.record.attempts >= QUEUE_MAX_ATTEMPTS) {
		return { drop: `flush-queued: dropped after ${claim.record.attempts} attempts` };
	}
	if (Date.now() - claim.record.savedAt > QUEUE_MAX_AGE_MS || claim.record.parts.length === 0) {
		return { drop: "flush-queued: expired record" };
	}
	return {};
}

export interface DrainResult {
	/** Per-record summaries in record order (empty when nothing drained). */
	summaries: DrainSummary[];
	/** Settle-with-diagnostic messages from the validation pass. */
	drops: string[];
}

/** The full drain pass for one captured cap. Never writes shared state —
 *  returns the summaries; the caller aggregates diagnostics. */
export async function drainQueue(cap: DrainCap, ports: QueueDrainPorts): Promise<DrainResult> {
	let processed = 0;
	const eligible: QueueClaim[] = [];
	const drops: string[] = [];
	// P0-3 §4.3: dead-claim recovery first. Recovered claims are ALREADY
	// ours (the reclaim rename took ownership) — they go straight into
	// validation; re-claiming them would nest suffixes (§3 name grammar).
	const recovered = reclaimStaleClaims(cap.d.agentDir, Date.now());
	const candidates = loadQueue(cap.d.agentDir).map((c) => c.file);
	for (const claim of [
		...candidates.map((file) => claimRecord(cap.d.agentDir, { file })),
		...recovered,
	]) {
		if (processed >= QUEUE_DRAIN_MAX) break;
		if (!claim) continue; // held by another worker / vanished — skip
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
		processed++; // QUEUE_DRAIN_MAX counts only records that reach the LLM lane
		eligible.push(claim);
	}
	if (eligible.length === 0) return { summaries: [], drops };
	// ≤5 records × 20s in PARALLEL (worst case max(20s), not 5×20s serial).
	const settled = await Promise.allSettled(eligible.map((claim) => drainOneRecord(cap, claim, ports)));
	const summaries: DrainSummary[] = [];
	for (const outcome of settled) {
		summaries.push(outcome.status === "fulfilled" ? outcome.value : { applied: 0, routedNotes: [] });
	}
	return { summaries, drops };
}
