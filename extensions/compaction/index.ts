/*
 * Smart Compaction — controller assembly (SPEC SC §5.1/§5.10 ST-03..06,
 * §5.7/§5.8 wiring; task W4).
 *
 * The 14th module factory. Event map:
 *
 *   session_start / session_shutdown   settings reload + reset (ST-03),
 *                                      abort in-flight compute, generation++
 *   turn_end / agent_before_settle     apply points (POL-07): boundary
 *                                      evaluation → propose draft (APP-01…08,
 *                                      fully synchronous — APP-03) or launch
 *                                      the background compute (single promise
 *                                      chain, INV-2)
 *   reconcile trigger set (§5.2, S1⑦)  turn_start / context /
 *                                      before_provider_request / agent_end /
 *                                      agent_settled / input /
 *                                      session_before_compact / session_tree /
 *                                      session_shutdown — first arrival after
 *                                      a draft scans the branch for our nonce
 *                                      (APP-08, INV-13)
 *   session_before_compact             fallback supply leg (FB-01…07) +
 *                                      POL-07② recovery flag on overflow
 *   session_compact                    FB-08 native-summary audit
 *                                      (fromExtension falsy only)
 *   session_compact_failed             POL-07② recovery flag
 *   /compaction [status|mode off|shadow|on]   ST-04
 *
 * Every handler body is try/caught (INV-1) and the proposal path contains no
 * await before returning the draft. pi-compat probe (POL-08) forces mode off
 * below 1.5.0; `compaction.enabled=false` forces shadow (POL-06).
 *
 * NOTE on lost(overridden): the BLK-2(a) blocking test (executable spec)
 * requires the SNAPSHOT to survive an override so a later clean boundary can
 * commit it — resolving the §5.2 wording ("快照作废") in favor of §4.4's
 * "快照不消耗". lost(branch-changed/dropped) DOES void the snapshot.
 */

