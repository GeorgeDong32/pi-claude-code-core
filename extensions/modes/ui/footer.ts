import { homedir } from "node:os";
import { visibleWidth, truncateToWidth } from "@earendil-works/pi-tui";
import { coreBus } from "../../bus.ts";
import { MODE_META } from "./meta.ts";
import type { PermissionMode } from "../mode-prompt.ts";

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
