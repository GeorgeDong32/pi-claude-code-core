/**
 * modes/stats-presenter.ts — [C4 batch 1] the working-stats presentation
 * slice, extracted verbatim from the extension factory (index.ts) so the
 * stats derivation + working-message refresh own their state in one module.
 *
 * Design (architecture review 2026-10-18, C4 — "stats presenter" domain):
 * - The module OWNS the streaming counters (lastTps / streamStart /
 *   outputAtStart) and the WorkingStatsCache instance; the extension
 *   assembly (index.ts) never touches them directly.
 * - Cross-domain dependencies arrive as the smallest possible injected
 *   seam: a fallback-adapter getter (the adapter's lifecycle belongs to
 *   the session lifecycle in index.ts) and the capability publish entry
 *   (publishCapability is the capability-channel glue, also in index.ts).
 * - Event REGISTRATION stays in index.ts (assembly concern); the presenter
 *   exposes the event BODIES (onTurnStart / onBeforeProviderRequest /
 *   onTurnEndStats / markDirty / onModelChange) so handlers there stay
 *   one-liners.
 *
 * Behavior is unchanged from the pre-extraction factory closures — the
 * move is verbatim plus explicit getter parameters (C4: pure relocation).
 * The type-only import of PmCapability from index.ts is a deliberate,
 * erased-at-runtime cycle (assembly owns the capability shape).
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { CoreSnapshot } from "../bus.ts";
import { coreBus } from "../bus.ts";
import type { PmCapability } from "./index.ts";
import { createWorkingStats, type WorkingStatsCache, type WorkingStatsHost } from "./working-stats.ts";
import { createFallbackAdapter } from "../ui/fallback.ts";
import { formatCount } from "./ui/format.ts";

/** Sanitized raw usage (P2-4 §4.1): finite non-negative only; a missing or
 * invalid REQUIRED cumulative field omits the whole object; optional ctx
 * fields are independently absent when unknown — never faked as 0. */
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

/** Stats presenter seam: everything the slice needs from the assembly. */
export interface StatsPresenterDeps {
  /** Live fallback adapter (owned + rebuilt by the session lifecycle). */
  getFallbackAdapter(): ReturnType<typeof createFallbackAdapter>;
  /** Capability-channel publish entry (glue lives in index.ts). */
  publishCapability(patch: Partial<PmCapability>): void;
}

export function createStatsPresenter(deps: StatsPresenterDeps) {
  let lastTps = 0;
  let streamStart = 0;
  let outputAtStart = 0;

  // Streaming chunks arrive while the branch is frozen (pi appends entries
  // on message_end), so per-chunk work is O(new entries), not O(session
  // length); a moved prefix (navigate/fork/switch) forces a full recompute
  // (plan A1, property-tested in branch-stats.test.ts).
  // AR1005-ST: the working-stats cache owns the snapshot + host-read
  // invalidation (cheap key: sessionManager instance + sessionId + leafId).
  const workingStats = createWorkingStats();

  /** AR1005-ST: ONE host shape for every snapshot call site — the usage
   * capability must be consistently present (a capability-less forced read
   * would mark usage fresh with no value and hide the ctx% line on later
   * cache hits). */
  function statsHost(ctx: ExtensionContext): WorkingStatsHost {
    return { sessionManager: ctx.sessionManager, getContextUsage: ctx.getContextUsage };
  }

  /** P2-4 §4.1: the ONE derivation both representations share — the raw
   * numbers (modes.usage) and the formatted string come from the same
   * working-stats snapshot call. */
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
    // DC5 flip: logic always publishes (snapshot is always-full); the
    // working-message slot write belongs to the fallback adapter, which
    // yields to a live CC-TUI at its own write point. With cctui active
    // its status row owns the working line — publishing alone is correct.
    const entry = workingStatsEntry(ctx, opts);
    const stats = workingStatsParts(entry).join(" · ");
    deps.publishCapability({ workingStats: stats, usage: sanitizeUsageNumbers(entry.stats, entry.tps, entry.usage) });
    deps.getFallbackAdapter().onSnapshot(coreBus().snapshot());
  }

  // ---- streaming event bodies (registered in index.ts) --------------------

  function onTurnStart(ctx: ExtensionContext): void {
    streamStart = Date.now();
    // AR1005-ST: ONE forced read feeds both the TPS baseline and the
    // display (the refresh that follows is cache-hot — zero extra reads).
    outputAtStart = workingStats.snapshot(statsHost(ctx), { force: true }).stats.output;
    refreshWorkingMessage(ctx);
  }

  function onBeforeProviderRequest(ctx: ExtensionContext): void {
    // ST: force ONE context-usage refresh; the branch sum reuses the cache
    // (no unconditional re-sum of an unchanged branch).
    refreshWorkingMessage(ctx, { forceUsage: true });
  }

  /** turn_end stats segment: ONE forced committed-final read feeds the TPS
   * math AND the display refresh (the old handler read the branch twice per
   * turn_end). The plan-step tracking that follows stays in index.ts. */
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
