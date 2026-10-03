/** Plan todos widget (DECOUPLE-PLAN DC3, moved verbatim from index.ts). */
import type { TodoItem } from "../plan.ts";

interface WidgetCtx {
  hasUI: boolean;
  ui: {
    setWidget(key: string, value: unknown): void;
    theme: { fg(role: string, s: string): string; strikethrough(s: string): string };
  };
}

export const PLAN_WIDGET_KEY = "plan-todos";

export function clearPlanWidget(ctx: WidgetCtx): void {
  ctx.ui.setWidget(PLAN_WIDGET_KEY, undefined);
}

export function updatePlanWidget(ctx: WidgetCtx, todos: readonly TodoItem[]): void {
  if (!ctx.hasUI) return;
  if (!todos.length) {
    clearPlanWidget(ctx);
    return;
  }
  const lines = todos.map((t) =>
    t.completed
      ? ctx.ui.theme.fg("success", "☑ ") +
        ctx.ui.theme.fg("muted", ctx.ui.theme.strikethrough(t.text))
      : `${ctx.ui.theme.fg("muted", "☐ ")}${t.text}`,
  );
  ctx.ui.setWidget(PLAN_WIDGET_KEY, lines);
}
