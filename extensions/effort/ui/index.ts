import type { Theme } from "@earendil-works/pi-coding-agent";
import type { EffortModel } from "../effort.js";
import { createEffortPickerComponent, type EffortPickerResult } from "../effort-picker.js";
import { showComponentOverlay, type CustomOverlayContext } from "../../../lib/overlay.js";
import { notify as notifyOnce, type NotificationLevel } from "../../ui/notify.js";

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

interface EffortHost {
	hasUI: boolean;
	model: EffortModel | null | undefined;
	setStatus(key: string, value: string | undefined): void;
	setWorkingMessage(message: string | undefined): void;
	select?(title: string, options: readonly string[]): Promise<string | undefined>;
	overlayCtx?: CustomOverlayContext;
}

function toHost(ctx: EffortCtxLike): EffortHost {
	return {
		hasUI: ctx.hasUI,
		model: (ctx.model ?? null) as EffortModel | null,
		setStatus: (k, v) => ctx.ui.setStatus(k, v),
		setWorkingMessage: (m) => ctx.ui.setWorkingMessage(m),
		select: ctx.ui.select ? (t, o) => ctx.ui.select!(t, o) : undefined,
		overlayCtx: ctx.hasUI ? (ctx as unknown as CustomOverlayContext) : undefined,
	};
}

export type NotifyLevel = "info" | "warning" | "error";

export type EffortPickResult =
	| EffortPickerResult
	| { action: "select"; level: string }
	| null;

export interface EffortUi {
	sync(ctx: EffortCtxLike, current: string, fastMode: boolean, updateWorkingMessage: boolean): void;
	notify(ctx: EffortCtxLike, message: string, level: NotifyLevel): void;
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
			notifyOnce(ctx, message, level);
		},
		async pickEffort(ctx, levels, currentLevel) {
			const host = toHost(ctx);
			if (!host.select) return null;
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
