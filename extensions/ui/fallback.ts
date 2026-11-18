import { coreBus, type CoreSnapshot } from "../bus.js";
import type { UiAdapter } from "./base.ts";
import type { NotificationLevel } from "./notify.ts";

export interface FallbackHost {
	hasUI: boolean;
	setWorkingMessage(message?: string): void;
	notify?(message: string, level: NotificationLevel): void;
	theme: { fg(role: string, s: string): string };
}

interface PresenceKey {
	active?: boolean;
}

function ccTuiLive(): boolean {
	const g = globalThis as Record<string, unknown>;
	return (g.__piCcTui as PresenceKey | undefined)?.active === true || g.__ccTuiActive === true;
}

export function createFallbackAdapter(host: FallbackHost): UiAdapter {
	let lastStats: string | null = null;
	let lastSeenNotificationId = 0;
	let unsubscribe: (() => void) | null = null;

	function apply(snapshot: CoreSnapshot): void {
		if (!host.hasUI) return;
		const queue = snapshot.notifications;
		if (queue && queue.length > 0 && !ccTuiLive()) {
			for (const item of queue) {
				if (item.id <= lastSeenNotificationId) continue;
				lastSeenNotificationId = item.id;
				host.notify?.(item.msg, item.level);
			}
		} else if (queue && queue.length > 0) {
			lastSeenNotificationId = queue[queue.length - 1]!.id;
		}
		const stats = snapshot.modes.workingStats;
		if (stats === lastStats) return;
		lastStats = stats;
		if (stats === null) {
			host.setWorkingMessage(undefined);
			return;
		}
		if (ccTuiLive()) return;
		host.setWorkingMessage(host.theme.fg("dim", `Working… (${stats})`));
	}

	return {
		startup() {
			let register = coreBus().snapshot().onChange;
			if (!register) {
				coreBus().publish({});
				register = coreBus().snapshot().onChange;
			}
			if (register) unsubscribe = register(() => apply(coreBus().snapshot()));
		},
		shutdown() {
			unsubscribe?.();
			unsubscribe = null;
			lastStats = null;
			lastSeenNotificationId = 0;
			if (host.hasUI) host.setWorkingMessage(undefined);
		},
		onSnapshot: apply,
	};
}
