
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { CoreSnapshot } from "../bus.ts";
import { coreBus } from "../bus.ts";
import type { PmCapability } from "./index.ts";
import { createWorkingStats, type WorkingStatsCache, type WorkingStatsHost } from "./working-stats.ts";
import { createFallbackAdapter } from "../ui/fallback.ts";
import { formatCount } from "./ui/format.ts";

function sanitizeUsageNumbers(
	stats: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number },
	tps: number,
	usage: { tokens: number | null; contextWindow: number; percent: number | null } | undefined,
): NonNullable<CoreSnapshot["modes"]["usage"]> | undefined {
	for (const n of [stats.input, stats.output, stats.cacheRead, stats.cacheWrite, stats.cost]) {
		if (!Number.isFinite(n) || n < 0) return undefined;
	}
	const out: NonNullable<CoreSnapshot["modes"]["usage"]> = {
		input: stats.input,
		output: stats.output,
		cacheRead: stats.cacheRead,
		cacheWrite: stats.cacheWrite,
		cost: stats.cost,
	};
	if (Number.isFinite(tps) && tps > 0) out.tps = tps;
	if (usage) {
		if (usage.tokens != null && Number.isFinite(usage.tokens) && usage.tokens >= 0) out.ctxTokens = usage.tokens;
		if (usage.percent != null && Number.isFinite(usage.percent) && usage.percent >= 0) out.ctxPercent = usage.percent;
		if (Number.isFinite(usage.contextWindow) && usage.contextWindow > 0) out.contextWindow = usage.contextWindow;
	}
	return out;
}

export interface StatsPresenterDeps {
  getFallbackAdapter(): ReturnType<typeof createFallbackAdapter>;
  publishCapability(patch: Partial<PmCapability>): void;
}

export function createStatsPresenter(deps: StatsPresenterDeps) {
  let lastTps = 0;
  let streamStart = 0;
  let outputAtStart = 0;

  // Streaming chunks arrive while the branch is frozen (pi appends entries
  // on message_end): per-chunk work is O(new entries), a moved prefix
  // (navigate/fork/switch) forces a full recompute.
  const workingStats = createWorkingStats();

  function statsHost(ctx: ExtensionContext): WorkingStatsHost {
    return { sessionManager: ctx.sessionManager, getContextUsage: ctx.getContextUsage };
  }

  function workingStatsEntry(ctx: ExtensionContext, opts?: { forceUsage?: boolean }): {
    stats: ReturnType<WorkingStatsCache["snapshot"]>["stats"];
    usage: ReturnType<WorkingStatsCache["snapshot"]>["usage"];
    tps: number;
  } {
    const entry = workingStats.snapshot(statsHost(ctx), opts);
    return { stats: entry.stats, usage: entry.usage, tps: lastTps };
  }

  function workingStatsParts(entry: { stats: ReturnType<WorkingStatsCache["snapshot"]>["stats"]; usage: ReturnType<WorkingStatsCache["snapshot"]>["usage"]; tps: number }): string[] {
    const s = entry.stats;
    const parts = [`↑${formatCount(s.input)}`, `↓${formatCount(s.output)}`];
    if (s.cacheRead) parts.push(`R${formatCount(s.cacheRead)}`);
    if (entry.tps > 0) parts.push(`⚡${Math.round(entry.tps)} tok/s`);
    parts.push(`$${s.cost.toFixed(3)}`);
    const usage = entry.usage;
    if (usage && usage.percent != null) {
      parts.push(`${Math.round(usage.percent)}% ctx`);
    }
    return parts;
  }

  function refreshWorkingMessage(ctx: ExtensionContext, opts?: { forceUsage?: boolean }): void {
    if (!ctx.hasUI) return;
    const entry = workingStatsEntry(ctx, opts);
    const stats = workingStatsParts(entry).join(" · ");
    deps.publishCapability({ workingStats: stats, usage: sanitizeUsageNumbers(entry.stats, entry.tps, entry.usage) });
    deps.getFallbackAdapter().onSnapshot(coreBus().snapshot());
  }


  function onTurnStart(ctx: ExtensionContext): void {
    streamStart = Date.now();
    outputAtStart = workingStats.snapshot(statsHost(ctx), { force: true }).stats.output;
    refreshWorkingMessage(ctx);
  }

  function onBeforeProviderRequest(ctx: ExtensionContext): void {
    refreshWorkingMessage(ctx, { forceUsage: true });
  }

  function onTurnEndStats(ctx: ExtensionContext): void {
    const stats = workingStats.snapshot(statsHost(ctx), { force: true }).stats;
    const elapsed = Math.max((Date.now() - streamStart) / 1000, 0.001);
    const delta = stats.output - outputAtStart;
    if (delta > 0) lastTps = delta / elapsed;
    refreshWorkingMessage(ctx);
  }

  return {
    workingStatsEntry,
    workingStatsParts,
    refreshWorkingMessage,
    onTurnStart,
    onBeforeProviderRequest,
    onTurnEndStats,
    markDirty: () => workingStats.markDirty(),
    onModelChange: () => workingStats.onModelChange(),
    invalidate: () => workingStats.invalidate(),
    reset: () => workingStats.reset(),
  };
}
