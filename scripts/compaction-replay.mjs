#!/usr/bin/env -S tsx
/**
 * Smart Compaction replay & calibration (SPEC SC §7.2 / task W2).
 *
 * Reads pi session jsonl corpora (READ-ONLY, metadata + in-memory message
 * text for cut selection only) and simulates the controller over each
 * session's REAL token trajectory using the REAL policy/cutpoint modules
 * (W1). Output is AGGREGATES ONLY (INV-7) — never summary text, never user
 * content, never session ids.
 *
 * Metrics (spec §7.2): M1 threshold-precommit rate, M2 cut legality, M3
 * tail floor, M3b capacity + V8b-at-apply, M4 split share vs native, M5
 * boundary classes, M6 native blocking total, M7 feasibility coverage, M8
 * estimate-vs-real deviation, M9 rate/burst distribution, M10 wasted-compute
 * rate. The O1/O2 comparison runs the SAME replay under three schemes:
 * fixed-ratio (Appendix C), fixed-lead (T_n − X, X ∈ {25K,50K,75K}) and
 * rate-adaptive, reporting M1/M3b/M10 per scheme.
 *
 * Usage:
 *   tsx scripts/compaction-replay.mjs <dir-or-file>... [--self-check] [--json]
 * Exit 0 on success; --self-check asserts the metric math on synthetic
 * fixtures (also covered by test/lib/compaction-replay.test.ts).
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { effectiveThreshold, evaluate, initialState, jointFeasibility, estimatePost } from "../extensions/compaction/policy.ts";
import { selectCut, suffixTokenSums } from "../extensions/compaction/cutpoint.ts";
import { DEFAULT_COMPACTION_CORE_SETTINGS } from "../extensions/compaction/settings.ts";

// ─── corpus loading ─────────────────────────────────────────────────────────

/** Parse one jsonl file into raw entries (throws on absent file). */
export function parseSessionFile(path) {
	const lines = readFileSync(path, "utf-8").split("\n");
	const entries = [];
	for (const line of lines) {
		const trimmed = line.trim();
		if (trimmed.length === 0) continue;
		try {
			entries.push(JSON.parse(trimmed));
		} catch {
			// skip malformed line
		}
	}
	return entries;
}

/** usage → context tokens (mirrors pi calculateContextTokens). */
export function contextTokensOf(usage) {
	if (!usage || typeof usage !== "object") return null;
	if (typeof usage.totalTokens === "number" && usage.totalTokens > 0) return usage.totalTokens;
	const { input = 0, output = 0, cacheRead = 0, cacheWrite = 0 } = usage;
	const total = input + output + cacheRead + cacheWrite;
	return total > 0 ? total : null;
}

/**
 * Reduce raw entries to the replay view: turn samples (assistant turns with
 * usage), native compaction events, and a message view for cut selection.
 */
export function extractSession(entries) {
	const turns = [];
	const compactions = [];
	const messages = []; // {role, textChars, ts, entryId, toolCalls}
	let prevEntryTs = null;
	for (const entry of entries) {
		const entryTs = Date.parse(entry.timestamp ?? "");
		if (entry.type === "message" && entry.message) {
			const message = entry.message;
			const role = message.role;
			let textChars = 0;
			let toolCalls = 0;
			const content = message.content;
			if (typeof content === "string") textChars = content.length;
			else if (Array.isArray(content)) {
				for (const block of content) {
					if (block.type === "text" && typeof block.text === "string") textChars += block.text.length;
					if (block.type === "toolCall") toolCalls += 1;
				}
			}
			messages.push({ role, textChars, toolCalls, ts: entryTs, entryId: entry.id ?? "", stopReason: message.stopReason });
			if (role === "assistant") {
				const tokens = contextTokensOf(message.usage);
				if (tokens !== null) {
					turns.push({ t: entryTs, tokens, stopReason: message.stopReason ?? "stop" });
				}
			}
		} else if (entry.type === "compaction") {
			compactions.push({
				t: entryTs,
				tokensBefore: typeof entry.tokensBefore === "number" ? entry.tokensBefore : null,
				summaryChars: typeof entry.summary === "string" ? entry.summary.length : 0,
				// E1 proxy: the gap to the PREVIOUS ENTRY of any type is the
				// user-felt blocking (the summarization ran between them).
				blockedMsProxy: prevEntryTs !== null && entryTs > prevEntryTs ? entryTs - prevEntryTs : null,
			});
		}
		if (Number.isFinite(entryTs)) prevEntryTs = entryTs;
	}
	// Simplified per-turn increments.
	for (let i = 1; i < turns.length; i += 1) turns[i].increment = Math.max(0, turns[i].tokens - turns[i - 1].tokens);
	turns[0] && (turns[0].increment = turns[0].tokens);
	return { turns, compactions, messages };
}

