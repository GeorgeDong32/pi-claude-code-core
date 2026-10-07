/**
 * memory/queue.ts — the pending-extraction queue (spec 2026-10-03-memory-exit-flush;
 * ownership protocol SPEC 2026-10-07 P0-3).
 *
 * The shutdown path must never run an LLM call (the measured root cause of
 * the ~10s exit stall: the host awaits every session_shutdown handler
 * serially with no host-side timeout). Instead of the old awaited flush,
 * the shutdown handler stages the unextracted conversation tail as ONE
 * JSON record here; the NEXT session_start for the same project drains it
 * in the background through the usual ops lane.
 *
 * Disk layout (P0-CT-09 registered; ready shape + record v1 FROZEN):
 *   ready    ~/.pi/agent/memory-queue/<sessionId[:8]>-<epoch-ms>.json
 *              { v, sessionId, projectsDir, projectKey, cwd, savedAt, attempts, parts }
 *   claim    <ready>.claim.<pid>.<claimedAtMs>.<nonce>   (held by one worker)
 *   pending  <ready>.pending.<nonce>                     (retryable, same as ready)
 *   gc token <name>.gc.<pid>.<claimedAtMs>.<nonce>.tmp   (legacy-tmp recovery carrier)
 *
 * Ownership protocol (P0-3 §4): every transition is ONE same-directory
 * rename consuming a unique source path — ready/pending → claim, dead claim
 * → reclaimer's claim, claim → fresh pending. Nonces are fresh UUIDs; no
 * path is ever reused and no suffix is nested. Hard links are FORBIDDEN
 * (review R1: link-then-unlink leaves a double-name window where two live
 * workers both hold the record). After claiming, ALWAYS re-read the record
 * from the claim file — never trust the enumeration's cached copy.
 *
 * This is a best-effort retry queue, NOT an exactly-once store: a crash
 * between apply and settle can re-apply on the next drain (disclosed;
 * fixing that window needs a persistent idempotency token, separate spec).
 * Mixed old/new core versions running side by side are NOT safe — drain
 * and stage under one protocol generation only.
 *
 * Records are a plaintext second copy of the session tail (global dir,
 * ≤7 days old, ≤2MB soft budget — claims/tmp count toward the bytes but
 * are never GC-deleted while their owner may live) — disclosed in /memory
 * diagnostics. All writes are atomic (tmp + rename in the same directory);
 * a SIGKILL can only leave .tmp orphans, which readers ignore and the
 * owner-checked GC reaps via a GC token.
 */

import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import type { ConversationPart } from "./automation.ts";

export const QUEUE_V = 1;

/** Records older than this are expired, not drained. */
export const QUEUE_MAX_AGE_MS = 7 * 24 * 3600_000;
/** Whole-directory byte budget; oldest files are evicted past it. */
export const QUEUE_DIR_MAX_BYTES = 2 * 1024 * 1024;
/** One record carries at most the last 60 parts × 2000 chars each. */
export const QUEUE_MAX_PARTS = 60;
export const QUEUE_PART_CHAR_CAP = 2000;
/** A claim younger than this is never reclaimed, whatever the probe says. */
export const QUEUE_CLAIM_TTL_MS = 10 * 60_000;

export interface QueueRecord {
	v: number;
	/** Full session id — the merge key (exact field match, NEVER the
	 * filename prefix: uuidv7's first 8 hex chars span ~65s of wall clock
	 * and collide across sessions). */
	sessionId: string;
	/** Routing key: `resolveMemoryPaths().projectsDir` of the session that
	 * staged the record. Drain only consumes exact matches. */
	projectsDir: string;
	/** Project key for the ops prompt guidance (diagnostic only). */
	projectKey?: string;
	cwd: string;
	savedAt: number;
	attempts: number;
	parts: ConversationPart[];
}

export interface StagedRecord {
	/** Filename within the queue dir (basename only). */
	file: string;
	record: QueueRecord;
}

/** A candidate from enumeration: `record` is null for unparsable files —
 * the CLAIM HOLDER settles those; enumeration itself never deletes. */
export interface QueueCandidate {
	file: string;
	record: QueueRecord | null;
}

/** Ownership token — minted only by a successful claim/reclaim. Carries the
 * current basename, the original ready basename and the owning pid. Paths
 * NEVER come from record contents. */
