/**
 * Goal presentation wiring (DECOUPLE-PLAN DC4b part-3, first cut).
 *
 * The UI half of goal.ts's update path: the above-editor widget
 * registration, the goal status slot, the 1s status/widget refresh timer,
 * and the Esc-to-pause terminal subscription. Every piece of closed-over
 * business state (goalsById / focusedGoalId / display goal) enters as a
 * getter — this module holds only presentation state (widget handle,
 * timers, subscription), so the state machine stays fakeable and the
 * goal-statemachine tests keep passing unchanged across the move.
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";
import { footerStatus } from "./goal-core.ts";
import { GoalWidgetComponent } from "./widgets/goal-widget.ts";
import type { GoalRecord } from "./goal-record.ts";

const GOAL_WIDGET_KEY = "goal";
const STATUS_REFRESH_MS = 1000;

export interface GoalUiDeps {
	/** Focused goal for display (null = unfocused / none). */
	getDisplayGoal: () => GoalRecord | null;
	/** Open goal count (unfocused line + status suffix). */
	getOpenGoalCount: () => number;
	/** Open goals other than the focused one (status suffix "(+N open)"). */
	getOtherOpenGoalCount: () => number;
	/** Refresh-timer gate: a focused, active goal. */
	isGoalActive: () => boolean;
	/** Esc gate: active goal with autoContinue armed. */
	shouldPauseOnEscape: () => boolean;
	/** Esc gate #2: only claim Escape while the agent is IDLE — while the
	 * agent is busy, Escape is the user's INTERRUPT and must pass through
	 * to the TUI untouched (the raw-input listener must never steal it). */
	isAgentIdle: (ctx: ExtensionContext) => boolean;
	/** Pause the running goal (Esc handler, dispatched async). */
	pauseActiveGoal: (ctx: ExtensionContext) => void;
}

export interface GoalUi {
	/** Idempotent aboveEditor widget mount; re-renders when already mounted. */
	registerWidget(ctx: ExtensionContext): void;
	/**
	 * Unconditional re-mount (session_start). Above-editor widgets render in
	 * registration order, so remounting on every session start both restores
	 * the widget after a session invalidate wiped the TUI map and lands it
	 * before cc-status's microtask re-registration — keeping the goal block
	 * above the spinner row, which stays closest to the editor.
	 */
	remountWidget(ctx: ExtensionContext): void;
	/** Live-tick the mounted widget (duration/tokens). */
	updateWidget(): void;
	/** Tear the widget + status slot down. */
	clear(ctx: ExtensionContext): void;
	/** Start/stop the 1s status+widget refresh (gated on an active goal). */
	syncStatusRefresh(ctx: ExtensionContext): void;
	stopStatusRefresh(): void;
	/** Re-arm the Esc-to-pause subscription for this context. */
	syncTerminalInputPause(ctx: ExtensionContext): void;
	/** Full teardown (timers + subscription). */
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
			// Resident mount: with no goal the component renders zero lines,
			// so residency costs nothing visually; updateUI keeps this
			// idempotent path.
			if (!widgetRegistered) {
				mountWidget(ctx);
			} else {
				goalWidgetComponent?.update();
			}
		},
		remountWidget(ctx) {
			// Unconditional (session_start): same-key setWidget re-inserts at
			// the TUI map tail — this both restores the widget after a
			// session invalidate wiped the map and lands it before cc-status's
			// microtask re-registration, keeping the goal block above the
			// spinner row.
			mountWidget(ctx);
		},
		updateWidget() {
			goalWidgetComponent?.update();
		},
		clear(ctx) {
			// Status slot only — the widget stays resident (renders empty
			// without a goal) so its registration order is never lost.
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
				// Live-tick the above-editor widget so duration/tokens update.
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
				//  1. a BUSY agent means Escape = interrupt — never claim it;
				//  2. the pause itself dispatches on the microtask queue, wrapped
				//     in try/catch, so nothing here can disturb the input path.
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