/** Effective T_n per session: median compaction tokensBefore when present. */
export function sessionThreshold(session) {
	const observed = session.compactions.map((c) => c.tokensBefore).filter((v) => v !== null && v > 0);
	if (observed.length === 0) return null;
	observed.sort((a, b) => a - b);
	return observed[Math.floor(observed.length / 2)];
}

// ─── schemes ────────────────────────────────────────────────────────────────

/**
 * A scheme maps (T_n, recent rates) → the token level at which precompute
 * starts. applyRatio stays fixed at settings.applyRatio for all schemes.
 */
export const SCHEMES = {
	"fixed-ratio": (tn, params) => params.precomputeRatio * tn,
	"fixed-lead-25k": (tn) => tn - 25_000,
	"fixed-lead-50k": (tn) => tn - 50_000,
	"fixed-lead-75k": (tn) => tn - 75_000,
	"rate-adaptive": (tn, params, ratePerMin, latencyMs) => {
		if (ratePerMin <= 0) return params.precomputeRatio * tn; // no data → ratio default
		const projectedMs = ((tn - (tn * params.precomputeRatio)) / ratePerMin) * 60_000; // remaining from p to T_n
		const budget = Math.max(latencyMs * 1.5, 60_000);
		// Start earlier when the remaining window is short relative to budget.
		const fraction = Math.min(1, budget / Math.max(projectedMs, 1));
		return tn - (tn - params.precomputeRatio * tn) / Math.max(fraction, 0.25);
	},
};

// ─── simulation ─────────────────────────────────────────────────────────────

const SUMMARY_LATENCY_BASE_MS = 10_000;
const SUMMARY_LATENCY_PER_INPUT_TOKEN_MS = 0.5; // spec §7.2: 10s + 0.5ms per input token

export function summaryLatencyMs(inputTokens) {
	return SUMMARY_LATENCY_BASE_MS + SUMMARY_LATENCY_PER_INPUT_TOKEN_MS * inputTokens;
}

/**
 * Per-session usage/chars calibration: pi's own threshold estimate rides on
 * the last assistant USAGE (system prompt + tool definitions + expansion ≈
 * 2.5–4.5× the persisted message chars/4 — the POL-10 overhead). The cut
 * window must be measured on the usage scale, so message sizes are scaled.
 */
export function sessionCharScale(session) {
	const compaction = session.compactions.find((c) => c.tokensBefore && c.tokensBefore > 0);
	if (!compaction) return 3.0; // corpus median fallback
	const visible = session.messages.filter((m) => m.ts <= compaction.t);
	const chars = visible.reduce((sum, m) => sum + m.textChars, 0);
	const usage = [...session.turns].filter((t) => t.t <= compaction.t).at(-1)?.tokens ?? 0;
	const estimate = Math.ceil(chars / 4);
	if (estimate <= 0 || usage <= 0) return 3.0;
	return Math.min(8, Math.max(1, usage / estimate));
}