export interface QueueClaim {
	/** Current full basename (the claim name). */
	current: string;
	/** The original ready basename this record was first staged under. */
	original: string;
	/** Owning pid (from the claim name). */
	ownerPid: number;
	/** In-memory record re-read from the claim file at claim time. */
	record: QueueRecord;
}

/** Owner-aliveness verdict for stale-claim recovery (P0-3 Q2). */
export type OwnerProbe = (pid: number) => "dead" | "alive" | "unknown";

/** Default owner probe: signal-0 liveness. ESRCH = dead; EPERM = alive
 * (exists, no permission); anything else = unknown. A TTL that elapsed is
 * NOT sufficient by itself — the probe must confirm the owner is gone. */
export function signalOwnerProbe(pid: number): "dead" | "alive" | "unknown" {
	try {
		process.kill(pid, 0);
		return "alive";
	} catch (err) {
		const code = (err as { code?: string }).code;
		if (code === "ESRCH") return "dead";
		if (code === "EPERM") return "alive";
		return "unknown";
	}
}

export function queueDir(agentDir: string): string {
	return join(agentDir, "memory-queue");
}

/** Suffix-60 clamp (A2): the LAST parts are the unextracted tail — taking
 * the first 60 would silently drop the newest window. */
export function clampQueueParts(parts: ConversationPart[]): ConversationPart[] {
	return parts.slice(-QUEUE_MAX_PARTS).map((p) => ({
		role: p.role,
		text: p.text.length > QUEUE_PART_CHAR_CAP ? `${p.text.slice(0, QUEUE_PART_CHAR_CAP)}…` : p.text,
	}));
}

// ---- name grammar ----------------------------------------------------------

const CLAIM_RE = /^(.+)\.claim\.(\d+)\.(\d+)[.]([0-9a-f-]{36})$/;
const PENDING_RE = /^(.+)\.pending[.]([0-9a-f-]{36})$/;
const GC_TOKEN_RE = /^.+\.gc\.\d+\.\d+[.]([0-9a-f-]{36})\.tmp$/;
const WRITE_TMP_RE = /^(.+)\.(\d+)\.tmp$/;
const READY_RE = /^(\S+)-(\d+)\.json$/;

interface Classified {
	ready: string[];
	pending: string[];
	claims: { file: string; original: string; pid: number; claimedAt: number }[];
	gcTokens: { file: string; pid: number; claimedAt: number }[];
	writeTmps: { file: string; pid: number }[];
	others: string[];
}

function classifyQueueFiles(dir: string): Classified {
	const out: Classified = { ready: [], pending: [], claims: [], gcTokens: [], writeTmps: [], others: [] };
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch {
		return out; // missing dir / unreadable — treated as empty
	}
	for (const f of names.sort()) {
		if (f.endsWith(".json")) {
			out.ready.push(f);
			continue;
		}
		const gc = GC_TOKEN_RE.exec(f);
		if (gc) {
			const parts = f.split(".gc.")[1]!.split(".");
			out.gcTokens.push({ file: f, pid: Number(parts[0]), claimedAt: Number(parts[1]) });
			continue;
		}
		const claim = CLAIM_RE.exec(f);
		if (claim) {
			out.claims.push({ file: f, original: claim[1]!, pid: Number(claim[2]), claimedAt: Number(claim[3]) });
			continue;
		}
		const pending = PENDING_RE.exec(f);
		if (pending) {
			out.pending.push(f);
			continue;
		}
		const tmp = WRITE_TMP_RE.exec(f);
		if (tmp) {
			out.writeTmps.push({ file: f, pid: Number(tmp[2]) });
			continue;
		}
		out.others.push(f);
	}
	return out;
}

/** savedAt parsed from the ORIGINAL basename (`<prefix>-<epoch>.json`),
 * never from a claim timestamp. */
function savedAtOfOriginal(original: string): number | undefined {
	const m = READY_RE.exec(original);
	const n = m ? Number(m[2]) : Number.NaN;
	return Number.isFinite(n) && n > 0 ? n : undefined;
}

function readRecord(dir: string, file: string): QueueRecord | null {
	try {
		const parsed = JSON.parse(readFileSync(join(dir, file), "utf-8")) as QueueRecord;
		if (typeof parsed !== "object" || parsed === null || typeof parsed.sessionId !== "string" || !Array.isArray(parsed.parts)) return null;
		return parsed;
	} catch {
		return null;
	}
}

