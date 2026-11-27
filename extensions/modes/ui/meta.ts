import type { PermissionMode } from "../mode-prompt.ts";

export const MODE_META: Record<PermissionMode, { icon: string; label: string; role: string }> = {
  ask: { icon: "●", label: "Ask", role: "muted" },
  plan: { icon: "⏸", label: "Plan", role: "accent" },
  auto: { icon: "▶", label: "Auto", role: "warning" },
  bypass: { icon: "⚡", label: "Bypass", role: "error" },
};

export function modeMetaData(): Record<PermissionMode, { icon: string; label: string; role: string }> {
  return {
    ask: { ...MODE_META.ask! },
    plan: { ...MODE_META.plan! },
    auto: { ...MODE_META.auto! },
    bypass: { ...MODE_META.bypass! },
  };
}