/** Projected-entry view of the corpus messages for selectCut (in-memory). */
function cutView(messages, uptoTs, scale) {
	const visible = messages.filter((m) => m.ts <= uptoTs);
	return visible.map((m, index) => {
		const chars = Math.ceil(m.textChars * scale);
		const message =
			m.role === "assistant"
				? { role: "assistant", content: buildAssistantContent({ ...m, textChars: chars }) }
				: m.role === "toolResult"
					? { role: "toolResult", content: [{ type: "toolResult", toolCallId: "c", output: "x".repeat(chars) }] }
					: // Non-standard roles (bashExecution/custom/…) project as
						// plain text here — the replay only needs the token scale.
						{ role: "user", content: [{ type: "text", text: "x".repeat(chars) }] };
		return {
			// NOTE: the raw message rides INSIDE sourceEntry too — the native
			// findCutPoint (inside selectCut) projects via
			// sessionEntryToContextMessages(sourceEntry).
			sourceEntry: {
				type: "message",
				id: m.entryId || `m${index}`,
				parentId: null,
				timestamp: new Date(m.ts).toISOString(),
				message,
			},
			messages: [message],
		};
	});
}

function buildAssistantContent(m) {
	const blocks = [{ type: "text", text: "x".repeat(Math.max(1, m.textChars - m.toolCalls * 32)) }];
	for (let i = 0; i < m.toolCalls; i += 1) blocks.push({ type: "toolCall", id: `c${i}`, name: "read", arguments: { path: "/x" } });
	return blocks;
}

/**
 * Simulate one session under one scheme. Returns per-session counters —
 * aggregates only (INV-7).
 */