function removeQuiet(dir: string, file: string): void {
	try {
		unlinkSync(join(dir, file));
	} catch {
		/* absent / unwritable — the size GC and age cap eventually reap */
	}
}

function atomicWrite(dir: string, file: string, text: string): void {
	const tmp = join(dir, `${file}.${process.pid}.tmp`);
	writeFileSync(tmp, text);
	renameSync(tmp, join(dir, file));
}

/** One same-directory rename consuming the source path; false on ENOENT
 * (someone else consumed it first). Any other throw propagates to the
 * caller's fail-open handling. */
function tryRename(dir: string, from: string, to: string): boolean {
	try {
		renameSync(join(dir, from), join(dir, to));
		return true;
	} catch (err) {
		if ((err as { code?: string }).code === "ENOENT") return false;
		throw err;
	}
}

// ---- ownership primitives (P0-3 §4) ----------------------------------------

/** Claim a ready or pending candidate: ONE rename to a brand-new claim
 * name. Returns null when the source vanished (already claimed/settled by
 * someone else). On success the record is RE-READ from the claim file —
 * never the enumeration's copy. */
export function claimRecord(agentDir: string, candidate: { file: string }): QueueClaim | null {
	return claimFile(queueDir(agentDir), candidate.file);
}

/** Dir-based claim core (shared by the public API and the GC). */
function claimFile(dir: string, file: string): QueueClaim | null {
	const original = PENDING_RE.exec(file)?.[1] ?? file;
	const current = `${original}.claim.${process.pid}.${Date.now()}.${randomUUID()}`;
	if (!tryRename(dir, file, current)) return null;
	const record = readRecord(dir, current);
	if (record === null) {
		// unparsable even under our lock — the holder settles it
		removeQuiet(dir, current);
		return null;
	}
	return { current, original, ownerPid: process.pid, record };
}

/** Owner-only attempt bump BEFORE the LLM call, so a SIGKILL mid-call still
 * counts. Atomic write onto the claim file; updates the token's in-memory
 * copy on success. False when the write failed OR the token's owner is not
 * this process (a lost/reclaimed token must not keep bumping). */
export function bumpClaimedAttempts(agentDir: string, claim: QueueClaim): boolean {
	if (claim.ownerPid !== process.pid) return false;
	const dir = queueDir(agentDir);
	const next = { ...claim.record, attempts: claim.record.attempts + 1 };
	try {
		atomicWrite(dir, claim.current, JSON.stringify(next));
		claim.record = next;
		return true;
	} catch {
		return false;
	}
}

/** Consume the record: delete exactly THIS token's claim file. Never touches
 * any ready/pending file sharing the original basename. Idempotent. */
export function settleClaim(agentDir: string, claim: QueueClaim): void {
	settleFile(queueDir(agentDir), claim.current);
}

function settleFile(dir: string, current: string): void {
	removeQuiet(dir, current);
}

/** Relinquish for retry: ONE rename to a brand-new pending name. No link,
 * no restoring the old ready name. After success the caller has lost
 * ownership and MUST NOT bump/apply/settle this token again. False when the
 * claim is gone (settled/reclaimed elsewhere). */
export function releaseClaim(agentDir: string, claim: QueueClaim): boolean {
	const dir = queueDir(agentDir);
	const pending = `${claim.original}.pending.${randomUUID()}`;
	return tryRename(dir, claim.current, pending);
}

/** Recover claims whose owner is provably gone: TTL elapsed AND the owner
 * probe says dead. Each recovered claim is renamed (single rename) to the
 * RECLAIMER's brand-new claim — the reclaimer owns it from here. alive /
 * EPERM / unknown owners are skipped; losing a rename race returns nothing
 * for that candidate. TTL alone NEVER strips a live worker's ownership. */
export function reclaimStaleClaims(
	agentDir: string,
	now: number,
	ownerProbe: OwnerProbe = signalOwnerProbe,
): QueueClaim[] {
	const dir = queueDir(agentDir);
	const out: QueueClaim[] = [];
	for (const c of classifyQueueFiles(dir).claims) {
		if (now - c.claimedAt < QUEUE_CLAIM_TTL_MS) continue;
		if (c.pid === process.pid) continue; // our own — finally blocks settle it
		if (ownerProbe(c.pid) !== "dead") continue;
		const current = `${c.original}.claim.${process.pid}.${now}.${randomUUID()}`;
		if (!tryRename(dir, c.file, current)) continue; // second reclaimer won
		const record = readRecord(dir, current);
		if (record === null) {
			removeQuiet(dir, current);
			continue;
		}
		out.push({ current, original: c.original, ownerPid: process.pid, record });
	}
	return out;
}

