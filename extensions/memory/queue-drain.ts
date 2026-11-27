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