import { VERSION, SettingsManager, getLatestCompactionEntry, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { versionAtLeast } from "../../lib/pi-compat.ts";
import { notifyAfter, notifyBefore } from "../../lib/compaction-seam.ts";
import { readActiveGoalFiles } from "../goal/storage/goal-files.ts";
import { SessionRuntime, buildTelemetryEntry, type CompactionTelemetryData } from "./state.ts";
import {
	applyPointSafe,
	effectiveThreshold,
	estimatePost,
	jointFeasibility,
} from "./policy.ts";
import { selectCut } from "./cutpoint.ts";
import { buildPreparation, computeFileLists } from "./preparation.ts";
import { runSummarizer, resolveSummaryModel, type SummarizerOutcome } from "./summarizer.ts";
import { buildDraft, mergeDraftEntries, reconcile, runPrechecks } from "./apply.ts";
import { auditNativeSummary, buildSupplyCompaction, decideFallback, hardFitLimitFor } from "./fallback.ts";
import {
	assembleLedger,
	narrativeHeader,
} from "./ledger/assemble.ts";
import { buildFlowLedger, previousLedgerRunIds } from "./ledger/rex-flow.ts";
import { runClosedSignal } from "./signals/rex-flow.ts";
import { gitCommitSignal, goalStepSignal, verifiedSignal } from "./signals/long-task.ts";
import { stripLedgerBlock } from "./validate.ts";
import {
	DEFAULT_COMPACTION_CORE_SETTINGS,
	loadCompactionSettings,
	setCompactionSettingsPath,
	type CompactionSettings,
} from "./settings.ts";
import { readJson, writeJsonAtomic } from "../../lib/settings.ts";
import type { PrecomputedSnapshot, ProjectedEntry } from "./types.ts";
import type { CompressedRegionView } from "./ledger/types.ts";
type CompressedRegionViewLike = CompressedRegionView;

const RECONCILE_EVENTS = [
	"turn_start",
	"context",
	"before_provider_request",
	"agent_end",
	"agent_settled",
	"input",
	"session_tree",
	"session_shutdown",
] as const;

export default function compactionController(pi: ExtensionAPI): void {
	// ── session-scoped state (rebuilt on session_start) ───────────────────
	let settings: CompactionSettings = DEFAULT_COMPACTION_CORE_SETTINGS;
	// A3 (2026-11-10): lost(overridden) re-propose bound — degrade to shadow
	// after this many overrides (same family as conflictEditDegradeAfter=2).
	// SC_TEST_OVERRIDE_DEGRADE_AFTER is a test seam ONLY (repro/BLK tests).
	const OVERRIDE_DEGRADE_AFTER = Number(process.env.SC_TEST_OVERRIDE_DEGRADE_AFTER ?? "2");
	let runtime = new SessionRuntime({
		settings,
		emitTelemetry: () => {},
		notifyBefore,
		notifyAfter,
	});
	let inFlight: { controller: AbortController; generation: number; promise: Promise<void> } | null = null;
	let nativeRecoveryPending = false; // POL-07②
	let sessionTreeSinceProposal = false;
	let resolvedMode: "off" | "shadow" | "on" = "on";
	let compatWarningShown = false;

	const emitTelemetry = (pi2: ExtensionAPI) => (data: CompactionTelemetryData) => {
		try {
			pi2.appendEntry(buildTelemetryEntry(data).type, buildTelemetryEntry(data).data);
		} catch {
			/* fail-open (INV-1) */
		}
	};

	/** Agent dir resolution: real sessions expose <agentDir>/sessions/…;
	 * fall back to ~/.pi/agent (the settings-file home, ST-02). */
	const agentDirOf = (ctx: ExtensionContext): string => {
		const sessionDir = ctx.sessionManager.getSessionDir();
		// Both "<agentDir>/sessions/<encoded>" (real hosts) and a bare
		// "<agentDir>/sessions" root (test scaffolds) resolve to agentDir.
		const marker = sessionDir.indexOf("/sessions");
		if (sessionDir.length > 0 && marker > 0) return sessionDir.slice(0, marker);
		return join(homedir(), ".pi", "agent");
	};

	const reloadSettings = (ctx?: ExtensionContext): void => {
		if (ctx) setCompactionSettingsPath(join(agentDirOf(ctx), "core-compaction.json"));
		const loaded = loadCompactionSettings();
		settings = loaded.settings;
		for (const warning of loaded.warned) console.warn(`[compaction] ${warning}`);
		// POL-08 version gate > POL-06 native-enabled gate > configured mode.
		const versionOk = versionAtLeast(VERSION, "1.5.0");
		if (!versionOk && !compatWarningShown) {
			console.warn(`[compaction] pi ${VERSION} < 1.5.0 — controller forced off`);
			compatWarningShown = true;
		}
		resolvedMode = versionOk
			? settings.mode === "off" || !nativeCompactionEnabled(ctx)
				? settings.mode === "off" ? "off" : "shadow"
				: settings.mode
			: "off";
		runtime = new SessionRuntime({
			settings,
			emitTelemetry: emitTelemetry(pi),
			notifyBefore,
			notifyAfter,
		});
	};

	const nativeCompactionEnabled = (ctx?: ExtensionContext): boolean => {
		if (!ctx) return true; // cannot probe yet — assume enabled; re-resolved per session
		try {
			const manager = SettingsManager.create(ctx.cwd, agentDirOf(ctx));
			return manager.getCompactionSettings(ctx.model ?? { provider: "", id: "" }).enabled;
		} catch {
			return true; // fail-open: don't force shadow on a probe error
		}
	};

	// ── pressure + feasibility inputs ─────────────────────────────────────
	const thresholdOf = (ctx: ExtensionContext): { tn: number | null; keep: number } => {
		try {
			const manager = SettingsManager.create(ctx.cwd, agentDirOf(ctx));
			const piSettings = manager.getCompactionSettings(ctx.model ?? { provider: "", id: "" });
			const window = (ctx.model as { contextWindow?: number } | undefined)?.contextWindow;
			return { tn: effectiveThreshold(window ?? null, piSettings.reserveTokens), keep: piSettings.keepRecentTokens };
		} catch {
			return { tn: null, keep: 20_000 };
		}
	};

	const pressureOf = (ctx: ExtensionContext): number | null => {
		try {
			const usage = ctx.getContextUsage();
			return usage?.tokens ?? null;
		} catch {
			return null;
		}
	};

	// ── ledger providers (all synchronous, LED-07-isolated inside assemble) ──
	const ledgerProviders = (ctx: ExtensionContext, region?: CompressedRegionViewLike) => ({
		goal: () => {
			try {
				const goals = readActiveGoalFiles({ cwd: ctx.cwd } as never);
				if (goals.length === 0) return undefined;
				return {
					goalsById: new Map(goals.map((goal) => [goal.id, goal])),
					focusedGoalId: null,
					ledgerEvents: [],
				};
			} catch {
				return undefined;
			}
		},
		previousSummary: (() => {
			try {
				return getLatestCompactionEntry(ctx.sessionManager.getBranch())?.summary;
			} catch {
				return undefined;
			}
		})(),
		flow: region
			? () => {
					try {
						const previous = getLatestCompactionEntry(ctx.sessionManager.getBranch())?.summary;
						const result = buildFlowLedger({
							cwd: ctx.cwd,
							homeDir: homedir(),
							settings,
							region,
							previousRunIds: previousLedgerRunIds(previous),
						});
						return result.state;
					} catch {
						return undefined; // INV-6 fail-open
					}
				}
			: undefined,
	});

	// ── background compute (single promise chain, SUM-07) ─────────────────
	const launchCompute = (ctx: ExtensionContext): void => {
		const generation = runtime.state.generation;
		const controller = new AbortController();
		const started = Date.now();
		const promise = (async () => {
			try {
				const projection = ctx.sessionManager.buildSessionProjection();
				const { tn, keep } = thresholdOf(ctx);
				if (tn === null) return;
				const feasibility = jointFeasibility({
					tn,
					keepRecentTokens: keep,
					summaryTokenEstimate: settings.summaryTokenEstimate,
					lastSummaryTokens: lastSummaryTokensOf(ctx),
					precomputeRatio: settings.precomputeRatio,
					applyRatio: settings.applyRatio,
					targetPostRatio: settings.targetPostRatio,
				});
				const cut = selectCut(projection.entries as ProjectedEntry[], {
					keepRecentTokens: keep,
					keepSlackTokens: settings.keepSlackTokens,
					feasibility,
					weights: settings.weights as unknown as Record<string, number>,
					lambda: settings.lambda,
					idleGapMs: settings.idleGapMs,
					// W7/W8 semantic signals (CUT-04 preference classes).
					signals: [runClosedSignal, goalStepSignal, gitCommitSignal, verifiedSignal],
				});
				if (cut.status === "infeasible") {
					runtime.onComputeFailed("infeasible-cut");
					return;
				}
				const previous = getLatestCompactionEntry(ctx.sessionManager.getBranch());
				const preparation = buildPreparation({
					projection,
					cut: cut.cut,
					settings: { enabled: true, reserveTokens: Math.max(1, (ctx.model as { contextWindow?: number } | undefined)?.contextWindow ?? 128_000 - tn), keepRecentTokens: keep },
					previousSummaryNarrative: previous ? stripLedgerBlock(previous.summary) : undefined,
				});
				if (!preparation) {
					runtime.onComputeFailed("nothing-to-summarize");
					return;
				}
				const resolution = resolveSummaryModel(settings.summaryModel, ctx.modelRegistry as never, preparation.tokensBefore, ctx.model);
				let apiKey: string | undefined;
				let headers: Record<string, string> | undefined;
				try {
					const auth = await (ctx.modelRegistry as unknown as { getApiKeyAndHeaders?: (model: unknown) => Promise<{ apiKey?: string; headers?: Record<string, string> }> }).getApiKeyAndHeaders?.(resolution.model ?? ctx.model);
					apiKey = auth?.apiKey;
					headers = auth?.headers;
				} catch {
					/* provider default auth */
				}
				const outcome: SummarizerOutcome = await runSummarizer({
					preparation,
					model: (resolution.model ?? ctx.model)!,
					apiKey,
					headers,
					// Registry transport: modelRegistry.complete resolves the
					// provider API through the session's ModelRuntime — the
					// same registry the host itself streams through (the
					// bare completeSimple default has no runtime registration).
					transport: { call: (model, context, options) => ctx.modelRegistry.complete(model, context as never, options as never) as never },
					summaryThinking: settings.summaryThinking,
					summaryMaxTokens: settings.summaryMaxTokens,
					thresholds: {
						minNarrativeChars: settings.minNarrativeChars,
						minPrefixChars: settings.minPrefixChars,
						maxSummaryChars: settings.maxSummaryChars,
					},
					signal: controller.signal,
				});
				if (controller.signal.aborted || generation !== runtime.state.generation) return; // SUM-07
				if (!outcome.ok) {
					if (outcome.reason === "aborted") return;
					runtime.onComputeFailed(outcome.reason);
					return;
				}
				const snapshot: PrecomputedSnapshot = {
					generation,
					cut: cut.cut,
					branchPathIds: ctx.sessionManager.getBranch().map((entry) => (entry as { id?: string }).id ?? ""),
					summary: outcome.summary,
					summaryTokens: Math.ceil(outcome.summary.length / 4),
					tnAtSnapshot: tn,
					validated: true,
				};
				runtime.onComputeSucceeded(snapshot, {
					computeMs: Date.now() - started,
					summaryModelFallback: resolution.fallbackToSession || undefined,
				});
			} catch {
				// INV-1: a compute crash degrades to refused, never blocks.
				runtime.onComputeFailed("compute-error");
			}
		})();
		inFlight = { controller, generation, promise };
		// SUM-07: release the single-flight slot when THIS generation's
		// compute settles (stale generations' settles must not clobber a
		// newer in-flight slot).
		void promise.finally(() => {
			if (inFlight?.generation === generation) inFlight = null;
		});
	};

	const lastSummaryTokensOf = (ctx: ExtensionContext): number | undefined => {
		try {
			const latest = getLatestCompactionEntry(ctx.sessionManager.getBranch());
			return latest ? Math.ceil(latest.summary.length / 4) : undefined;
		} catch {
			return undefined;
		}
	};

	// LED-06: the narrative header's trust wording follows board association.
	let lastFlowTrusted = false;

	// ── the proposal path (synchronous, APP-01…08) ────────────────────────
	// A1 (2026-11-10, review P0): applySafe is threaded from the caller (the
	// propose gate in onApplyPoint) instead of being hardcoded true.
	const tryPropose = (event: { entries?: unknown[] }, ctx: ExtensionContext, midRun: boolean, applySafe: boolean): { entries: unknown[] } | undefined => {
		const snapshot = runtime.snapshot;
		if (!snapshot || runtime.state.phase !== "ready") return undefined;
		const { tn } = thresholdOf(ctx);
		if (tn === null) return undefined;
		const branch = ctx.sessionManager.getBranch();
		const projection = ctx.sessionManager.buildSessionProjection();
		const entries = projection.entries as ProjectedEntry[];
		// Compressed region ids: branch ids before the kept head.
		const cutBranchIndex = branch.findIndex((entry) => (entry as { id?: string }).id === snapshot.cut.firstKeptEntryId);
		if (cutBranchIndex < 0) {
			runtime.onDiscarded("v3-cut-invalid");
			return undefined;
		}
		const compressedRegionIds = new Set(branch.slice(0, cutBranchIndex).map((entry) => (entry as { id?: string }).id ?? ""));

		// Ledger at APPLY time (LED-06) + self-check (LED-08).
		const boundaryStart = entries.findIndex((entry) => entry.sourceEntry.type === "compaction" && entry.messages.length > 0) + 1;
		const region = { entries: entries.slice(boundaryStart, snapshot.cut.firstKeptEntryIndex) };
		const providers = ledgerProviders(ctx, region);
		const ledger = assembleLedger({ region, providers, settings });
		lastFlowTrusted = providers.flow?.()?.associated ?? false;
		if (!ledger.selfCheck.ok) {
			runtime.onDiscarded("v6-summary-invalid", { reason: "ledger-self-check-failed" });
			return undefined;
		}

		// Final summary: header + narrative + ledger + pi's file sections.
		const raw = snapshot.summary;
		const fileIdx = Math.min(
			...[raw.indexOf("<read-files>"), raw.indexOf("<modified-files>")].filter((i) => i >= 0).concat([raw.length]),
		);
		const narrative = raw.slice(0, fileIdx).trimEnd();
		const files = fileIdx < raw.length ? raw.slice(fileIdx) : "";
		const finalSummary = [narrativeHeader(lastFlowTrusted), narrative, ledger.block, files].filter((part) => part.length > 0).join("\n\n");

		// V1–V10 with the REAL final numbers.
		const keptMessages = entries.slice(snapshot.cut.firstKeptEntryIndex).flatMap((entry) => entry.messages);
		const estimate = estimatePost({
			summary: finalSummary,
			keptMessages,
			currentProjectionMessages: projection.messages,
			ctxTokensUsage: pressureOf(ctx),
			contextWindow: (ctx.model as { contextWindow?: number } | undefined)?.contextWindow ?? 128_000,
			unknownOverheadTokens: settings.unknownOverheadTokens,
		});
		const prechecks = runPrechecks({
			snapshotPathIds: snapshot.branchPathIds,
			branchEntries: branch,
			firstKeptEntryId: snapshot.cut.firstKeptEntryId,
			firstKeptStillLegal: isLegalCutHere(entries, snapshot.cut.firstKeptEntryIndex),
			compressedRegionIds,
			tnAtSnapshot: snapshot.tnAtSnapshot,
			tnNow: tn,
			summaryValidated: snapshot.validated,
			applySafe,
			estimatePostTokens: estimate.total,
			hardFitLimit: settings.hardFitRatio * tn,
			efficiencyLimit: settings.precomputeRatio * tn,
			degraded: runtime.degraded,
			signalAborted: false,
			sameBoundaryEntries: (event.entries ?? []) as Array<Record<string, unknown>>,
		});
		if (prechecks.action === "hold") return undefined; // V10: snapshot stays ready
		if (prechecks.action === "discard") {
			runtime.onDiscarded(prechecks.reason, { estPostTokens: estimate.total });
			return undefined;
		}

		// Propose: seam BEFORE first (APP-05), then the draft (APP-01).
		const proposalId = randomUUID();
		const decision = runtime.onBoundary({
			type: "boundary",
			P: (pressureOf(ctx) ?? 0) / tn,
			applySafe,
			isApplyPoint: true,
			prechecksPassed: true,
			lastAssistantStopReason: lastAssistantStopOf(event),
			feasibility: jointFeasibility({
				tn,
				keepRecentTokens: thresholdOf(ctx).keep,
				summaryTokenEstimate: settings.summaryTokenEstimate,
				precomputeRatio: settings.precomputeRatio,
				applyRatio: settings.applyRatio,
				targetPostRatio: settings.targetPostRatio,
			}),
			mayCompute: false,
			proposalNonce: proposalId,
		});
		if (decision.action.type !== "propose") return undefined;
		runtime.onProposed({ midRun, summaryChars: finalSummary.length, tokensBefore: pressureOf(ctx) ?? undefined });
		const draft = buildDraft({
			summary: finalSummary,
			firstKeptEntryId: snapshot.cut.firstKeptEntryId,
			readFiles: fileListsOf(snapshot.summary).readFiles,
			modifiedFiles: fileListsOf(snapshot.summary).modifiedFiles,
			proposalId,
			cutClass: snapshot.cut.boundaryClass,
			providers: ["generic"],
		});
		pendingProposal = { proposalId, compressedRegionIds, midRun, summaryChars: finalSummary.length, estPostTokens: estimate.total, proposedAtTurn: runtime.state.turns };
		return mergeDraftEntries((event.entries ?? []) as unknown[], draft);
	};

	const isLegalCutHere = (entries: ProjectedEntry[], index: number): boolean => {
		const entry = entries[index];
		if (!entry) return false;
		if (entry.sourceEntry.type === "compaction") return false;
		const roles = new Set(["user", "assistant", "bashExecution", "custom", "branchSummary", "compactionSummary"]);
		return entry.messages.some((message) => roles.has(message.role));
	};

	const fileListsOf = (summary: string): { readFiles: string[]; modifiedFiles: string[] } => {
		const read = /<read-files>\n([\s\S]*?)\n<\/read-files>/.exec(summary)?.[1]?.split("\n") ?? [];
		const modified = /<modified-files>\n([\s\S]*?)\n<\/modified-files>/.exec(summary)?.[1]?.split("\n") ?? [];
		return { readFiles: read, modifiedFiles: modified };
	};

	// ── reconciliation (APP-08) ────────────────────────────────────────────
	let pendingProposal: {
		proposalId: string;
		compressedRegionIds: Set<string>;
		midRun: boolean;
		summaryChars: number;
		estPostTokens: number;
		proposedAtTurn: number;
	} | null = null;

	const reconcileIfPending = (ctx: ExtensionContext): void => {
		if (!pendingProposal || runtime.state.phase !== "proposed") return;
		try {
			const branch = ctx.sessionManager.getBranch();
			const result = reconcile(branch, pendingProposal.proposalId, settings.reconcileScanMax, sessionTreeSinceProposal, pendingProposal.compressedRegionIds);
			sessionTreeSinceProposal = false;
			const info = {
				midRun: pendingProposal.midRun,
				summaryChars: pendingProposal.summaryChars,
				estPostTokens: pendingProposal.estPostTokens,
			};
			if (result.status === "committed") {
				runtime.onReconciled(result, { ...info, tokensAfter: undefined });
				pendingProposal = null;
			} else if (result.lostReason === "overridden") {
				// BLK-2(a) executable-spec semantics: the override lost the
				// PROPOSAL, not the snapshot — back to ready, re-propose at the
				// next eligible boundary with a fresh nonce. A3 (2026-11-10):
				// re-propose loops are bounded — after OVERRIDE_DEGRADE_AFTER
				// overrides the controller degrades to shadow (same family as
				// conflictEditDegradeAfter).
				runtime.onOverridden(OVERRIDE_DEGRADE_AFTER);
				runtime.state = { ...runtime.state, phase: "ready", proposalId: undefined };
				pendingProposal = null;
			} else {
				runtime.onReconciled(result, info);
				pendingProposal = null;
			}
		} catch {
			/* reconcile is best-effort; the next trigger retries */
		}
	};

	// ── apply-point boundary evaluation ───────────────────────────────────
	// A1 (2026-11-10, review P0): POL-07 reads the LAST assistant entry's
	// stopReason from the boundary's entries — event.message only covers
	// turn_end; agent_before_settle drafts must be gated the same way.
	const lastAssistantStopOf = (e: { entries?: unknown[]; message?: { stopReason?: string } }): string | undefined => {
		const list = e.entries ?? [];
		for (let i = list.length - 1; i >= 0; i--) {
			const stop = (list[i] as { message?: { stopReason?: string } } | undefined)?.message?.stopReason;
			if (typeof stop === "string") return stop;
		}
		return e.message?.stopReason;
	};
	const onApplyPoint = (event: { entries?: unknown[]; message?: { stopReason?: string }; outcome?: string }, ctx: ExtensionContext, midRun: boolean): { entries: unknown[] } | undefined => {
		if (resolvedMode === "off" || resolvedMode === "shadow") return undefined;
		try {
			// NOTE: no reconcile here — this handler may itself return the
			// draft being proposed; the NEXT trigger-set event reconciles.
			const { tn, keep } = thresholdOf(ctx);
			if (tn === null) return undefined;
			const tokens = pressureOf(ctx);
			const P = tokens === null ? null : tokens / tn;
			const feasibility = jointFeasibility({
				tn,
				keepRecentTokens: keep,
				summaryTokenEstimate: settings.summaryTokenEstimate,
				lastSummaryTokens: lastSummaryTokensOf(ctx),
				precomputeRatio: settings.precomputeRatio,
				applyRatio: settings.applyRatio,
				targetPostRatio: settings.targetPostRatio,
			});
			const stopReason = event.message?.stopReason;
			// First evaluation: start-computing decisions ONLY. The propose
			// transition happens exactly once, inside tryPropose's own
			// boundary event (after the V-gates pass) — evaluating it here
			// would strand the phase at "proposed" with no draft returned.
			const decision = runtime.onBoundary({
				type: "boundary",
				P,
				applySafe: applyPointSafe({ stopReason, outcome: event.outcome, nativeRecoveryPending }),
				isApplyPoint: false,
				prechecksPassed: true, // the real V1–V10 run inside tryPropose
				lastAssistantStopReason: lastAssistantStopOf(event),
				feasibility,
				mayCompute: resolvedMode === "on" && !runtime.degraded && !inFlight,
				proposalNonce: randomUUID(),
			});
			if (decision.action.type === "start-computing" && !inFlight) launchCompute(ctx);
			if (P !== null && P >= settings.applyRatio) {
				// A1 (review P0): the propose path itself must pass POL-07 —
				// previously applySafe was computed here and thrown away and
				// tryPropose hardcoded `true`, letting length-boundary drafts
				// swallow native recovery. Explicit `length` evidence (entries
				// or message) is fail-closed; boundaries carrying NO stop
				// info (agent_before_settle) derive from structure: mid-run
				// ≈ toolUse, run-end ≈ stop — a truncation surfaces at
				// turn_end/entries, never structurally here.
				const lastStop = lastAssistantStopOf(event);
				const stopForGate = lastStop ?? (midRun ? "toolUse" : "stop");
				const proposeSafe = applyPointSafe({ stopReason: stopForGate, outcome: event.outcome, nativeRecoveryPending });
				if (!proposeSafe) return undefined;
				return tryPropose(event, ctx, midRun, proposeSafe);
			}
			return undefined;
		} catch (error) {
			if (process.env.SC_DEBUG) console.error("[compaction] apply-point error:", error);
			return undefined; // APP-06: never throw into pi
		}
	};

	// ── fallback leg (§5.8) ────────────────────────────────────────────────
	const onBeforeCompact = async (event: {
		reason: "manual" | "threshold" | "overflow";
		customInstructions?: string;
		signal?: AbortSignal;
		willRetry?: boolean;
	}, ctx: ExtensionContext): Promise<{ compaction?: unknown } | undefined> => {
		if (resolvedMode === "off") return undefined;
		try {
			// POL-07②: mark pending native recovery on overflow attempts.
			if (event.reason === "overflow") nativeRecoveryPending = true;
			if (resolvedMode === "shadow") return undefined;
			const { tn } = thresholdOf(ctx);
			if (tn === null) return undefined;
			const deadlineAt = Date.now() + settings.fallbackDeadlineMs;
			const hasComputing = runtime.state.phase === "computing" && inFlight !== null;
			const gatesForSnapshot = (): { gates: boolean; fit: boolean; estimate: number } => {
				const snapshot = runtime.snapshot;
				if (!snapshot) return { gates: false, fit: false, estimate: Number.POSITIVE_INFINITY };
				const projection = ctx.sessionManager.buildSessionProjection();
				const entries = projection.entries as ProjectedEntry[];
				const kept = entries.slice(snapshot.cut.firstKeptEntryIndex).flatMap((entry) => entry.messages);
				const estimate = estimatePost({
					summary: snapshot.summary,
					keptMessages: kept,
					currentProjectionMessages: projection.messages,
					ctxTokensUsage: pressureOf(ctx),
					contextWindow: (ctx.model as { contextWindow?: number } | undefined)?.contextWindow ?? 128_000,
					unknownOverheadTokens: settings.unknownOverheadTokens,
				});
				const branch = ctx.sessionManager.getBranch();
				const cutBranchIndex = branch.findIndex((entry) => (entry as { id?: string }).id === snapshot.cut.firstKeptEntryId);
				const compressed = new Set(branch.slice(0, Math.max(0, cutBranchIndex)).map((entry) => (entry as { id?: string }).id ?? ""));
				const prechecks = runPrechecks({
					snapshotPathIds: snapshot.branchPathIds,
					branchEntries: branch,
					firstKeptEntryId: snapshot.cut.firstKeptEntryId,
					firstKeptStillLegal: true,
					compressedRegionIds: compressed,
					tnAtSnapshot: snapshot.tnAtSnapshot,
					tnNow: tn,
					summaryValidated: snapshot.validated,
					applySafe: true, // V7 n/a on the supply path
					estimatePostTokens: estimate.total,
					hardFitLimit: Number.POSITIVE_INFINITY, // evaluated separately below
					efficiencyLimit: undefined,
					degraded: runtime.degraded,
					signalAborted: event.signal?.aborted ?? false,
					sameBoundaryEntries: [],
				});
				return {
					gates: prechecks.action !== "discard" || prechecks.reason === "v8a-hard-fit",
					fit: estimate.total <= hardFitLimitFor(event.reason, settings, tn),
					estimate: estimate.total,
				};
			};

			const initial = gatesForSnapshot();
			const decision = decideFallback({
				reason: event.reason,
				hasCustomInstructions: typeof event.customInstructions === "string" && event.customInstructions.length > 0,
				hasComputingSnapshot: hasComputing,
				hasReadySnapshot: runtime.state.phase === "ready" && runtime.snapshot !== null,
				snapshotGatesPassed: runtime.state.phase === "ready" && initial.gates,
				snapshotHardFitPassed: runtime.state.phase === "ready" && initial.fit,
			});

			if (process.env.SC_DEBUG) console.error("[sc-debug] fallback decision:", decision.action, "reason:", event.reason, "phase:", runtime.state.phase, "hasSnapshot:", !!runtime.snapshot);
			if (decision.action === "supply-snapshot" && runtime.snapshot) {
				const snapshot = runtime.snapshot;
				const files = fileListsOf(snapshot.summary);
				const supply = buildSupplyCompaction({
					snapshot,
					summary: snapshot.summary,
					tokensBefore: pressureOf(ctx) ?? snapshot.tnAtSnapshot,
					readFiles: files.readFiles,
					modifiedFiles: files.modifiedFiles,
					proposalId: randomUUID(),
				});
				runtime.snapshot = null; // consumed by the supply
				runtime.onServed(); // A2: leave "ready" — re-precompute, never re-propose the consumed draft
				return supply;
			}
			if (decision.action === "native") return undefined;

			// ② wait-for-ready: race the in-flight compute against the SINGLE
			// deadline timer (the INV-2 exception) + the event signal.
			if (decision.action === "wait-for-ready" && inFlight) {
				const signal = event.signal;
				const timer = new Promise<undefined>((resolveTimer) => {
					const remaining = Math.max(0, deadlineAt - Date.now());
					const t = setTimeout(() => resolveTimer(undefined), remaining);
					t.unref?.();
				});
				const aborted = new Promise<undefined>((resolveAbort) => {
					if (signal?.aborted) return resolveAbort(undefined);
					signal?.addEventListener("abort", () => resolveAbort(undefined), { once: true });
				});
				await Promise.race([inFlight.promise.then(() => "done" as const), timer, aborted]);
				if (signal?.aborted || Date.now() >= deadlineAt) {
					// FB-07: bump generation, abort the old task, return now.
					abortInFlight();
					runtime.onSessionReset();
					return undefined;
				}
				const afterWait = gatesForSnapshot();
				if (process.env.SC_DEBUG) console.error("[sc-debug] wait-path afterWait:", JSON.stringify(afterWait), "phase:", runtime.state.phase);
				if (runtime.state.phase === "ready" && afterWait.gates && afterWait.fit && runtime.snapshot) {
					const snapshot = runtime.snapshot;
					const files = fileListsOf(snapshot.summary);
					const supply = buildSupplyCompaction({
						snapshot,
						summary: snapshot.summary,
						tokensBefore: pressureOf(ctx) ?? snapshot.tnAtSnapshot,
						readFiles: files.readFiles,
						modifiedFiles: files.modifiedFiles,
						proposalId: randomUUID(),
					});
					runtime.snapshot = null;
					runtime.onServed(); // A2 (wait-path supply): same transition
					return supply;
				}
				return undefined; // ready but unfit → do not supply, do not regenerate late
			}

			// ③ synchronous regeneration, single attempt, remaining budget.
			if (decision.action === "regenerate" && Date.now() < deadlineAt) {
				const outcome = await regenerateNow(ctx, tn, deadlineAt, event.reason, event.signal);
				if (outcome) return outcome;
			}
			return undefined;
		} catch {
			return undefined; // FB-05
		}
	};

	const regenerateNow = async (ctx: ExtensionContext, tn: number, deadlineAt: number, reason: "manual" | "threshold" | "overflow", signal?: AbortSignal): Promise<{ compaction?: unknown } | undefined> => {
		const controller = new AbortController();
		const generation = runtime.state.generation;
		try {
			const projection = ctx.sessionManager.buildSessionProjection();
			const { keep } = thresholdOf(ctx);
			const feasibility = jointFeasibility({
				tn,
				keepRecentTokens: keep,
				summaryTokenEstimate: settings.summaryTokenEstimate,
				precomputeRatio: settings.precomputeRatio,
				applyRatio: settings.applyRatio,
				targetPostRatio: settings.targetPostRatio,
			});
			const cut = selectCut(projection.entries as ProjectedEntry[], {
				keepRecentTokens: keep,
				keepSlackTokens: settings.keepSlackTokens,
				feasibility,
				weights: settings.weights as unknown as Record<string, number>,
				lambda: settings.lambda,
				idleGapMs: settings.idleGapMs,
			});
			if (cut.status === "infeasible") return undefined;
			const previous = getLatestCompactionEntry(ctx.sessionManager.getBranch());
			const preparation = buildPreparation({
				projection,
				cut: cut.cut,
				settings: { enabled: true, reserveTokens: 16000, keepRecentTokens: keep },
				previousSummaryNarrative: previous ? stripLedgerBlock(previous.summary) : undefined,
			});
			if (!preparation) return undefined;
			const deadlinePromise = new Promise<undefined>((resolveTimer) => {
				const t = setTimeout(() => {
					controller.abort();
					resolveTimer(undefined);
				}, Math.max(0, deadlineAt - Date.now()));
				t.unref?.();
			});
			signal?.addEventListener("abort", () => controller.abort(), { once: true });
			const outcomePromise = runSummarizer({
				preparation,
				model: ctx.model!,
				transport: { call: (model, context, options) => ctx.modelRegistry.complete(model, context as never, options as never) as never },
				summaryThinking: settings.summaryThinking,
				summaryMaxTokens: settings.summaryMaxTokens,
				thresholds: { minNarrativeChars: settings.minNarrativeChars, minPrefixChars: settings.minPrefixChars, maxSummaryChars: settings.maxSummaryChars },
				signal: controller.signal,
			});
			const outcome = await Promise.race([outcomePromise, deadlinePromise]);
			if (!outcome || !outcome.ok) return undefined; // single attempt, no retry (FB-07)
			// V8a with the strict ratio for this reason.
			const kept = (projection.entries as ProjectedEntry[]).slice(cut.cut.firstKeptEntryIndex).flatMap((entry) => entry.messages);
			if (process.env.SC_DEBUG) console.error("[sc-debug] regenerate summary produced, gating V8a");
			const estimate = estimatePost({
				summary: outcome.summary,
				keptMessages: kept,
				currentProjectionMessages: projection.messages,
				ctxTokensUsage: pressureOf(ctx),
				contextWindow: (ctx.model as { contextWindow?: number } | undefined)?.contextWindow ?? 128_000,
				unknownOverheadTokens: settings.unknownOverheadTokens,
			});
			// V8a with THIS reason's ratio (overflow stricter, INV-12).
			if (estimate.total > hardFitLimitFor(reason, settings, tn)) return undefined;
			void generation;
			const files = fileListsOf(outcome.summary);
			const snapshotLike: PrecomputedSnapshot = {
				generation,
				cut: cut.cut,
				branchPathIds: ctx.sessionManager.getBranch().map((entry) => (entry as { id?: string }).id ?? ""),
				summary: outcome.summary,
				summaryTokens: Math.ceil(outcome.summary.length / 4),
				tnAtSnapshot: tn,
				validated: true,
			};
			return buildSupplyCompaction({
				snapshot: snapshotLike,
				summary: outcome.summary,
				tokensBefore: pressureOf(ctx) ?? tn,
				readFiles: files.readFiles,
				modifiedFiles: files.modifiedFiles,
				proposalId: randomUUID(),
				usage: outcome.usage,
			});
		} catch {
			return undefined;
		}
	};

	const abortInFlight = (): void => {
		if (!inFlight) return;
		inFlight.controller.abort();
		inFlight = null;
	};

	// ── event wiring ──────────────────────────────────────────────────────
	pi.on("session_start" as never, ((event: unknown, ctx: ExtensionContext) => {
		try {
			reloadSettings(ctx);
			if (process.env.SC_DEBUG) console.error("[sc-debug] after reload: mode=", resolvedMode, "configured=", settings.mode, "p=", settings.precomputeRatio, "a=", settings.applyRatio);
			abortInFlight();
			runtime.onSessionReset();
			nativeRecoveryPending = false;
			sessionTreeSinceProposal = false;
			pendingProposal = null;
		} catch {
			/* never block */
		}
	}) as never);

	pi.on("session_shutdown" as never, (() => {
		try {
			abortInFlight();
			runtime.onSessionReset();
			pendingProposal = null;
		} catch {
			/* never block */
		}
	}) as never);

	pi.on("session_tree" as never, (() => {
		try {
			sessionTreeSinceProposal = true;
			abortInFlight();
			runtime.onSessionReset(); // V1: branch changed — drop custody
			pendingProposal = null;
		} catch {
			/* never block */
		}
	}) as never);

	for (const name of RECONCILE_EVENTS) {
		pi.on(name as never, ((_event: unknown, ctx: ExtensionContext) => {
			try {
				if (name === "agent_settled") nativeRecoveryPending = false; // POL-07② clear
				reconcileIfPending(ctx);
			} catch {
				/* never block */
			}
		}) as never);
	}

	pi.on("turn_end" as never, ((event: { entries?: unknown[]; message?: { stopReason?: string }; outcome?: string }, ctx: ExtensionContext) => {
		if (process.env.SC_DEBUG) console.error("[sc-debug] turn_end handler INVOKED, stop=", event.message?.stopReason);
		return onApplyPoint(event, ctx, true);
	}) as never);

	pi.on("agent_before_settle" as never, ((event: { entries?: unknown[]; message?: { stopReason?: string }; outcome?: string }, ctx: ExtensionContext) => {
		return onApplyPoint(event, ctx, false);
	}) as never);

	pi.on("session_before_compact" as never, ((event: Parameters<typeof onBeforeCompact>[0], ctx: ExtensionContext) => onBeforeCompact(event, ctx)) as never);

	pi.on("session_compact_failed" as never, (() => {
		try {
			nativeRecoveryPending = true;
		} catch {
			/* never block */
		}
	}) as never);

	pi.on("session_compact" as never, ((event: { fromExtension?: boolean; summary?: string; entry?: { summary?: string } }, ctx: ExtensionContext) => {
		try {
			if (event.fromExtension) return; // our own supply — seam not involved (FB-04)
			// FB-08: audit the NATIVE summary (⑤–⑦ only); telemetry + one notify.
			const summary = event.summary ?? event.entry?.summary ?? "";
			const audit = auditNativeSummary(summary, {
				minNarrativeChars: settings.minNarrativeChars,
				minPrefixChars: settings.minPrefixChars,
				maxSummaryChars: settings.maxSummaryChars,
			});
			if (!audit.valid) {
				emitTelemetry(pi)({
					v: 1,
					outcome: "discarded",
					reason: "native-summary-invalid",
					origin: "native",
					validated: false,
				});
				if (ctx.hasUI) {
					try {
						ctx.ui.notify("[compaction] native summary failed validation (empty/truncated/file-list-only) — audit only, entry unchanged");
					} catch {
						/* notify is best-effort */
					}
				}
			}
		} catch {
			/* never block */
		}
	}) as never);

	// ── /compaction command (ST-04) ───────────────────────────────────────
	pi.registerCommand("compaction" as never, {
		handler: async (args: string, ctx: ExtensionContext) => {
			try {
				const sub = args.trim().split(/\s+/)[0] ?? "";
				if (sub === "mode") {
					const value = args.trim().split(/\s+/)[1] ?? "";
					if (value !== "off" && value !== "shadow" && value !== "on") {
						notifyUser(ctx, "usage: /compaction mode <off|shadow|on>");
						return;
					}
					const settingsPath = join(agentDirOf(ctx), "core-compaction.json");
					const current = readJson<{ mode?: string }>(settingsPath, {});
					writeJsonAtomic(settingsPath, { ...current, mode: value });
					reloadSettings(ctx);
					notifyUser(ctx, `compaction mode → ${resolvedMode}`);
					return;
				}
				const { tn, keep } = thresholdOf(ctx);
				const tokens = pressureOf(ctx);
				const feasibility = tn === null ? null : jointFeasibility({
					tn,
					keepRecentTokens: keep,
					summaryTokenEstimate: settings.summaryTokenEstimate,
					precomputeRatio: settings.precomputeRatio,
					applyRatio: settings.applyRatio,
					targetPostRatio: settings.targetPostRatio,
				});
				const lines = [
					`mode: ${resolvedMode}${settings.mode !== resolvedMode ? ` (configured ${settings.mode})` : ""}`,
					`T_n: ${tn ?? "unknown"}${feasibility && !feasibility.feasible ? ` — INFEASIBLE (need T_n ≥ ${Math.ceil(feasibility.neededTn)})` : ""}`,
					`P: ${tokens !== null && tn ? (tokens / tn).toFixed(3) : "unknown"}`,
					`state: ${runtime.state.phase}`,
					`last outcome: ${runtime.state.lastOutcome ? `${runtime.state.lastOutcome.outcome}${runtime.state.lastOutcome.reason ? ` (${runtime.state.lastOutcome.reason})` : ""}` : "none"}`,
					`cooldown: ${runtime.state.refusedCooldownTurns} turns · gap: ${runtime.state.precomputeGapTurns} · degraded: ${runtime.degraded}`,
				];
				notifyUser(ctx, lines.join("\n"));
			} catch {
				notifyUser(ctx, "compaction: status unavailable");
			}
		},
	} as never);
}

function notifyUser(ctx: ExtensionContext, message: string): void {
	try {
		if (ctx.hasUI) ctx.ui.notify(message);
	} catch {
		/* rpc/print modes: never throw (ST-04) */
	}
}
