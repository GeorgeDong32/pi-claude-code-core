
import { VERSION, SettingsManager, getLatestCompactionEntry, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { versionAtLeast } from "../../lib/pi-compat.ts";
import { notifyAfter, notifyBefore } from "../../lib/compaction-seam.ts";
import { readActiveGoalFiles } from "../goal/storage/goal-files.ts";
import { SessionRuntime, buildTelemetryEntry, OVERRIDE_DEGRADE_AFTER, type CompactionTelemetryData } from "./state.ts";
import {
	applyPointSafe,
	lastAssistantStopReason,
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
	compressedRegionOf,
	narrativeHeader,
	sanitizeLedgerLine,
} from "./ledger/assemble.ts";
import { buildFlowLedger, previousLedgerRunIds } from "./ledger/rex-flow.ts";
import { runClosedSignal } from "./signals/rex-flow.ts";
import { gitCommitSignal, goalStepSignal, verifiedSignal } from "./signals/long-task.ts";
import { stripLedgerBlock } from "./validate.ts";
import { COMPACTION_METRICS_ENTRY_TYPE, recordCompactionMetric, type CompactionMetric } from "./metrics.ts";
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
	let settings: CompactionSettings = DEFAULT_COMPACTION_CORE_SETTINGS;
	let runtime = new SessionRuntime({
		settings,
		emitTelemetry: () => {},
		notifyBefore,
		notifyAfter,
	});
	let inFlight: { controller: AbortController; generation: number; promise: Promise<void> } | null = null;
	let nativeRecoveryPending = false;
	let sessionTreeSinceProposal = false;
	let resolvedMode: "off" | "shadow" | "on" = "on";
	let compatWarningShown = false;
	let metricCycleId: string | undefined;
	let fallbackMetric: { attemptId: string; at: number; reason: "threshold" | "overflow" | "manual" } | undefined;

	const emitTelemetry = (pi2: ExtensionAPI) => (data: CompactionTelemetryData) => {
		try {
			pi2.appendEntry(buildTelemetryEntry(data).type, buildTelemetryEntry(data).data);
		} catch {
			/* fail-open (INV-1) */
		}
	};

	const agentDirOf = (ctx: ExtensionContext): string => {
		const sessionDir = ctx.sessionManager.getSessionDir();
		const marker = sessionDir.indexOf("/sessions");
		if (sessionDir.length > 0 && marker > 0) return sessionDir.slice(0, marker);
		return join(homedir(), ".pi", "agent");
	};

	const reloadSettings = (ctx?: ExtensionContext): void => {
		metricCycleId = undefined;
		fallbackMetric = undefined;
		if (ctx) setCompactionSettingsPath(join(agentDirOf(ctx), "core-compaction.json"));
		const loaded = loadCompactionSettings();
		settings = loaded.settings;
		for (const warning of loaded.warned) console.warn(`[compaction] ${warning}`);
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
		if (!ctx) return true;
		try {
			const manager = SettingsManager.create(ctx.cwd, agentDirOf(ctx));
			return manager.getCompactionSettings(ctx.model ?? { provider: "", id: "" }).enabled;
		} catch {
			return true; // fail-open: don't force shadow on a probe error
		}
	};

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

	const measure = (ctx: ExtensionContext, event: CompactionMetric["event"], extra: Partial<CompactionMetric> = {}): void => {
		if (resolvedMode !== "on") return;
		try {
			recordCompactionMetric((data) => pi.appendEntry(COMPACTION_METRICS_ENTRY_TYPE, data), {
				event, tokens: pressureOf(ctx), tn: thresholdOf(ctx).tn,
				phase: runtime.state.phase, degraded: runtime.degraded,
				precomputeRatio: settings.precomputeRatio, applyRatio: settings.applyRatio,
				cycleId: metricCycleId, ...extra,
			});
		} catch {
			/* Measurements must never affect proposal/recovery semantics. */
		}
	};

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

	const launchCompute = (ctx: ExtensionContext): void => {
		const generation = runtime.state.generation;
		const controller = new AbortController();
		const started = Date.now();
		const cycleId = randomUUID();
		metricCycleId = cycleId;
		measure(ctx, "compute-start", { cycleId });
		const promise = (async () => {
			try {
				const projection = ctx.sessionManager.buildSessionProjection();
				const snapshotPathIds = ctx.sessionManager.getBranch().map((entry) => (entry as { id?: string }).id ?? "");
				const { tn, keep } = thresholdOf(ctx);
				if (tn === null) {
					runtime.onComputeFailed("no-threshold");
					return;
				}
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
				let closedIds: string[] | undefined;
				try {
					const region = compressedRegionOf(projection.entries as ProjectedEntry[], cut.cut.firstKeptEntryIndex);
					const ledger = assembleLedger({ region, providers: ledgerProviders(ctx, region), settings });
					if (!ledger.selfCheck.ok) {
						runtime.onComputeFailed(ledger.selfCheck.missing.includes("ledger-over-budget") ? "ledger-over-budget" : "ledger-self-check-failed");
						return;
					}
					closedIds = ledger.closedIds;
				} catch {
					closedIds = undefined;
				}
				const resolution = resolveSummaryModel(settings.summaryModel, ctx.modelRegistry as never, preparation.tokensBefore, ctx.model);
				let apiKey: string | undefined;
				let headers: Record<string, string> | undefined;
				try {
					const auth = await (ctx.modelRegistry as unknown as { getApiKeyAndHeaders?: (model: unknown) => Promise<{ apiKey?: string; headers?: Record<string, string> }> }).getApiKeyAndHeaders?.(resolution.model ?? ctx.model);
					apiKey = auth?.apiKey;
					headers = auth?.headers;
				} catch {
				}
				const outcome: SummarizerOutcome = await runSummarizer({
					preparation,
					model: (resolution.model ?? ctx.model)!,
					apiKey,
					headers,
					closedIds,
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
				if (controller.signal.aborted || generation !== runtime.state.generation) return;
				if (!outcome.ok) {
					if (outcome.reason === "aborted") return;
					runtime.onComputeFailed(outcome.reason);
					return;
				}
				const snapshot: PrecomputedSnapshot = {
					generation,
					cut: cut.cut,
					branchPathIds: snapshotPathIds,
					summary: outcome.summary,
					summaryTokens: Math.ceil(outcome.summary.length / 4),
					tnAtSnapshot: tn,
					validated: true,
				};
				runtime.onComputeSucceeded(snapshot, {
					computeMs: Date.now() - started,
					summaryModelFallback: resolution.fallbackToSession || undefined,
				});
				if (runtime.snapshot === snapshot) measure(ctx, "compute-ready", { cycleId, elapsedMs: Date.now() - started });
			} catch {
				if (generation !== runtime.state.generation) return;
				// INV-1: a compute crash degrades to refused, never blocks.
				runtime.onComputeFailed("compute-error");
			}
		})();
		inFlight = { controller, generation, promise };
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

	let lastFlowTrusted = false;

	const composeFinalSummary = (ctx: ExtensionContext, cut: { firstKeptEntryIndex: number }, rawSummary: string) => {
		try {
			const entries = ctx.sessionManager.buildSessionProjection().entries as ProjectedEntry[];
			const region = compressedRegionOf(entries, cut.firstKeptEntryIndex);
			const providers = ledgerProviders(ctx, region);
			const ledger = assembleLedger({ region, providers, settings });
			if (!ledger.selfCheck.ok) {
				return { ok: false as const, reason: ledger.selfCheck.missing.includes("ledger-over-budget") ? "ledger-over-budget" : "ledger-self-check-failed" };
			}
			const fileIdx = Math.min(
				...[rawSummary.indexOf("<read-files>"), rawSummary.indexOf("<modified-files>")].filter((i) => i >= 0).concat([rawSummary.length]),
			);
			const narrative = sanitizeLedgerLine(rawSummary.slice(0, fileIdx).trimEnd());
			const files = fileIdx < rawSummary.length ? sanitizeLedgerLine(rawSummary.slice(fileIdx)) : "";
			const flowTrusted = ledger.flowAssociated;
			const summary = [narrativeHeader(flowTrusted), narrative, ledger.block, files].filter((part) => part.length > 0).join("\n\n");
			return { ok: true as const, summary, ledgerChars: ledger.chars, flowTrusted, closedIds: ledger.closedIds };
		} catch {
			return { ok: false as const, reason: "ledger-compose-error" };
		}
	};

	const tryPropose = (event: { entries?: unknown[] }, ctx: ExtensionContext, midRun: boolean, applySafe: boolean): { entries: unknown[] } | undefined => {
		const snapshot = runtime.snapshot;
		if (!snapshot || runtime.state.phase !== "ready") return undefined;
		const { tn } = thresholdOf(ctx);
		if (tn === null) return undefined;
		const tokensBefore = pressureOf(ctx);
		const branch = ctx.sessionManager.getBranch();
		const projection = ctx.sessionManager.buildSessionProjection();
		const entries = projection.entries as ProjectedEntry[];
		const cutBranchIndex = branch.findIndex((entry) => (entry as { id?: string }).id === snapshot.cut.firstKeptEntryId);
		if (cutBranchIndex < 0) {
			runtime.onDiscarded("v3-cut-invalid");
			return undefined;
		}
		const compressedRegionIds = new Set(branch.slice(0, cutBranchIndex).map((entry) => (entry as { id?: string }).id ?? ""));

		const composed = composeFinalSummary(ctx, snapshot.cut, snapshot.summary);
		if (!composed.ok) {
			runtime.onDiscarded("v6-summary-invalid", { reason: composed.reason });
			return undefined;
		}
		lastFlowTrusted = composed.flowTrusted;
		const finalSummary = composed.summary;

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
		if (prechecks.action === "hold") return undefined;
		if (prechecks.action === "discard") {
			runtime.onDiscarded(prechecks.reason, { estPostTokens: estimate.total });
			return undefined;
		}

		const proposalId = randomUUID();
		const decision = runtime.onPropose({
			type: "propose",
			P: (pressureOf(ctx) ?? 0) / tn,
			applySafe,
			prechecksPassed: true,
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
		pendingProposal = {
			proposalId, compressedRegionIds, midRun, summaryChars: finalSummary.length,
			estPostTokens: estimate.total, proposedAtTurn: runtime.state.turns,
			tokensBefore, tn, cycleId: metricCycleId, proposedAt: Date.now(),
		};
		sessionTreeSinceProposal = false;
		measure(ctx, "proposal", { proposalId, tokens: tokensBefore, tn, estPostTokens: estimate.total });
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

	let pendingProposal: {
		proposalId: string;
		compressedRegionIds: Set<string>;
		midRun: boolean;
		summaryChars: number;
		estPostTokens: number;
		proposedAtTurn: number;
		tokensBefore: number | null;
		tn: number;
		cycleId?: string;
		proposedAt: number;
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
				measure(ctx, "applied", {
					proposalId: pendingProposal.proposalId, cycleId: pendingProposal.cycleId,
					tokens: pendingProposal.tokensBefore, tn: pendingProposal.tn,
					estPostTokens: pendingProposal.estPostTokens,
					elapsedMs: Date.now() - pendingProposal.proposedAt,
				});
				pendingProposal = null;
			} else if (result.lostReason === "overridden") {
				runtime.onOverridden(info);
				pendingProposal = null;
			} else {
				runtime.onReconciled(result, info);
				pendingProposal = null;
			}
		} catch {
		}
	};

	const onApplyPoint = (event: { entries?: unknown[]; message?: { stopReason?: string }; outcome?: string }, ctx: ExtensionContext, midRun: boolean): { entries: unknown[] } | undefined => {
		if (resolvedMode === "off" || resolvedMode === "shadow") return undefined;
		try {
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
			const stopReason = event.message?.stopReason ?? lastAssistantStopReason(ctx.sessionManager.getBranch());
			const applySafe = applyPointSafe({ stopReason, outcome: event.outcome, nativeRecoveryPending });
			const decision = runtime.onBoundary({
				type: "boundary",
				P,
				applySafe,
				isApplyPoint: false,
				prechecksPassed: true,
				feasibility,
				mayCompute: resolvedMode === "on" && !runtime.degraded && !inFlight,
				proposalNonce: randomUUID(),
			});
			if (decision.action.type === "start-computing" && !inFlight) launchCompute(ctx);
			if (decision.action.type === "mark-infeasible") runtime.onInfeasible(feasibility?.neededTn);
			if (applySafe && P !== null && P >= settings.applyRatio) {
				return tryPropose(event, ctx, midRun, applySafe);
			}
			return undefined;
		} catch (error) {
			runtime.onApplyError();
			return undefined;
		}
	};

	const onBeforeCompact = async (event: {
		reason: "manual" | "threshold" | "overflow";
		customInstructions?: string;
		signal?: AbortSignal;
		willRetry?: boolean;
	}, ctx: ExtensionContext): Promise<{ compaction?: unknown } | undefined> => {
		if (resolvedMode === "off") return undefined;
		try {
			if (event.reason === "overflow") nativeRecoveryPending = true;
			if (resolvedMode === "shadow") return undefined;
			fallbackMetric = { attemptId: randomUUID(), at: Date.now(), reason: event.reason };
			measure(ctx, "fallback-start", { attemptId: fallbackMetric.attemptId, reason: event.reason });
			const { tn } = thresholdOf(ctx);
			if (tn === null) return undefined;
			const deadlineAt = Date.now() + settings.fallbackDeadlineMs;
			const hasComputing = runtime.state.phase === "computing" && inFlight !== null;
			type Gates = { gates: boolean; fit: boolean; estimate: number; composed?: ReturnType<typeof composeFinalSummary> };
			const gatesForSnapshot = (): Gates => {
				const snapshot = runtime.snapshot;
				if (!snapshot) return { gates: false, fit: false, estimate: Number.POSITIVE_INFINITY };
				const composed = composeFinalSummary(ctx, snapshot.cut, snapshot.summary);
				if (!composed.ok) return { gates: false, fit: false, estimate: Number.POSITIVE_INFINITY };
				const projection = ctx.sessionManager.buildSessionProjection();
				const entries = projection.entries as ProjectedEntry[];
				const kept = entries.slice(snapshot.cut.firstKeptEntryIndex).flatMap((entry) => entry.messages);
				const estimate = estimatePost({
					summary: composed.summary,
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
					applySafe: true,
					estimatePostTokens: estimate.total,
					hardFitLimit: Number.POSITIVE_INFINITY,
					efficiencyLimit: undefined,
					degraded: runtime.degraded,
					signalAborted: event.signal?.aborted ?? false,
					sameBoundaryEntries: [],
				});
				return {
					gates: prechecks.action !== "discard" || prechecks.reason === "v8a-hard-fit",
					fit: estimate.total <= hardFitLimitFor(event.reason, settings, tn),
					estimate: estimate.total,
					composed,
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

			if (decision.action === "supply-snapshot" && runtime.snapshot) {
				const snapshot = runtime.snapshot;
				const composed = initial.composed;
				if (!composed || !composed.ok) {
					runtime.snapshot = null;
					runtime.onDiscarded("v6-summary-invalid", { reason: composed && !composed.ok ? composed.reason : "compose-miss" });
					return undefined;
				}
				const files = fileListsOf(composed.summary);
				const supply = buildSupplyCompaction({
					snapshot,
					summary: composed.summary,
					tokensBefore: pressureOf(ctx) ?? snapshot.tnAtSnapshot,
					readFiles: files.readFiles,
					modifiedFiles: files.modifiedFiles,
					proposalId: randomUUID(),
				});
				runtime.snapshot = null;
				runtime.onServed();
				return supply;
			}
			if (decision.action === "native") return undefined;

			if (decision.action === "wait-for-ready" && inFlight) {
				const signal = event.signal;
				let timerHandle: ReturnType<typeof setTimeout> | undefined;
				let abortListener: (() => void) | undefined;
				const timer = new Promise<undefined>((resolveTimer) => {
					const remaining = Math.max(0, deadlineAt - Date.now());
					timerHandle = setTimeout(() => resolveTimer(undefined), remaining);
					timerHandle.unref?.();
				});
				const aborted = new Promise<undefined>((resolveAbort) => {
					if (signal?.aborted) return resolveAbort(undefined);
					abortListener = () => resolveAbort(undefined);
					signal?.addEventListener("abort", abortListener, { once: true });
				});
				await Promise.race([inFlight.promise.then(() => "done" as const), timer, aborted]);
				if (timerHandle !== undefined) clearTimeout(timerHandle);
				if (abortListener) signal?.removeEventListener("abort", abortListener);
				if (signal?.aborted || Date.now() >= deadlineAt) {
					runtime.onFellthrough(signal?.aborted ? "aborted" : "deadline");
					abortInFlight();
					runtime.onSessionReset();
					return undefined;
				}
				const afterWait = gatesForSnapshot();
				if (runtime.state.phase === "ready" && afterWait.gates && afterWait.fit && runtime.snapshot) {
					const snapshot = runtime.snapshot;
					const composed = afterWait.composed;
					if (!composed || !composed.ok) {
						runtime.snapshot = null;
						runtime.onDiscarded("v6-summary-invalid", { reason: composed && !composed.ok ? composed.reason : "compose-miss" });
						return undefined;
					}
					const files = fileListsOf(composed.summary);
					const supply = buildSupplyCompaction({
						snapshot,
						summary: composed.summary,
						tokensBefore: pressureOf(ctx) ?? snapshot.tnAtSnapshot,
						readFiles: files.readFiles,
						modifiedFiles: files.modifiedFiles,
						proposalId: randomUUID(),
					});
					runtime.snapshot = null;
					runtime.onServed();
					return supply;
				}
				return undefined;
			}

			if (decision.action === "regenerate" && Date.now() < deadlineAt) {
				const outcome = await regenerateNow(ctx, tn, deadlineAt, event.reason, event.signal);
				if (outcome) return outcome;
			}
			return undefined;
		} catch {
			return undefined;
		}
	};

	const regenerateNow = async (ctx: ExtensionContext, tn: number, deadlineAt: number, reason: "manual" | "threshold" | "overflow", signal?: AbortSignal): Promise<{ compaction?: unknown } | undefined> => {
		const controller = new AbortController();
		const generation = runtime.state.generation;
		try {
			const projection = ctx.sessionManager.buildSessionProjection();
			const snapshotPathIds = ctx.sessionManager.getBranch().map((entry) => (entry as { id?: string }).id ?? "");
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
			let closedIds: string[] | undefined;
			try {
				const region = compressedRegionOf(projection.entries as ProjectedEntry[], cut.cut.firstKeptEntryIndex);
				const ledger = assembleLedger({ region, providers: ledgerProviders(ctx, region), settings });
				if (!ledger.selfCheck.ok) {
					runtime.onFellthrough(ledger.selfCheck.missing.includes("ledger-over-budget") ? "ledger-over-budget" : "ledger-self-check-failed");
					return undefined;
				}
				closedIds = ledger.closedIds;
			} catch {
				closedIds = undefined;
			}
			let regenTimer: ReturnType<typeof setTimeout> | undefined;
			const regenAbort = (): void => controller.abort();
			const deadlinePromise = new Promise<undefined>((resolveTimer) => {
				regenTimer = setTimeout(() => {
					controller.abort();
					resolveTimer(undefined);
				}, Math.max(0, deadlineAt - Date.now()));
				regenTimer.unref?.();
			});
			signal?.addEventListener("abort", regenAbort, { once: true });
			const outcomePromise = runSummarizer({
				preparation,
				model: ctx.model!,
				closedIds,
				transport: { call: (model, context, options) => ctx.modelRegistry.complete(model, context as never, options as never) as never },
				summaryThinking: settings.summaryThinking,
				summaryMaxTokens: settings.summaryMaxTokens,
				thresholds: { minNarrativeChars: settings.minNarrativeChars, minPrefixChars: settings.minPrefixChars, maxSummaryChars: settings.maxSummaryChars },
				signal: controller.signal,
			});
			const outcome = await Promise.race([outcomePromise, deadlinePromise]);
			if (regenTimer !== undefined) clearTimeout(regenTimer);
			signal?.removeEventListener("abort", regenAbort);
			if (Date.now() >= deadlineAt) {
				runtime.onFellthrough("deadline");
				return undefined;
			}
			if (!outcome || !outcome.ok) return undefined;
			const branchNow = ctx.sessionManager.getBranch();
			const baselineHolds = snapshotPathIds.every((id, i) => (branchNow[i] as { id?: string } | undefined)?.id === id);
			if (!baselineHolds) {
				runtime.onFellthrough("v1-branch-prefix");
				return undefined;
			}
			const cutAt = snapshotPathIds.indexOf(cut.cut.firstKeptEntryId);
			const compressedIds = new Set(cutAt >= 0 ? snapshotPathIds.slice(0, cutAt) : []);
			const invalidated = branchNow.slice(snapshotPathIds.length).some((entry) => {
				const row = entry as { type?: string; targetId?: unknown };
				if (row.type === "compaction") return true;
				return row.type === "context_edit" && typeof row.targetId === "string" && compressedIds.has(row.targetId);
			});
			if (invalidated) {
				runtime.onFellthrough("v4-conflict-edit");
				return undefined;
			}
			const composedRegen = composeFinalSummary(ctx, cut.cut, outcome.summary);
			if (!composedRegen.ok) {
				runtime.onFellthrough(composedRegen.reason);
				return undefined;
			}
			const kept = (projection.entries as ProjectedEntry[]).slice(cut.cut.firstKeptEntryIndex).flatMap((entry) => entry.messages);
			const estimate = estimatePost({
				summary: composedRegen.summary,
				keptMessages: kept,
				currentProjectionMessages: projection.messages,
				ctxTokensUsage: pressureOf(ctx),
				contextWindow: (ctx.model as { contextWindow?: number } | undefined)?.contextWindow ?? 128_000,
				unknownOverheadTokens: settings.unknownOverheadTokens,
			});
			if (estimate.total > hardFitLimitFor(reason, settings, tn)) return undefined;
			void generation;
			const files = fileListsOf(composedRegen.summary);
			const snapshotLike: PrecomputedSnapshot = {
				generation,
				cut: cut.cut,
				branchPathIds: snapshotPathIds,
				summary: outcome.summary,
				summaryTokens: Math.ceil(outcome.summary.length / 4),
				tnAtSnapshot: tn,
				validated: true,
			};
			return buildSupplyCompaction({
				snapshot: snapshotLike,
				summary: composedRegen.summary,
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

	pi.on("session_start" as never, ((event: unknown, ctx: ExtensionContext) => {
		try {
			reloadSettings(ctx);
			abortInFlight();
			runtime.onSessionReset();
			nativeRecoveryPending = false;
			sessionTreeSinceProposal = false;
			pendingProposal = null;
			metricCycleId = undefined;
			fallbackMetric = undefined;
		} catch {
		}
	}) as never);

	pi.on("session_shutdown" as never, (() => {
		try {
			abortInFlight();
			runtime.onSessionReset();
			pendingProposal = null;
			metricCycleId = undefined;
			fallbackMetric = undefined;
		} catch {
		}
	}) as never);

	pi.on("session_tree" as never, (() => {
		try {
			sessionTreeSinceProposal = true;
			abortInFlight();
			runtime.onSessionReset();
			pendingProposal = null;
			metricCycleId = undefined;
			fallbackMetric = undefined;
		} catch {
		}
	}) as never);

	for (const name of RECONCILE_EVENTS) {
		pi.on(name as never, ((_event: unknown, ctx: ExtensionContext) => {
			try {
				if (name === "agent_settled" && resolvedMode !== "off") nativeRecoveryPending = false;
				reconcileIfPending(ctx);
			} catch {
			}
		}) as never);
	}

	pi.on("turn_end" as never, ((event: { entries?: unknown[]; message?: { stopReason?: string }; outcome?: string }, ctx: ExtensionContext) => {
		return onApplyPoint(event, ctx, true);
	}) as never);

	pi.on("agent_before_settle" as never, ((event: { entries?: unknown[]; message?: { stopReason?: string }; outcome?: string }, ctx: ExtensionContext) => {
		try {
			reconcileIfPending(ctx);
		} catch {
		}
		return onApplyPoint(event, ctx, false);
	}) as never);

	pi.on("session_before_compact" as never, ((event: Parameters<typeof onBeforeCompact>[0], ctx: ExtensionContext) => {
		try {
			reconcileIfPending(ctx);
		} catch {
		}
		return onBeforeCompact(event, ctx);
	}) as never);

	pi.on("session_compact_failed" as never, ((_event: unknown, ctx: ExtensionContext) => {
		try {
			if (resolvedMode === "off") return;
			nativeRecoveryPending = true;
			if (fallbackMetric) {
				measure(ctx, "fallback-end", { attemptId: fallbackMetric.attemptId, reason: fallbackMetric.reason, elapsedMs: Date.now() - fallbackMetric.at, failed: true });
				fallbackMetric = undefined;
			}
		} catch {
		}
	}) as never);

	pi.on("session_compact" as never, ((event: { fromExtension?: boolean; summary?: string; entry?: { summary?: string } }, ctx: ExtensionContext) => {
		try {
			if (resolvedMode === "off") return;
			if (fallbackMetric) {
				measure(ctx, "fallback-end", {
					attemptId: fallbackMetric.attemptId, reason: fallbackMetric.reason,
					elapsedMs: Date.now() - fallbackMetric.at, fromExtension: event.fromExtension ?? false,
				});
				fallbackMetric = undefined;
			}
			if (event.fromExtension) return;
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
					}
				}
			}
		} catch {
		}
	}) as never);

	pi.registerCommand("smart-compact" as never, {
		description: "Smart Compaction controller: bare = status; 'mode <off|shadow|on>'",
		getArgumentCompletions: (prefix: string) => {
			const value = prefix.trimStart();
			const tokens = value.split(/\s+/).filter(Boolean);
			const trailing = /\s$/.test(value);
			if (tokens.length === 0 || (tokens.length === 1 && !trailing)) {
				const first = tokens[0] ?? "";
				return ["status", "mode"].filter((t) => t.startsWith(first)).map((t) => ({ value: t, label: t }));
			}
			if (tokens[0] === "mode" && tokens.length <= 2 && (tokens.length === 1 || !trailing)) {
				const second = trailing ? "" : tokens[1] ?? "";
				return ["off", "shadow", "on"]
					.filter((t) => t.startsWith(second))
					.map((t) => ({ value: `mode ${t}`, label: t }));
			}
			return null;
		},
		handler: async (args: string, ctx: ExtensionContext) => {
			try {
				const sub = args.trim().split(/\s+/)[0] ?? "";
				if (sub === "mode") {
					const value = args.trim().split(/\s+/)[1] ?? "";
					if (value !== "off" && value !== "shadow" && value !== "on") {
						notifyUser(ctx, "usage: /smart-compact mode <off|shadow|on>");
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