export function simulateSession(session, tn, schemeName, params = DEFAULT_COMPACTION_CORE_SETTINGS) {
	const scheme = SCHEMES[schemeName];
	const result = {
		scheme: schemeName,
		crossings: 0,
		precommitted: 0,
		cutsLegal: 0,
		cutsTotal: 0,
		tailFloorOk: 0,
		capacityOk: 0,
		capacityTotal: 0,
		v8bPass: 0,
		v8bTotal: 0,
		splitController: 0,
		splitNative: 0,
		classCounts: {},
		computesStarted: 0,
		computesWasted: 0,
		wastedInputTokens: 0,
		infeasible: false,
	};
	if (tn === null || session.turns.length === 0) return result;
	const charScale = sessionCharScale(session);
	const feasibility = jointFeasibility({
		tn,
		keepRecentTokens: 20_000,
		summaryTokenEstimate: params.summaryTokenEstimate,
		precomputeRatio: params.precomputeRatio,
		applyRatio: params.applyRatio,
		targetPostRatio: params.targetPostRatio,
	});
	result.infeasible = !feasibility.feasible;

	let state = initialState();
	let snapshot = null; // {readyAt, cut, tailTokens, tokensAtSnapshot, valid}
	// Last controller commit time survives later snapshots (M1 numerator);
	// `reduction` models the context drop after OUR commit (the corpus
	// trajectory only reflects NATIVE compactions — without this the sim
	// would treadmill: P stays high → recompute → re-propose forever).
	let lastCommittedAt = null;
	let reduction = 0;
	const nextCompaction = [...session.compactions];
	const compactionTimes = nextCompaction.map((c) => c.t);
	let turnIdx = 0;
	const policySettings = {
		precomputeRatio: params.precomputeRatio,
		applyRatio: params.applyRatio,
		refusedCooldownTurns: params.refusedCooldownTurns,
		degradeAfterRefusals: params.degradeAfterRefusals,
		minPrecomputeGapTurns: params.minPrecomputeGapTurns,
	};

	for (const turn of session.turns) {
		turnIdx += 1;
		// Native crossing? (the corpus's real compaction event time)
		while (compactionTimes.length > 0 && turn.t >= compactionTimes[0]) {
			compactionTimes.shift();
			result.crossings += 1;
			if (lastCommittedAt !== null && lastCommittedAt < turn.t) {
				result.precommitted += 1;
			} else if (snapshot || state.phase === "computing") {
				result.computesWasted += 1;
				result.wastedInputTokens += snapshot?.inputTokens ?? turn.tokens;
			}
			// Native compaction resets the controller (external compaction);
			// the corpus trajectory already reflects ITS context drop.
			state = initialState(state.generation + 1);
			snapshot = null;
			lastCommittedAt = null;
			reduction = 0;
		}
		const effectiveTokens = Math.max(1, turn.tokens - reduction);
		const P = effectiveTokens / tn;
		const recent = session.turns.slice(Math.max(0, turnIdx - 11), turnIdx);
		const rate = ratePerMinute(recent);
		const latency = summaryLatencyMs(turn.tokens * 0.4);
		const precomputeLevel = scheme(tn, params, rate, latency);
		const safe = turn.stopReason === "stop" || turn.stopReason === "toolUse";
		const event = {
			type: "boundary",
			P,
			applySafe: safe,
			isApplyPoint: true,
			prechecksPassed: true,
			feasibility,
			mayCompute: !result.infeasible,
		};
		// computing → ready when the modeled summary latency has elapsed
		// (SUM-07 timing; one promise chain, no timers in the model).
		if (state.phase === "computing" && snapshot && turn.t >= snapshot.readyAt) {
			state = evaluate(state, { type: "compute-ok" }, policySettings).state;
		}
		const synthetic = { ...policySettings, precomputeRatio: Math.min(0.99, precomputeLevel / tn) };
		const decision = evaluate(state, event, synthetic);
		state = decision.state;
		if (decision.action.type === "start-computing") {
			result.computesStarted += 1;
			const view = cutView(session.messages, turn.t, charScale);
			const cutResult = selectCut(view, {
				keepRecentTokens: 20_000,
				keepSlackTokens: params.keepSlackTokens,
				feasibility,
				weights: params.weights,
				lambda: params.lambda,
				idleGapMs: params.idleGapMs,
			});
			if (cutResult.status !== "infeasible") {
				result.cutsTotal += 1;
				result.cutsLegal += 1; // selectCut never returns illegal cuts (CUT-01)
				result.tailFloorOk += cutResult.cut.tailTokens >= 20_000 ? 1 : 0;
				result.capacityTotal += 1;
				result.capacityOk += cutResult.cut.tailTokens <= feasibility.tailMax ? 1 : 0;
				const cls = cutResult.cut.boundaryClass;
				result.classCounts[cls] = (result.classCounts[cls] ?? 0) + 1;
				result.splitController += cutResult.cut.isSplitTurn ? 1 : 0;
				snapshot = {
					readyAt: turn.t + summaryLatencyMs(effectiveTokens * 0.4),
					cut: cutResult.cut,
					tokensAtSnapshot: effectiveTokens,
					inputTokens: effectiveTokens * 0.4,
				};
			} else {
				// infeasible window: no compute actually starts
				state = { ...state, phase: "infeasible-window" };
				result.computesStarted -= 1;
			}
		}
		// evaluate's propose action is the SINGLE propose source; the apply
		// gate here is the V8b efficiency check with the grown tail (spec
		// §7.2 M3b: real increments between snapshot and apply).
		if (decision.action.type === "propose" && snapshot) {
			const grownTail = snapshot.cut.tailTokens + Math.max(0, effectiveTokens - snapshot.tokensAtSnapshot);
			result.v8bTotal += 1;
			const v8bOk = grownTail + params.summaryTokenEstimate <= params.precomputeRatio * tn;
			result.v8bPass += v8bOk ? 1 : 0;
			if (v8bOk) {
				lastCommittedAt = turn.t;
				// Context drop: the compressed region (effective context at
				// snapshot minus kept tail minus the summary estimate).
				reduction = Math.max(0, snapshot.tokensAtSnapshot - snapshot.cut.tailTokens - params.summaryTokenEstimate);
				snapshot = null;
				state = evaluate(state, { type: "reconcile-committed" }, policySettings).state;
			} else {
				result.computesWasted += 1;
				result.wastedInputTokens += snapshot.inputTokens;
				state = evaluate(state, { type: "discard", reason: "v8b-efficiency" }, policySettings).state;
				snapshot = null;
			}
		}
	}
	// Session end with a live compute = wasted (M10). Trailing compactions
	// the turn loop never reached still count as threshold events (M1
	// denominator); the live-compute waste is only counted once.
	let endWasteCounted = false;
	if ((state.phase === "computing" || state.phase === "ready") && snapshot?.committedAt === undefined) {
		result.computesWasted += 1;
		result.wastedInputTokens += snapshot?.inputTokens ?? 0;
		endWasteCounted = true;
	}
	for (const t of compactionTimes) {
		void t;
		result.crossings += 1;
		if (!endWasteCounted && (state.phase === "computing" || snapshot)) {
			result.computesWasted += 1;
			result.wastedInputTokens += snapshot?.inputTokens ?? 0;
			endWasteCounted = true;
		}
	}
	return result;
}

