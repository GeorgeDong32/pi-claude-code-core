/**
 * Mode presentation material (DECOUPLE-PLAN DC1/DC3).
 *
 * Single source for icon/label/role per mode — published on the bus
 * snapshot's modes channel and consumed by every UI (cctui, fallback
 * footer). Moved here from index.ts at DC3: presentation material lives
 * with the presentation layer.
 */
import type { PermissionMode } from "../mode-prompt.ts";

export const MODE_META: Record<PermissionMode, { icon: string; label: string; role: string }> = {
  ask: { icon: "●", label: "Ask", role: "muted" },
  plan: { icon: "⏸", label: "Plan", role: "accent" },
  auto: { icon: "▶", label: "Auto", role: "warning" },
  bypass: { icon: "⚡", label: "Bypass", role: "error" },
};

/** DC1: fresh copy for the bus snapshot — deepFreeze must not capture the module constant. */
export function modeMetaData(): Record<PermissionMode, { icon: string; label: string; role: string }> {
  return {
    ask: { ...MODE_META.ask! },
    plan: { ...MODE_META.plan! },
    auto: { ...MODE_META.auto! },
    bypass: { ...MODE_META.bypass! },
  };
}
