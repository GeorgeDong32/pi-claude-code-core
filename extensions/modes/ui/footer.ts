/**
 * Modes footer + status slot (DECOUPLE-PLAN DC3, moved verbatim from
 * index.ts — the ccTui yield gating stays exactly as-is until DC5).
 */
import { homedir } from "node:os";
import { visibleWidth, truncateToWidth } from "@earendil-works/pi-tui";
import { coreBus } from "../../bus.ts";
import { MODE_META } from "./meta.ts";
import type { PermissionMode } from "../mode-prompt.ts";

/** Render-time footer inputs (passed as a getter so renders stay fresh). */
export interface ModesFooterState {
  mode: PermissionMode;
  gitBranch: string;
  activeProfile: string | null | undefined;
  thinkingLevel: string | undefined;
}

interface FooterCtx {
  hasUI: boolean;
  cwd: string;
  getContextUsage?: () => { tokens?: number | null; percent?: number | null; contextWindow: number } | undefined;
  model?: { id?: string; name?: string } | null;
  ui: {
    setFooter(factory: unknown): void;
    setStatus(key: string, value: string | undefined): void;
  };
}

export function shortenPath(p: string): string {
  const home = homedir();
  return p && p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

export function clearModesStatus(ctx: FooterCtx): void {
  if (!ctx.hasUI) return;
  ctx.ui.setStatus("modes", undefined);
}

export function installModesFooter(ctx: FooterCtx, state: () => ModesFooterState): void {
  if (!ctx.hasUI) return;
  // Integration: when the CC-TUI replica extension is active it owns the
  // footer slot (mode/hints row + statusline); installing ours would evict
  // it — same handshake as the working-message yield in index.ts. Load
  // order decides the last setFooter writer, so without this yield the
  // winner flips with package order. (DC5 moves the reader to the fallback
  // adapter; the logic module stops seeing UI presence.)
  const g = globalThis as Record<string, unknown>;
  const ccTuiActive = (g.__piCcTui as { active?: boolean } | undefined)?.active === true || g.__ccTuiActive === true;
  if (ccTuiActive) return;
  ctx.ui.setFooter((_tui: any, theme: any) => ({
    render(width: number): string[] {
      const s = state();
      const m = MODE_META[s.mode];
      const cwd = shortenPath(ctx.cwd);
      const cwdText = s.gitBranch ? `${cwd} (${s.gitBranch})` : cwd;

      const ctxUsage = ctx.getContextUsage?.();
      let ctxStr = "";
      if (ctxUsage && ctxUsage.tokens != null && ctxUsage.percent != null) {
        const fmtK = (n: number) => n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : `${Math.round(n / 1000)}k`;
        ctxStr = `${fmtK(ctxUsage.tokens)}/${fmtK(ctxUsage.contextWindow)} ${ctxUsage.percent.toFixed(1)}%`;
      }

      const md = ctx.model;
      let modelStr = "";
      if (md) {
        modelStr = md.name ? String(md.name) : String(md.id ?? "");
        if (s.thinkingLevel) modelStr += ` • ${s.thinkingLevel}`;
      }
      if (s.activeProfile) {
        modelStr = `profile:${s.activeProfile} · ${modelStr}`;
      }

      const cwdW = visibleWidth(cwdText);
      const ctxW = visibleWidth(ctxStr);
      const modelW = visibleWidth(modelStr);
      const modeText = `${m.icon} ${m.label} (shift+tab)`;
      const modeW = visibleWidth(modeText);

      // Wide: line1 = cwd(L) + context(centered) + model(R), line2 = mode
      if (cwdW + ctxW + modelW + 4 <= width) {
        const leftGap = Math.max(2, Math.floor((width - ctxW) / 2) - cwdW);
        const rightGap = width - cwdW - leftGap - ctxW - modelW;
        if (rightGap >= 12) {
          const line1 =
            theme.fg("muted", cwdText) +
            " ".repeat(leftGap) +
            theme.fg("dim", ctxStr) +
            " ".repeat(rightGap) +
            theme.fg("dim", modelStr);
          const line2 = theme.fg(m.role, modeText);
          return withDisplayFooterLines(theme, width, [line1, line2]);
        }
      }

      // Narrow: line1 = cwd(L) + context(R), line2 = mode(L) + model(R)
      let cwdDisp = cwdText;
      let cwdDispW = cwdW;
      if (cwdW + ctxW + 1 > width) {
        cwdDisp = truncateToWidth(cwdText, Math.max(4, width - ctxW - 1));
        cwdDispW = visibleWidth(cwdDisp);
      }
      const gap1 = Math.max(1, width - cwdDispW - ctxW);
      const line1 =
        theme.fg("muted", cwdDisp) +
        " ".repeat(gap1) +
        theme.fg("dim", ctxStr);

      let modeDisp = modeText;
      let modeDispW = modeW;
      let modelDisp = modelStr;
      let modelDispW = modelW;
      if (modeW + modelW + 1 > width) {
        modelDisp = truncateToWidth(modelStr, Math.max(4, width - modeW - 1));
        modelDispW = visibleWidth(modelDisp);
      }
      const gap2 = Math.max(1, width - modeDispW - modelDispW);
      const line2 =
        theme.fg(m.role, modeDisp) +
        " ".repeat(gap2) +
        theme.fg("dim", modelDisp);

      return withDisplayFooterLines(theme, width, [line1, line2]);
    },
    invalidate() {},
  }));
}

/** XPKG-07 (SPEC 2026-10-07 P1-1): while the core modes footer holds the
 *  slot it also renders the shared `display.footer` channel (economy degrade
 *  lines etc.) — dim, width-clamped, after the modes lines. When a cctui is
 *  live this footer is never installed (cc-footer renders the channel
 *  instead); after an explicit off the host stock footer shows nothing from
 *  this channel by design. */
function withDisplayFooterLines(
  theme: { fg(role: string, s: string): string },
  width: number,
  lines: string[],
): string[] {
  for (const extra of coreBus().snapshot().display?.footer ?? []) {
    const text = visibleWidth(extra) > width ? truncateToWidth(extra, width) : extra;
    lines.push(theme.fg("dim", text));
  }
  return lines;
}
