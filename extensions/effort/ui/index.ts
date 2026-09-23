/**
 * Effort presentation wrapper (DECOUPLE-PLAN DC2).
 *
 * Owns every ctx.ui touchpoint for the effort module: status slots, the
 * working-message loader line, notifications, and the effort picker
 * overlay (with the non-TUI select fallback). Business code in
 * extensions/effort/index.ts calls this small interface and stays fakeable.
 *
 * Until DC3 swaps the internals, notify() forwards straight to
 * ctx.ui.notify; the signature is already the notification tail-queue
 * shape (msg + level) so the swap is an implementation change only.
 */
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { EffortModel } from "../effort.js";
import { createEffortPickerComponent, type EffortPickerResult } from "../effort-picker.js";
import { showComponentOverlay, type CustomOverlayContext } from "../../../lib/overlay.js";
import { publishNotification, type NotificationLevel } from "../../ui/notify.js";

/**
 * Minimum context shape the wrapper touches (duck-typed so unit tests can
 * pass a plain object — no pi runtime needed).
 */
export interface EffortCtxLike {
	hasUI: boolean;
	model: unknown;
	ui: {
		setStatus(key: string, value: string | undefined): void;
		setWorkingMessage(message: string | undefined): void;
		notify(message: string, level: "info" | "warning" | "error"): void;
		select?(title: string, options: readonly string[]): Promise<string | undefined>;
	};
}

/** Internal fan-out surface (kept private; fakes build EffortCtxLike). */
interface EffortHost {
	hasUI: boolean;
	model: EffortModel | null | undefined;
	setStatus(key: string, value: string | undefined): void;
	setWorkingMessage(message: string | undefined): void;
	notify(message: string, level: "info" | "warning" | "error"): void;
	select?(title: string, options: readonly string[]): Promise<string | undefined>;
	overlayCtx?: CustomOverlayContext;
}

function toHost(ctx: EffortCtxLike): EffortHost {
	return {
		hasUI: ctx.hasUI,
		model: (ctx.model ?? null) as EffortModel | null,
		setStatus: (k, v) => ctx.ui.setStatus(k, v),
		setWorkingMessage: (m) => ctx.ui.setWorkingMessage(m),
		notify: (m, l) => ctx.ui.notify(m, l),
		select: ctx.ui.select ? (t, o) => ctx.ui.select!(t, o) : undefined,
		overlayCtx: ctx.hasUI ? (ctx as unknown as CustomOverlayContext) : undefined,
	};
}

export type NotifyLevel = "info" | "warning" | "error";

/** Picker outcome: overlay confirm, fallback select, or nothing. */
export type EffortPickResult =
	| EffortPickerResult
	| { action: "select"; level: string }
	| null;

export interface EffortUi {
	/** Status slots + loader line (was updateEffortUi). */
	sync(ctx: EffortCtxLike, current: string, fastMode: boolean, updateWorkingMessage: boolean): void;
	/** Notification passthrough; becomes a bus tail-queue publish at DC3. */
	notify(ctx: EffortCtxLike, message: string, level: NotifyLevel): void;
	/** TUI overlay picker; non-TUI falls back to select. Null = cancelled. */
	pickEffort(
		ctx: EffortCtxLike,
		levels: readonly string[],
		currentLevel: string | undefined,
	): Promise<EffortPickResult>;
}

function isFastModelId(modelId: string): boolean {
	return modelId.startsWith("gpt-5");
}

export function createEffortUi(): EffortUi {
	return {
		sync(ctx, current, fastMode, updateWorkingMessage) {
			const host = toHost(ctx);
			// Clear older pi-effort aggregate status lines. Dedicated powerline
			// custom items read pi-effort-thinking / pi-effort-fast instead.
			host.setStatus("effort", undefined);
			host.setStatus("pi-effort-thinking", `think:${current}`);
			const fastApplicable =
				fastMode && typeof host.model?.id === "string" && isFastModelId(host.model.id);
			host.setStatus("pi-effort-fast", fastApplicable ? "fast" : undefined);
			if (updateWorkingMessage) {
				host.setWorkingMessage(current === "off" ? undefined : `Working (${current} effort)...`);
			}
		},
		notify(ctx, message, level) {
			// DC3: dual write — tail queue for future adapters + direct
			// forward until DC5 wires the adapters (screen behaviour unchanged).
			publishNotification(level, message);
			ctx.ui.notify(message, level);
		},
		async pickEffort(ctx, levels, currentLevel) {
			const host = toHost(ctx);
			if (!host.select) return null;
			// Non-TUI (RPC/print): plain select fallback.
			if (!host.overlayCtx) {
				const picked = await host.select("Effort", levels);
				if (picked && (levels as readonly string[]).includes(picked)) {
					return { action: "select", level: picked };
				}
				return null;
			}
			const result = await showComponentOverlay<EffortPickerResult>(host.overlayCtx, {
				component: (_tui, theme, _kb, done) =>
					createEffortPickerComponent({
						levels: levels as string[],
						currentLevel,
						theme: theme as Theme | undefined,
						done,
					}),
				overlayOptions: {
					// Pi's main region can be as narrow as ~50 columns when a
					// side panel is open; a fixed minWidth beyond that keeps
					// the overlay from being squeezed into the main region.
					width: 78,
					minWidth: 72,
					maxHeight: "40%",
					anchor: "center",
				},
			});
			return result;
		},
	};
}