// ---- staging / enumeration / inventory -------------------------------------

/** Stage one record; same-session records are replaced (exact sessionId
 * match — the new tail always ⊇ the old one after the suffix-60 clamp, so
 * replacing is lossless). Replacement targets ONLY ready/pending files:
 * each is claimed first (taking it out of every other worker's view), then
 * re-verified by full sessionId AND earlier savedAt before settlement —
 * a concurrent newer staging or a live worker's claim is never touched. */
export function writeQueueRecord(agentDir: string, record: QueueRecord): void {
	const dir = queueDir(agentDir);
	mkdirSync(dir, { recursive: true });
	const existing = classifyQueueFiles(dir);
	for (const f of [...existing.ready, ...existing.pending]) {
		const claim = claimFile(dir, f);
		if (!claim) continue; // a worker took it — leave it alone
		if (claim.record.sessionId === record.sessionId && claim.record.savedAt <= record.savedAt) {
			settleFile(dir, claim.current);
		} else {
			// mismatch (newer/concurrent staging) — back to retryable pending
			tryRename(dir, claim.current, `${claim.original}.pending.${randomUUID()}`);
		}
	}
	const name = `${record.sessionId.slice(0, 8)}-${record.savedAt}.json`;
	atomicWrite(dir, name, JSON.stringify(record));
	enforceBudget(dir, { sacrificial: name, record });
}

/** Enumerate drain candidates (ready + pending, oldest first). This is
 * CANDIDATE enumeration only: it never deletes anything — corrupted,
 * expired or over-attempt files are settled by whoever claims them.
 * Ordering key is the ORIGINAL basename's savedAt (never a claim time). */
export function loadQueue(agentDir: string): QueueCandidate[] {
	const dir = queueDir(agentDir);
	const c = classifyQueueFiles(dir);
	const out: QueueCandidate[] = [];
	for (const f of [...c.ready, ...c.pending]) {
		out.push({ file: f, record: readRecord(dir, f) });
	}
	out.sort((a, b) => (savedAtOfOriginal(originalOf(a.file)) ?? 0) - (savedAtOfOriginal(originalOf(b.file)) ?? 0));
	enforceBudget(dir);
	return out;
}

function originalOf(file: string): string {
	return PENDING_RE.exec(file)?.[1] ?? CLAIM_RE.exec(file)?.[1] ?? file;
}

/** Read-only inventory for the /memory panel: record count + bytes + oldest
 * age (no JSON parsing — the panel must stay cheap). Counts ready + pending
 * + claim files as records; claim/GC-token/write-tmp bytes count toward the
 * total, GC tokens and tmps never count as records or toward oldestSavedAt.
 * Null when the queue dir does not exist yet. Enumeration may be briefly
 * stale under concurrent transitions — display and soft-budget only, never
 * an authorization to delete. */
export function queueInventory(agentDir: string): { records: number; bytes: number; oldestSavedAt?: number } | null {
	try {
		const dir = queueDir(agentDir);
		const c = classifyQueueFiles(dir);
		const recordFiles = [...c.ready, ...c.pending, ...c.claims.map((x) => x.file)];
		if (recordFiles.length === 0 && c.gcTokens.length === 0 && c.writeTmps.length === 0 && c.others.length === 0) {
			try {
				readdirSync(dir);
			} catch {
				return null;
			}
		}
		let bytes = 0;
		let oldest: number | undefined;
		for (const f of recordFiles) {
			try {
				bytes += statSync(join(dir, f)).size;
			} catch {
				continue;
			}
			const savedAt = savedAtOfOriginal(originalOf(f));
			if (savedAt && savedAt > 0 && (oldest === undefined || savedAt < oldest)) oldest = savedAt;
		}
		for (const f of [...c.gcTokens.map((x) => x.file), ...c.writeTmps.map((x) => x.file), ...c.others]) {
			try {
				bytes += statSync(join(dir, f)).size;
			} catch {
				/* raced away */
			}
		}
		return { records: recordFiles.length, bytes, oldestSavedAt: oldest };
	} catch {
		return null;
	}
}

// ---- GC (P0-3 §4.2) ---------------------------------------------------------

