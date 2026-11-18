import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";
import { footerStatus } from "./goal-core.ts";
import { GoalWidgetComponent } from "./widgets/goal-widget.ts";
import type { GoalRecord } from "./goal-record.ts";

const GOAL_WIDGET_KEY = "goal";
const STATUS_REFRESH_MS = 1000;

export interface GoalUiDeps {
	getDisplayGoal: () => GoalRecord | null;
	getOpenGoalCount: () => number;
	getOtherOpenGoalCount: () => number;
	isGoalActive: () => boolean;
	shouldPauseOnEscape: () => boolean;
	/** Esc gate #2: only claim Escape while the agent is IDLE — while the
	 * agent is busy, Escape is the user's INTERRUPT and must pass through
	 * to the TUI untouched (the raw-input listener must never steal it). */
	isAgentIdle: (ctx: ExtensionContext) => boolean;
	pauseActiveGoal: (ctx: ExtensionContext) => void;
}

export interface GoalUi {
	registerWidget(ctx: ExtensionContext): void;
	remountWidget(ctx: ExtensionContext): void;
	updateWidget(): void;
	clear(ctx: ExtensionContext): void;
	syncStatusRefresh(ctx: ExtensionContext): void;
	stopStatusRefresh(): void;
	syncTerminalInputPause(ctx: ExtensionContext): void;
	dispose(): void;
}

export function createGoalUi(deps: GoalUiDeps): GoalUi {
	let widgetRegistered = false;
	let goalWidgetComponent: GoalWidgetComponent | null = null;
	let statusRefreshTimer: ReturnType<typeof setInterval> | null = null;
	let statusRefreshCtx: ExtensionContext | null = null;
	let terminalInputUnsubscribe: (() => void) | null = null;

	function stopStatusRefresh(): void {
		if (statusRefreshTimer) {
			clearInterval(statusRefreshTimer);
			statusRefreshTimer = null;
		}
		statusRefreshCtx = null;
	}

	function mountWidget(ctx: ExtensionContext): void {
		ctx.ui.setWidget(
			GOAL_WIDGET_KEY,
			(tui, theme) => {
				goalWidgetComponent = new GoalWidgetComponent({
					tui,
					theme,
					getGoal: () => deps.getDisplayGoal(),
					getOpenGoalCount: () => deps.getOpenGoalCount(),
				});
				return goalWidgetComponent;
			},
			{ placement: "aboveEditor" },
		);
		widgetRegistered = true;
	}

	return {
		registerWidget(ctx) {
			if (!widgetRegistered) {
				mountWidget(ctx);
			} else {
				goalWidgetComponent?.update();
			}
		},
		remountWidget(ctx) {
			mountWidget(ctx);
		},
		updateWidget() {
			goalWidgetComponent?.update();
		},
		clear(ctx) {
			ctx.ui.setStatus(GOAL_WIDGET_KEY, undefined);
			goalWidgetComponent?.update();
		},
		syncStatusRefresh(ctx) {
			if (!ctx.hasUI || !deps.isGoalActive()) {
				stopStatusRefresh();
				return;
			}
			statusRefreshCtx = ctx;
			if (statusRefreshTimer) return;
			statusRefreshTimer = setInterval(() => {
				if (!statusRefreshCtx || !deps.isGoalActive()) {
					stopStatusRefresh();
					return;
				}
				const displayGoal = deps.getDisplayGoal();
				if (displayGoal) {
					const otherCount = deps.getOtherOpenGoalCount();
					statusRefreshCtx.ui.setStatus(
						GOAL_WIDGET_KEY,
						`${footerStatus(displayGoal)}${otherCount > 0 ? ` (+${otherCount} open)` : ""}`,
					);
				}
				goalWidgetComponent?.update();
			}, STATUS_REFRESH_MS);
			statusRefreshTimer.unref?.();
		},
		stopStatusRefresh,
		syncTerminalInputPause(ctx) {
			if (!ctx.hasUI) return;
			terminalInputUnsubscribe?.();
			terminalInputUnsubscribe = ctx.ui.onTerminalInput((data) => {
				// INTERRUPT SAFETY (fix): onTerminalInput is an OBSERVATION
				// channel. This handler must stay lightweight and always return
				// undefined — a synchronous pauseActiveGoal (disk writes, UI
				// updates, focus churn) inside the TUI's input-dispatch loop can
				// break the chain before the focused component sees Escape,
				// leaving the user with NO way to interrupt a stuck agent
				// (observed with a hung update_goal audit). Two guards:
				if (matchesKey(data, "escape") && deps.shouldPauseOnEscape() && deps.isAgentIdle(ctx)) {
					queueMicrotask(() => {
						try {
							deps.pauseActiveGoal(ctx);
						} catch {
							/* the pause must never break the input chain either */
						}
					});
				}
				return undefined;
			});
		},
		dispose() {
			stopStatusRefresh();
			terminalInputUnsubscribe?.();
			terminalInputUnsubscribe = null;
		},
	};
}
