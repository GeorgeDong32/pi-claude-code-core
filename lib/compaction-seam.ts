/*
 * Compaction seam (SPEC SC §5.9, task W5) — the boundary-draft notification
 * point for in-package subscribers.
 *
 * Why it exists (H3/H11): a compaction committed via boundary draft does NOT
 * emit `session_compact`/`session_before_compact`, so goal/modes/memory's
 * existing pi hooks never fire on that path. The seam mirrors those hooks:
 *
 *   before = proposal INTENT  — fired synchronously just before the draft is
 *             returned (no entryId yet; the proposal may still be lost).
 *   after  = confirmed COMMIT — fired only after reconciliation (APP-08)
 *             found the proposal's nonce on the branch, carrying the real
 *             entryId. Deduplicated by entryId: exactly once per commit.
 *
 * Subscribers must tolerate "before without after" (a lost proposal is a
 * normal outcome, equivalent to a native session_before_compact that later
 * gets cancelled — H11). This module is deliberately self-contained (SM-01):
 * synchronous, no pi imports, no lib peers — subscriber exceptions are
 * isolated per-callback and never propagate to the caller.
 *
 * Package-internal surface: NOT a contract (test/contracts/README.md note);
 * covered by test/lib/compaction-seam.test.ts.
 */

export type CompactionOrigin = "boundary-draft";

export interface CompactionSeamInfo {
	origin: CompactionOrigin;
	/** Real session entry id — present on `after` only. */
	entryId?: string;
	/** True when the commit happened mid-run (turn_end inside a live run). */
	midRun: boolean;
	tokensBefore?: number;
	summaryChars: number;
}

export interface CompactionSubscriber {
	before?: (info: CompactionSeamInfo) => void;
	after?: (info: CompactionSeamInfo) => void;
}

interface RegisteredSubscriber {
	id: number;
	subscriber: CompactionSubscriber;
}

let nextSubscriberId = 1;
let subscribers: RegisteredSubscriber[] = [];
const deliveredAfterEntryIds = new Set<string>();

/** Register a subscriber; returns an unregister function. */
export function registerCompactionSubscriber(subscriber: CompactionSubscriber): () => void {
	const entry: RegisteredSubscriber = { id: nextSubscriberId++, subscriber };
	subscribers.push(entry);
	return () => {
		subscribers = subscribers.filter((candidate) => candidate.id !== entry.id);
	};
}

/** Fire `before` (proposal intent). Synchronous; exceptions isolated. */
export function notifyBefore(info: CompactionSeamInfo): void {
	for (const { subscriber } of subscribers) {
		try {
			subscriber.before?.(info);
		} catch {
			// SM-01: one subscriber's bug must not break the draft return path.
		}
	}
}

/**
 * Fire `after` (confirmed commit). Deduplicated by entryId (APP-05 exactly
 * once); a missing entryId always delivers (defensive — reconciliation
 * supplies it in every real path).
 */
export function notifyAfter(info: CompactionSeamInfo): void {
	if (info.entryId !== undefined) {
		if (deliveredAfterEntryIds.has(info.entryId)) return;
		deliveredAfterEntryIds.add(info.entryId);
	}
	for (const { subscriber } of subscribers) {
		try {
			subscriber.after?.(info);
		} catch {
			// SM-01: isolated, same as before.
		}
	}
}

/** Test seam: drop every subscriber and the delivery ledger. */
export function resetCompactionSeam(): void {
	subscribers = [];
	deliveredAfterEntryIds.clear();
}