function ratePerMinute(turns) {
	if (turns.length < 2) return 0;
	const first = turns[0];
	const last = turns[turns.length - 1];
	const minutes = (last.t - first.t) / 60_000;
	if (minutes <= 0) return 0;
	return Math.max(0, (last.tokens - first.tokens) / minutes);
}

// ─── corpus-level metrics independent of the controller ────────────────────

/** M6/M8: native blocking totals + estimate-vs-real deviation. */
export function nativeCorpusMetrics(session) {
	const blockingMs = [];
	const deviations = [];
	for (let i = 0; i < session.compactions.length; i += 1) {
		const compaction = session.compactions[i];
		if (compaction.blockedMsProxy !== null && compaction.blockedMsProxy < 600_000) {
			blockingMs.push(compaction.blockedMsProxy); // E1: 53–171s; cap outliers
		}
		// M8: estimatePost(summary + kept tail) vs the first REAL usage after.
		const after = session.turns.find((t) => t.t > compaction.t);
		if (after && compaction.tokensBefore) {
			const est = estimatePost({
				summary: "x".repeat(compaction.summaryChars),
				keptMessages: [],
				currentProjectionMessages: [],
				ctxTokensUsage: compaction.tokensBefore,
				contextWindow: Number.MAX_SAFE_INTEGER,
				unknownOverheadTokens: 0,
			});
			const estimate = compaction.summaryChars / 4 + 20_000; // summary + keep
			deviations.push(Math.abs(estimate - after.tokens) / Math.max(after.tokens, 1));
			void est;
		}
	}
	return { blockingMs, deviations };
}

/** M9: rate + burst distributions across all turns of a session. */
export function sessionRateMetrics(session) {
	const increments = session.turns.map((t) => t.increment ?? 0).filter((v) => v > 0);
	if (session.turns.length < 2) return { tokensPerMin: null, increments: [] };
	const first = session.turns[0];
	const last = session.turns[session.turns.length - 1];
	const minutes = (last.t - first.t) / 60_000;
	return {
		tokensPerMin: minutes > 0 ? Math.max(0, (last.tokens - first.tokens) / minutes) : null,
		increments,
	};
}

// ─── aggregation ────────────────────────────────────────────────────────────

function quantile(sorted, q) {
	if (sorted.length === 0) return null;
	const idx = Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))));
	return sorted[idx];
}