/** Cap the directory at QUEUE_DIR_MAX_BYTES. ready/pending are evicted
 * oldest-savedAt-first, each through claim → re-verify → settle (a live
 * worker's claim is never deleted; an already-claimed candidate is
 * protected). Stale dead-owner claims/tmps are recovered through their own
 * token protocol. The budget is SOFT: concurrent staging and live claims
 * may push it over temporarily. */
function enforceBudget(
	dir: string,
	sacrifice?: { sacrificial: string; record: QueueRecord },
): void {
	try {
		const c = classifyQueueFiles(dir);
		type Item = { f: string; size: number; savedAt: number };
		const items: Item[] = [];
		for (const x of [...c.ready, ...c.pending]) {
			try {
				const st = statSync(join(dir, x));
				items.push({ f: x, size: st.size, savedAt: savedAtOfOriginal(originalOf(x)) ?? 0 });
			} catch {
				/* raced away */
			}
		}
		let total = items.reduce((acc, x) => acc + x.size, 0);
		for (const x of [...c.claims, ...c.gcTokens, ...c.writeTmps, ...c.others.map((f) => ({ file: f }))]) {
			try {
				total += statSync(join(dir, (x as { file: string }).file)).size;
			} catch {
				/* raced away */
			}
		}
		if (total > QUEUE_DIR_MAX_BYTES) {
			items.sort((a, b) => a.savedAt - b.savedAt);
			for (const x of items) {
				if (total <= QUEUE_DIR_MAX_BYTES) break;
				const claim = claimFile(dir, x.f);
				if (!claim) continue; // taken by a worker — protected
				total -= x.size;
				settleFile(dir, claim.current);
			}
		}
		reapLegacyTmps(dir);
		// still over budget with only protected/unclaimable data: the NEW
		// staging may drop ITSELF (never anyone else's in-flight record).
		if (sacrifice && totalStillOver(dir)) {
			const claim = claimFile(dir, sacrifice.sacrificial);
			if (claim && claim.record.sessionId === sacrifice.record.sessionId && claim.record.savedAt === sacrifice.record.savedAt) {
				settleFile(dir, claim.current);
				console.warn("[memory-queue] over soft budget after GC — dropped the just-staged record");
			}
		}
	} catch {
		/* never let GC break the queue */
	}
}

function totalStillOver(dir: string): boolean {
	try {
		let total = 0;
		for (const f of readdirSync(dir)) {
			try {
				total += statSync(join(dir, f)).size;
			} catch {
				/* raced */
			}
		}
		return total > QUEUE_DIR_MAX_BYTES;
	} catch {
		return false;
	}
}

/** Recover recognizable legacy write-tmps (.tmp with an owning pid) whose
 * owner is provably dead and past the TTL: rename (single) into the
 * reclaimer's GC token, then delete. Live/unknown owners keep their tmp;
 * GC tokens themselves follow the same re-claim-before-delete rule so a
 * reclaimer crashing after its rename leaves a recoverable token, never a
 * permanent leak. Unknown dir entries are LEFT ALONE (diagnosed by
 * inventory), never guessed at. */
function reapLegacyTmps(dir: string, now = Date.now(), ownerProbe: OwnerProbe = signalOwnerProbe): void {
	const c = classifyQueueFiles(dir);
	const legacy: Array<{ file: string; pid: number; claimedAt?: number }> = [
		...c.writeTmps.map((x) => ({ file: x.file, pid: x.pid })),
		...c.gcTokens.map((x) => ({ file: x.file, pid: x.pid, claimedAt: x.claimedAt })),
	];
	for (const t of legacy) {
		if (t.pid === process.pid) continue; // our own in-flight write
		const stale = t.claimedAt !== undefined
			? now - t.claimedAt >= QUEUE_CLAIM_TTL_MS
			: tmpIsStale(dir, t.file, now);
		if (!stale) continue;
		if (ownerProbe(t.pid) !== "dead") continue;
		const token = `gc-${randomUUID()}.gc.${process.pid}.${now}.${randomUUID()}.tmp`;
		if (!tryRename(dir, t.file, token)) continue; // second reclaimer won
		removeQuiet(dir, token);
	}
}

function tmpIsStale(dir: string, file: string, now: number): boolean {
	try {
		return now - statSync(join(dir, file)).mtimeMs >= QUEUE_CLAIM_TTL_MS;
	} catch {
		return false;
	}
}