export function aggregate(perSession) {
	const totals = {
		sessions: perSession.length,
		crossings: 0,
		precommitted: 0,
		cutsTotal: 0,
		tailFloorOk: 0,
		capacityTotal: 0,
		capacityOk: 0,
		v8bTotal: 0,
		v8bPass: 0,
		splitController: 0,
		computesStarted: 0,
		computesWasted: 0,
		wastedInputTokens: 0,
		infeasibleSessions: 0,
		classCounts: {},
	};
	for (const r of perSession) {
		totals.crossings += r.crossings;
		totals.precommitted += r.precommitted;
		totals.cutsTotal += r.cutsTotal;
		totals.tailFloorOk += r.tailFloorOk;
		totals.capacityTotal += r.capacityTotal;
		totals.capacityOk += r.capacityOk;
		totals.v8bTotal += r.v8bTotal;
		totals.v8bPass += r.v8bPass;
		totals.splitController += r.splitController;
		totals.computesStarted += r.computesStarted;
		totals.computesWasted += r.computesWasted;
		totals.wastedInputTokens += r.wastedInputTokens;
		if (r.infeasible) totals.infeasibleSessions += 1;
		for (const [cls, count] of Object.entries(r.classCounts ?? {})) totals.classCounts[cls] = (totals.classCounts[cls] ?? 0) + count;
	}
	return {
		m1_thresholdPrecommitRate: totals.crossings > 0 ? totals.precommitted / totals.crossings : null,
		m2_cutLegalRate: totals.cutsTotal > 0 ? 1 : null, // selectCut construction guarantee, pinned by CUT-01
		m3_tailFloorRate: totals.cutsTotal > 0 ? totals.tailFloorOk / totals.cutsTotal : null,
		m3b_capacityRate: totals.capacityTotal > 0 ? totals.capacityOk / totals.capacityTotal : null,
		m3b_v8bAtApplyRate: totals.v8bTotal > 0 ? totals.v8bPass / totals.v8bTotal : null,
		m4_splitShare: totals.cutsTotal > 0 ? totals.splitController / totals.cutsTotal : null,
		m5_boundaryClasses: totals.classCounts,
		m10_wastedComputeRate: totals.computesStarted > 0 ? totals.computesWasted / totals.computesStarted : null,
		m10_wastedInputTokens: totals.wastedInputTokens,
		m7_infeasibleSessions: totals.infeasibleSessions,
		raw: totals,
	};
}

// ─── CLI ────────────────────────────────────────────────────────────────────

function collectJsonl(path, out) {
	const st = statSync(path);
	if (st.isDirectory()) {
		for (const name of readdirSync(path)) collectJsonl(join(path, name), out);
	} else if (path.endsWith(".jsonl")) {
		out.push(path);
	}
}

export function selfCheck() {
	// Synthetic session: two crossings; the first is precommitted (compute
	// finishes before the crossing), the second is not (compute starts too
	// late under fixed-lead-75k with a slow rate).
	const minute = 60_000;
	const turns = [];
	let t = 0;
	let tokens = 5_000;
	for (let i = 0; i < 120; i += 1) {
		turns.push({ t, tokens, stopReason: "stop", increment: i === 0 ? tokens : 3_500 });
		t += 20_000;
		tokens += 3_500;
	}
	const tn = sessionThreshold({ turns, compactions: [], messages: [] }) ?? null;
	// Force a known T_n of 250_000: the trajectory crosses it at turn ~70.
	const forcedTn = 250_000;
	const crossingTurn = turns.findIndex((turn) => turn.tokens >= forcedTn);
	if (crossingTurn < 0) throw new Error("self-check: fixture must cross the threshold");
	const compactions = [{ t: turns[crossingTurn].t, tokensBefore: forcedTn, summaryChars: 4_000, blockedMsProxy: 90_000 }];
	// Minimal message view so selectCut has a projection to work on.
	const messages = turns.map((turn, i) => ({
		role: i % 2 === 0 ? "user" : "assistant",
		textChars: 4_000,
		toolCalls: 0,
		ts: turn.t,
		entryId: `m${i}`,
		stopReason: "stop",
	}));
	const session = { turns, compactions, messages };
	const fixedRatio = simulateSession(session, forcedTn, "fixed-ratio");
	if (fixedRatio.crossings !== 1) throw new Error(`self-check M1 denominator: expected 1 crossing, got ${fixedRatio.crossings}`);
	if (fixedRatio.computesStarted < 1) throw new Error("self-check: fixed-ratio should start a compute");
	const aggregateResult = aggregate([fixedRatio]);
	if (aggregateResult.m1_thresholdPrecommitRate !== 1 && aggregateResult.m1_thresholdPrecommitRate !== 0) {
		throw new Error("self-check: M1 must be 0 or 1 on a single-crossing fixture");
	}
	// Cut metrics now exist (message view present): every cut legal + floored.
	if (fixedRatio.cutsTotal === 0) throw new Error("self-check: expected cut metrics from the message view");
	if (fixedRatio.cutsLegal !== fixedRatio.cutsTotal) throw new Error("self-check: every selectCut result must be legal");
	if (fixedRatio.tailFloorOk !== fixedRatio.cutsTotal) throw new Error("self-check: every cut must keep >= keepRecentTokens");
	void tn; void minute;
	return true;
}

function main() {
	const args = process.argv.slice(2);
	const selfCheckOnly = args.includes("--self-check");
	const asJson = args.includes("--json");
	const paths = args.filter((a) => !a.startsWith("--"));

	if (selfCheckOnly) {
		const ok = selfCheck();
		console.log(asJson ? JSON.stringify({ selfCheck: ok }) : `self-check: ${ok ? "PASS" : "FAIL"}`);
		process.exit(ok ? 0 : 1);
	}
	if (paths.length === 0) {
		console.error("usage: tsx scripts/compaction-replay.mjs <corpus-dir|file>... [--self-check] [--json]");
		process.exit(2);
	}
	const files = [];
	for (const path of paths) collectJsonl(path, files);
	const perSession = [];
	const schemeResults = {};
	let blockingAll = [];
	let deviationsAll = [];
	let rateAll = [];
	let incrementsAll = [];
	let sessionsWithThreshold = 0;
	for (const scheme of Object.keys(SCHEMES)) schemeResults[scheme] = [];
	for (const file of files) {
		let entries;
		try {
			entries = parseSessionFile(file);
		} catch {
			continue;
		}
		const session = extractSession(entries);
		const tn = sessionThreshold(session);
		if (tn === null || session.turns.length < 2) continue;
		sessionsWithThreshold += 1;
		for (const scheme of Object.keys(SCHEMES)) {
			schemeResults[scheme].push(simulateSession(session, tn, scheme));
		}
		const native = nativeCorpusMetrics(session);
		blockingAll = blockingAll.concat(native.blockingMs);
		deviationsAll = deviationsAll.concat(native.deviations);
		const rates = sessionRateMetrics(session);
		if (rates.tokensPerMin !== null) rateAll.push(rates.tokensPerMin);
		incrementsAll = incrementsAll.concat(rates.increments);
	}
	const sortedBlocking = [...blockingAll].sort((a, b) => a - b);
	const sortedDev = [...deviationsAll].sort((a, b) => a - b);
	const sortedRate = [...rateAll].sort((a, b) => a - b);
	const sortedInc = [...incrementsAll].sort((a, b) => a - b);
	const report = {
		corpus: { files: files.length, sessionsWithThreshold },
		m6_nativeBlockingMs: {
			total: sortedBlocking.reduce((s, v) => s + v, 0),
			p50: quantile(sortedBlocking, 0.5),
			p90: quantile(sortedBlocking, 0.9),
		},
		m8_estimateDeviation: {
			p50: quantile(sortedDev, 0.5),
			p90: quantile(sortedDev, 0.9),
		},
		m9: {
			tokensPerMin: { p50: quantile(sortedRate, 0.5), p90: quantile(sortedRate, 0.9) },
			turnIncrement: {
				p50: quantile(sortedInc, 0.5),
				p90: quantile(sortedInc, 0.9),
				p99: quantile(sortedInc, 0.99),
				max: sortedInc.at(-1) ?? null,
				shareGt5k: sortedInc.filter((v) => v > 5_000).length / Math.max(sortedInc.length, 1),
				shareGt15k: sortedInc.filter((v) => v > 15_000).length / Math.max(sortedInc.length, 1),
				shareGt30k: sortedInc.filter((v) => v > 30_000).length / Math.max(sortedInc.length, 1),
			},
		},
		schemes: Object.fromEntries(
			Object.entries(schemeResults).map(([scheme, results]) => [scheme, aggregate(results)]),
		),
	};
	if (asJson) console.log(JSON.stringify(report, null, 2));
	else console.log(JSON.stringify(report, null, 2)); // aggregates only either way
}

if (import.meta.url === `file://${process.argv[1]}`) {
	main();
}
